"""Unit tests for the sidekick plugin's PDF rasterization helper.

Covers the ``SidekickAdapter._rasterize_pdf`` static method:

  * Happy path: a small valid PDF rasterizes to N PNG pages.
  * Page cap: ``SIDEKICK_PDF_MAX_PAGES`` is forwarded to pdftoppm via
    ``-l N`` (we assert the flag, not the runtime truncation, so we
    don't need a 60-page fixture).
  * Size cap: oversize PDF returns ``[]`` and logs a warning, never
    invokes pdftoppm.
  * Missing pdftoppm: ``FileNotFoundError`` → ``[]`` + clear-error log
    pointing at apt install poppler-utils.
  * Encrypted/corrupt PDF: pdftoppm exits non-zero → ``[]`` (helper
    drops gracefully, doesn't crash the request).
  * Timeout: ``subprocess.TimeoutExpired`` → ``[]``.

The helper is a ``@staticmethod`` so we can call it without spinning up
a SidekickAdapter (which would require aiohttp, the hermes patch, and
the gateway runtime). We import the plugin module via importlib so the
tests are independent of the hermes plugin loader.
"""

from __future__ import annotations

import importlib.util
import logging
import subprocess
import sys
import types
from pathlib import Path
from unittest import mock

import pytest


# ── plugin loader ─────────────────────────────────────────────────────
# Stub out the hermes-internal imports the plugin pulls in at top-level
# (`gateway.config`, `gateway.platforms.base`) so tests can run without
# a hermes-agent install on PYTHONPATH.

def _install_hermes_stubs() -> None:
    """Inject minimal fake modules for the hermes imports the plugin
    does at import time. Only `_rasterize_pdf` is exercised here so we
    don't need real `BasePlatformAdapter` behaviour."""

    if "gateway" not in sys.modules:
        gateway = types.ModuleType("gateway")
        sys.modules["gateway"] = gateway

    if "gateway.config" not in sys.modules:
        cfg = types.ModuleType("gateway.config")

        class _Platform:
            SIDEKICK = "sidekick"

        class _PlatformConfig:
            pass

        cfg.Platform = _Platform
        cfg.PlatformConfig = _PlatformConfig
        sys.modules["gateway.config"] = cfg

    if "gateway.platforms" not in sys.modules:
        pkg = types.ModuleType("gateway.platforms")
        sys.modules["gateway.platforms"] = pkg

    if "gateway.platforms.base" not in sys.modules:
        base = types.ModuleType("gateway.platforms.base")

        class _BasePlatformAdapter:
            pass

        class _MessageEvent:
            pass

        class _MessageType:
            TEXT = "text"
            PHOTO = "photo"
            VIDEO = "video"
            AUDIO = "audio"
            DOCUMENT = "document"

        class _SendResult:
            pass

        base.BasePlatformAdapter = _BasePlatformAdapter
        base.MessageEvent = _MessageEvent
        base.MessageType = _MessageType
        base.SendResult = _SendResult
        sys.modules["gateway.platforms.base"] = base


def _load_plugin():
    """Import ``backends/hermes/plugin/__init__.py`` directly."""
    _install_hermes_stubs()
    plugin_init = Path(__file__).resolve().parents[1] / "__init__.py"
    spec = importlib.util.spec_from_file_location(
        "sidekick_plugin_under_test", plugin_init,
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def plugin():
    return _load_plugin()


@pytest.fixture
def rasterize(plugin):
    return plugin.SidekickAdapter._rasterize_pdf


# ── tiny valid PDF generator (no external deps) ───────────────────────
# Hand-rolled minimal 1-page PDF. Avoids pulling reportlab/PyMuPDF into
# the test deps. Pages > 1 are constructed by appending more page-tree
# entries; we use this only for the multi-page count assertion.

_MINIMAL_PDF_TEMPLATE = b"""%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Count %(count)d /Kids [%(kids)s] >>
endobj
%(pages)s
xref
0 %(xref_count)d
0000000000 65535 f
%(xref_entries)s
trailer
<< /Size %(xref_count)d /Root 1 0 R >>
startxref
%(startxref)d
%%EOF
"""


def _make_minimal_pdf(num_pages: int = 1) -> bytes:
    """Build a minimal multi-page PDF with no actual content streams.
    pdftoppm renders this as N blank pages, which is sufficient for
    happy-path rasterization tests.
    """
    # Object layout:
    #   1: Catalog
    #   2: Pages tree
    #   3..3+N-1: Page objects
    parts: list[bytes] = []
    parts.append(b"%PDF-1.4\n")
    offsets: list[int] = [0]  # obj0 is the free entry

    def emit(obj_num: int, body: bytes) -> None:
        offsets.append(sum(len(p) for p in parts))
        parts.append(b"%d 0 obj\n%b\nendobj\n" % (obj_num, body))

    page_obj_nums = list(range(3, 3 + num_pages))
    kids_str = " ".join(f"{n} 0 R" for n in page_obj_nums).encode()

    emit(1, b"<< /Type /Catalog /Pages 2 0 R >>")
    emit(
        2,
        b"<< /Type /Pages /Count %d /Kids [%b] >>" % (num_pages, kids_str),
    )
    for n in page_obj_nums:
        emit(
            n,
            b"<< /Type /Page /Parent 2 0 R "
            b"/MediaBox [0 0 612 792] /Resources << >> >>",
        )

    xref_pos = sum(len(p) for p in parts)
    xref_lines = [b"xref\n", b"0 %d\n" % (num_pages + 3), b"0000000000 65535 f \n"]
    for off in offsets[1:]:
        xref_lines.append(b"%010d 00000 n \n" % off)
    parts.extend(xref_lines)

    parts.append(
        b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n"
        % (num_pages + 3, xref_pos),
    )
    return b"".join(parts)


# ── happy path ────────────────────────────────────────────────────────


def _have_pdftoppm() -> bool:
    try:
        subprocess.run(
            ["pdftoppm", "-v"], capture_output=True, timeout=5, check=False,
        )
        return True
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


@pytest.mark.skipif(not _have_pdftoppm(), reason="pdftoppm not installed")
def test_happy_path_rasterizes_each_page(tmp_path, rasterize):
    pdf = tmp_path / "doc.pdf"
    pdf.write_bytes(_make_minimal_pdf(num_pages=3))

    pages = rasterize(pdf)

    assert len(pages) == 3
    for p in pages:
        assert p.exists()
        assert p.suffix == ".png"
        # PNG magic byte sanity check.
        assert p.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"


@pytest.mark.skipif(not _have_pdftoppm(), reason="pdftoppm not installed")
def test_single_page_pdf_returns_one_png(tmp_path, rasterize):
    pdf = tmp_path / "single.pdf"
    pdf.write_bytes(_make_minimal_pdf(num_pages=1))

    pages = rasterize(pdf)

    assert len(pages) == 1
    assert pages[0].exists()


# ── failure modes (mocked subprocess) ─────────────────────────────────


def test_size_cap_drops_oversize_pdf(tmp_path, rasterize, plugin, caplog):
    """A 25MB PDF (cap is 20MB) is rejected before pdftoppm is invoked."""
    pdf = tmp_path / "big.pdf"
    # Write a header + sparse padding to hit the size threshold without
    # wasting RAM building a real PDF.
    over_cap = plugin.SIDEKICK_PDF_MAX_BYTES + 1
    pdf.write_bytes(b"%PDF-1.4\n" + b"\x00" * (over_cap - len(b"%PDF-1.4\n")))

    with mock.patch("subprocess.run") as run:
        with caplog.at_level(logging.WARNING):
            pages = rasterize(pdf)

    assert pages == []
    run.assert_not_called()
    assert any("rejected" in rec.getMessage() for rec in caplog.records)


def test_missing_pdftoppm_logs_install_hint(tmp_path, rasterize, caplog):
    """FileNotFoundError → empty list + actionable error log."""
    pdf = tmp_path / "any.pdf"
    pdf.write_bytes(b"%PDF-1.4\n%%EOF\n")

    with mock.patch(
        "subprocess.run", side_effect=FileNotFoundError("pdftoppm"),
    ):
        with caplog.at_level(logging.ERROR):
            pages = rasterize(pdf)

    assert pages == []
    msgs = " ".join(r.getMessage() for r in caplog.records)
    assert "pdftoppm" in msgs
    assert "poppler-utils" in msgs


def test_encrypted_pdf_drops_gracefully(tmp_path, rasterize, caplog):
    """pdftoppm returning non-zero (encrypted/corrupt) → drop, no raise."""
    pdf = tmp_path / "encrypted.pdf"
    pdf.write_bytes(b"%PDF-1.4\n%%EOF\n")

    err = subprocess.CalledProcessError(
        returncode=1,
        cmd=["pdftoppm"],
        output=b"",
        stderr=b"Error: PDF file is damaged - attempting to reconstruct xref table...\n"
               b"Error: Couldn't find trailer dictionary",
    )
    with mock.patch("subprocess.run", side_effect=err):
        with caplog.at_level(logging.WARNING):
            pages = rasterize(pdf)

    assert pages == []
    assert any("pdftoppm failed" in r.getMessage() for r in caplog.records)


def test_timeout_drops_without_crashing(tmp_path, rasterize, caplog):
    pdf = tmp_path / "slow.pdf"
    pdf.write_bytes(b"%PDF-1.4\n%%EOF\n")

    with mock.patch(
        "subprocess.run",
        side_effect=subprocess.TimeoutExpired(cmd=["pdftoppm"], timeout=30),
    ):
        with caplog.at_level(logging.WARNING):
            pages = rasterize(pdf)

    assert pages == []
    assert any("timeout" in r.getMessage().lower() for r in caplog.records)


def test_materialize_attachments_replaces_pdf_with_pages(plugin):
    """_materialize_attachments(): given a PDF data:URL, the PDF tempfile
    is unlinked and the returned paths are PNGs (one per rasterized
    page). Ensures the wire-shape promise from the proposal: vision
    tools never see ``application/pdf`` mimes."""
    if not _have_pdftoppm():
        pytest.skip("pdftoppm not installed")

    import base64

    pdf_bytes = _make_minimal_pdf(num_pages=2)
    data_url = "data:application/pdf;base64," + base64.b64encode(pdf_bytes).decode()

    # Self stub — _materialize_attachments doesn't touch any instance
    # state beyond _ext_for_mime / _kind_for_mime / _rasterize_pdf, all
    # of which are static.
    Adapter = plugin.SidekickAdapter
    paths, mimes, dominant = Adapter._materialize_attachments(
        Adapter,  # acts as `self` — only static methods get used
        [{
            "type": "image",
            "mimeType": "application/pdf",
            "fileName": "doc.pdf",
            "content": data_url,
        }],
    )

    try:
        assert len(paths) == 2
        assert all(m == "image/png" for m in mimes)
        # The original PDF tempfile must NOT survive.
        assert not any(p.endswith(".pdf") for p in paths)
        # Resulting paths exist on disk and are real PNGs.
        for p in paths:
            assert Path(p).exists()
            assert Path(p).read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"
        # MessageType.PHOTO since rasterized output is all images.
        assert dominant == plugin.MessageType.PHOTO
    finally:
        for p in paths:
            try:
                Path(p).unlink()
            except OSError:
                pass


def test_materialize_attachments_pdf_failure_drops_silently(plugin, tmp_path):
    """If rasterization yields nothing (e.g. encrypted PDF), the PDF
    is dropped and the materialize call returns ``([], [], TEXT)``."""
    import base64

    bogus = base64.b64encode(b"not a real pdf").decode()
    data_url = f"data:application/pdf;base64,{bogus}"

    Adapter = plugin.SidekickAdapter
    with mock.patch.object(Adapter, "_rasterize_pdf", return_value=[]):
        paths, mimes, dominant = Adapter._materialize_attachments(
            Adapter,
            [{
                "type": "image",
                "mimeType": "application/pdf",
                "fileName": "bad.pdf",
                "content": data_url,
            }],
        )

    assert paths == []
    assert mimes == []
    assert dominant == plugin.MessageType.TEXT


def test_page_cap_flag_forwarded_to_pdftoppm(tmp_path, rasterize, plugin):
    """Verify ``-l <SIDEKICK_PDF_MAX_PAGES>`` is on the command line.

    We can't easily build a 60-page fixture without a real PDF lib, but
    we CAN assert pdftoppm receives the correct flag — that's the whole
    contract pdftoppm honors at runtime.
    """
    pdf = tmp_path / "tiny.pdf"
    pdf.write_bytes(b"%PDF-1.4\n%%EOF\n")

    captured: dict = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        # Simulate pdftoppm producing nothing so we don't have to fake
        # outputs — the cmdline assertion is what matters here.
        return mock.MagicMock(returncode=0)

    with mock.patch("subprocess.run", side_effect=fake_run):
        rasterize(pdf)

    assert "-l" in captured["cmd"]
    idx = captured["cmd"].index("-l")
    assert captured["cmd"][idx + 1] == str(plugin.SIDEKICK_PDF_MAX_PAGES)
    # And -r DPI:
    assert "-r" in captured["cmd"]
    idx = captured["cmd"].index("-r")
    assert captured["cmd"][idx + 1] == str(plugin.SIDEKICK_PDF_DPI)

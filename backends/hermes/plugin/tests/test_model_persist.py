"""Unit tests for the sidekick plugin's ``_apply_model_setting``.

Pins the persistence-after-switch_model behaviour we fixed in commit
abb608a (fix(plugin): persist model switch to config.yaml).

The bug: ``switch_model(is_global=True)`` returns success but does NOT
write config.yaml on its own — despite the flag's name. Both cli.py and
gateway/run.py call ``save_config()`` after; the plugin used to skip
that step, so settings POSTs from the PWA "took effect" in memory but
reverted on the next ``_build_settings_schema`` read (which re-derives
from config.yaml).

We test the persistence path with switch_model + save_config monkey-
patched so the test never touches the real hermes_cli internals or the
real ``~/.hermes/config.yaml``. The assertion is structural: after a
successful model switch, ``save_config`` was called with a dict whose
``model.default`` matches the requested value.
"""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path
from unittest import mock

import pytest


def _install_hermes_stubs() -> None:
    """Same stub set as test_pdf_rasterize, plus stubs for the
    hermes_cli modules ``_apply_model_setting`` imports lazily."""

    if "gateway" not in sys.modules:
        sys.modules["gateway"] = types.ModuleType("gateway")

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
        sys.modules["gateway.platforms"] = types.ModuleType("gateway.platforms")

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
    _install_hermes_stubs()
    plugin_init = Path(__file__).resolve().parents[1] / "__init__.py"
    spec = importlib.util.spec_from_file_location(
        "sidekick_plugin_under_test_model", plugin_init,
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def plugin():
    return _load_plugin()


@pytest.fixture
def adapter(plugin, tmp_path):
    """Bare instance of SidekickAdapter with just enough state for
    ``_apply_model_setting`` to run. We bypass ``__init__`` because the
    real one wires up the gateway, threading, db connections, etc."""
    adapter = plugin.SidekickAdapter.__new__(plugin.SidekickAdapter)
    return adapter


def _make_schema_stub(plugin, options, current_value):
    """Patch ``_build_settings_schema`` to return a single 'model'
    enum with the given options[] and current value. Returns the
    mock so the test can assert call counts."""
    schema = [
        {
            "id": "model",
            "type": "enum",
            "value": current_value,
            "options": [{"value": v, "label": v} for v in options],
        },
    ]
    return mock.patch.object(
        plugin.SidekickAdapter, "_build_settings_schema",
        return_value=schema,
    )


def test_persists_model_to_config_yaml(plugin, adapter):
    """Successful switch_model writes config.yaml via save_config."""
    save_calls = []

    fake_switch_result = mock.Mock(
        success=True,
        new_model="anthropic/claude-haiku-4.5",
        target_provider="openrouter",
        base_url="https://openrouter.ai/api/v1",
        error_message=None,
    )

    fake_yaml = mock.Mock()
    fake_yaml.safe_load.return_value = {
        "model": {"default": "google/gemma-4-26b-a4b-it",
                  "provider": "openrouter"},
    }

    fake_config_path = mock.Mock()
    fake_config_path.exists.return_value = True
    fake_config_path.__enter__ = lambda s: s
    fake_config_path.__exit__ = lambda *a: None

    fake_get_path = mock.Mock(return_value=fake_config_path)
    fake_get_custom = mock.Mock(return_value=None)

    def fake_save_config(cfg):
        save_calls.append(dict(cfg))

    with _make_schema_stub(
        plugin,
        options=["google/gemma-4-26b-a4b-it", "anthropic/claude-haiku-4.5"],
        current_value="google/gemma-4-26b-a4b-it",
    ), mock.patch("builtins.open", mock.mock_open(
        read_data="model:\n  default: google/gemma-4-26b-a4b-it\n",
    )), mock.patch.dict(sys.modules, {
        "yaml": fake_yaml,
        "hermes_cli": types.ModuleType("hermes_cli"),
        "hermes_cli.config": types.SimpleNamespace(
            get_config_path=fake_get_path,
            get_compatible_custom_providers=fake_get_custom,
            save_config=fake_save_config,
        ),
        "hermes_cli.model_switch": types.SimpleNamespace(
            switch_model=mock.Mock(return_value=fake_switch_result),
        ),
    }):
        result = adapter._apply_model_setting("anthropic/claude-haiku-4.5")

    assert len(save_calls) == 1, "save_config should be invoked exactly once"
    persisted = save_calls[0]
    assert persisted["model"]["default"] == "anthropic/claude-haiku-4.5"
    assert persisted["model"]["provider"] == "openrouter"
    assert persisted["model"]["base_url"] == "https://openrouter.ai/api/v1"
    assert result["id"] == "model"


def test_skips_persist_when_switch_model_fails(plugin, adapter):
    """A failed switch_model raises and never calls save_config."""
    save_calls = []

    fake_switch_result = mock.Mock(
        success=False,
        error_message="model not found in catalog",
    )

    fake_yaml = mock.Mock()
    fake_yaml.safe_load.return_value = {"model": {"default": "x"}}

    fake_get_path = mock.Mock(return_value=mock.Mock(exists=lambda: True))
    fake_get_custom = mock.Mock(return_value=None)

    def fake_save_config(cfg):
        save_calls.append(dict(cfg))

    with _make_schema_stub(
        plugin,
        options=["x", "y"],
        current_value="x",
    ), mock.patch("builtins.open", mock.mock_open(
        read_data="model:\n  default: x\n",
    )), mock.patch.dict(sys.modules, {
        "yaml": fake_yaml,
        "hermes_cli": types.ModuleType("hermes_cli"),
        "hermes_cli.config": types.SimpleNamespace(
            get_config_path=fake_get_path,
            get_compatible_custom_providers=fake_get_custom,
            save_config=fake_save_config,
        ),
        "hermes_cli.model_switch": types.SimpleNamespace(
            switch_model=mock.Mock(return_value=fake_switch_result),
        ),
    }):
        with pytest.raises(Exception):  # _SettingsValidationError
            adapter._apply_model_setting("y")

    assert save_calls == [], "save_config must NOT run when switch_model fails"


def test_rejects_value_not_in_options(plugin, adapter):
    """Validation against options[] runs before switch_model is even
    called — rejects values outside the declared enum."""
    switch_calls = []

    def _track_switch(*args, **kwargs):
        switch_calls.append(kwargs)
        raise AssertionError("switch_model should not be called for invalid value")

    with _make_schema_stub(
        plugin,
        options=["x", "y"],
        current_value="x",
    ), mock.patch.dict(sys.modules, {
        "hermes_cli": types.ModuleType("hermes_cli"),
        "hermes_cli.model_switch": types.SimpleNamespace(
            switch_model=mock.Mock(side_effect=_track_switch),
        ),
    }):
        with pytest.raises(Exception):  # _SettingsValidationError
            adapter._apply_model_setting("not-in-options")

    assert switch_calls == []

# PDF Rasterization Architecture Proposal

> **Status: IMPLEMENTED (sidekick-only scope)** — 2026-04-30. Shipped
> in `backends/hermes/plugin/__init__.py`:
> `SidekickAdapter._rasterize_pdf` + wiring in
> `_materialize_attachments`. Frontend now accepts PDFs via the attach
> button (`index.html#attach-input` + `src/attachments.ts`). Tests
> live at `backends/hermes/plugin/tests/test_pdf_rasterize.py`.
>
> **Scope correction** (vs. the original draft below): the proposal
> claimed `_materialize_attachments` is the "all-channels convergence
> point." That was wrong — it's the **sidekick** platform adapter
> only. Telegram / WhatsApp / Slack / Signal each have their own
> adapters in `~/.hermes/hermes-agent/gateway/platforms/*.py` with
> separate attachment flows. Per Jonathan's decision: ship
> rasterization sidekick-only; cross-channel PDF support is deferred
> to a follow-up that touches each platform adapter individually
> (or, better, factors a shared materializer once a second channel
> needs it).
>
> **Env knobs** (set in `~/.hermes/.env`, defaults sized for Pi 5):
> | Var | Default | Purpose |
> |-----|---------|---------|
> | `SIDEKICK_PDF_DPI` | 150 | `pdftoppm -r N` |
> | `SIDEKICK_PDF_MAX_PAGES` | 50 | `pdftoppm -l N` |
> | `SIDEKICK_PDF_RASTERIZE_TIMEOUT_S` | 30 | subprocess timeout |
> | `SIDEKICK_PDF_MAX_BYTES` | 20 MiB | reject before shelling out |
>
> **System dep**: `pdftoppm` (poppler-utils). On Debian/Ubuntu:
> `sudo apt install poppler-utils`. The plugin logs a clear error
> with this hint if the binary isn't on `$PATH`.

## Goal

Enable PDF upload support in the Sidekick stack. Multimodal LLMs (gemma-3, claude, gpt-4o, gemini) consume images natively, not PDFs. We need server-side rasterization (PDF → one image per page) so the existing image content-block pipeline can transparently carry PDF content to all models and all inbound channels.

**Constraint**: Single-path rasterization through all devices and frontends. One place it happens, regardless of which channel (PWA, Telegram, WhatsApp, Slack, Signal, future mac-install, R2 fork) the PDF entered through.

## Non-Goals

- Browser-side rasterization (pdf.js on PWA): per-device duplication, mobile memory overhead, doesn't help Telegram/WhatsApp/Slack users.
- LLM-side tool (rasterize_pdf tool call): not single-path, increases prompt engineering, lazy / model-driven.
- Lossless PDF preservation: we're intentionally trading PDF fidelity for vision-model compatibility.
- OCR integration: scanned PDFs work fine (vision models read text-as-image); pure-text PDFs are rare in field use.

## Current State

### Attachment Flow Today

**PWA Inbound Path** (`src/attachments.ts`, `src/main.ts`):
- `index.html#attach-input` and camera-input gate on `accept="image/*,video/*"`
- User picks file → `attachments.add(file)` reads as dataURL (`.readAsDataURL()`)
- `attachments.toSendPayload()` strips the `data:...;base64,` prefix
- Pending attachments appear as chips in `#composer-attachments`
- Message send via `POST /api/sidekick/messages` includes `attachments: [{type, mimeType, fileName, content (data:URL)}]`

**Proxy Handling** (`proxy/sidekick/messages.ts` lines 37–104):
- Receives POST `/api/sidekick/messages` with `{chat_id, text, attachments?}`
- Validates `text` + `attachments.length > 0`; caps body at 1 MB
- Forwards to upstream via `upstream.sendMessage(chatId, text, {attachments})` (lines 113–115)
- No rasterization here; attachments pass through untouched

**Upstream Forward** (`proxy/sidekick/upstream.ts` lines 293–377):
- `HTTPAgentUpstream.sendMessage()` includes `attachments` in POST body to `/v1/responses` (line 308)
- Additive field: raw OAI-compat upstreams ignore it; Hermes plugin handles it

**Hermes Plugin** (`backends/hermes/plugin/__init__.py` lines 459–594):
- `_dispatch_message()` receives `attachments` array
- `_materialize_attachments()` decodes base64 data:URLs → `/tmp/sidekick-attach-<uuid>.<ext>` files
- Passes paths to `MessageEvent` as `media_urls` (line 491)
- `_kind_for_mime()` (line 619) stamps dominant message_type (PHOTO / VIDEO / DOCUMENT)
- Cleanup via `_cleanup_turn_attachments()` after turn ends

**Vision Tool Integration** (hermes internals, not directly visible in sidekick):
- Hermes' vision tools read `media_urls` directly from `MessageEvent`
- Currently supports images (PNG, JPEG, WebP, GIF, HEIC) and videos

### Current Gaps

1. PWA doesn't gate PDFs; attachments.add() rejects them at line 66 (`!isImage && !isVideo`)
2. Proxy doesn't process PDFs (would be wrong place anyway — misses Telegram/WhatsApp)
3. Hermes plugin doesn't rasterize; it treats PDFs as `DOCUMENT` type
4. Vision tools don't consume DOCUMENT types — PDFs sit in `media_urls` unread

## Recommended Architecture: Hermes Plugin Rasterization

**Decision**: Rasterize PDFs in the Hermes plugin's `_materialize_attachments()` method, right before the tempfile write. This is the single agreement point where ALL inbound channels converge.

**Why this location**:
- Hermes plugin is the "content normalizer" — every message (sidekick PWA, Telegram, WhatsApp, Slack, Signal) flows through `_dispatch_message()` before reaching the agent.
- Single implementation, zero duplication across platform adapters.
- Rasterization happens server-side (hermes' host, typically powerful) — not on mobile devices.
- Output (image files) fit directly into existing `media_urls` → vision tool pipeline.
- No proxy changes needed; no PWA changes needed (beyond gating, UI polish).

### Rejection of Alternatives

- **PWA-side (pdf.js)**: Each device reimplements; mobile memory issues; doesn't help non-PWA users.
- **Sidekick proxy** (`proxy/sidekick/`): Only sidekick-channel PDFs rasterize; Telegram/WhatsApp PDFs stay raw. Violates single-path.
- **Audio bridge**: Orthogonal; audio-only scope.
- **Sidekick channel adapter (hermes side)**: Same problem as proxy — only sidekick PDFs.
- **Cross-channel normalizer (if one existed)**: Good idea in theory; hermes has no generic cross-channel preprocessor. Rasterization is best scoped to the attachment materializer.
- **LLM tool call (rasterize_pdf)**: Model-driven, prompt-intensive, lazy. Violates single-path principle.

## Wire Shape After Rasterization

**Input** (at Hermes plugin `_materialize_attachments()`):
```
{type: 'image', mimeType: 'application/pdf', fileName: 'document.pdf', content: 'data:application/pdf;base64,...'}
```

**Output** (tempfiles + MessageEvent):
```
MessageEvent.media_urls = [
  '/tmp/sidekick-attach-<uuid>-page-0.png',
  '/tmp/sidekick-attach-<uuid>-page-1.png',
  '/tmp/sidekick-attach-<uuid>-page-2.png',
  ...
]
MessageEvent.media_types = ['image/png', 'image/png', 'image/png', ...]
MessageEvent.message_type = MessageType.PHOTO  # (or DOCUMENT, TBD)
```

**Vision model receives** (via hermes' vision tool):
- List of PNG images (one per page)
- Identical to multi-image send from PWA today

**No PWA changes needed**: PWA still sends the raw PDF dataURL; rasterization is invisible to it. Optional UI polish: show a "Converting PDF..." spinner on the chip while the turn processes.

## Implementation Sketch

**Location**: `backends/hermes/plugin/__init__.py`, in or after `_materialize_attachments()` (lines 528–594).

### Pseudo-code

```python
def _materialize_attachments(self, attachments: list) -> Tuple[List[str], List[str], MessageType]:
    import base64
    import tempfile
    import subprocess  # for pdftoppm
    
    paths: List[str] = []
    mimes: List[str] = []
    kinds: List[str] = []
    
    for a in attachments:
        if not isinstance(a, dict): continue
        content = a.get("content")
        if not isinstance(content, str) or not content.startswith("data:"): continue
        
        try:
            header, b64 = content.split(",", 1)
        except ValueError:
            continue
        
        mime = a.get("mimeType") or self._mime_from_header(header)
        try:
            payload = base64.b64decode(b64, validate=False)
        except Exception:
            logger.warning("[sidekick] base64 decode failed")
            continue
        
        # Check if PDF and rasterize
        if mime.lower() == "application/pdf":
            pdf_path = self._write_temp_file(payload, ".pdf")
            raster_paths = self._rasterize_pdf_to_images(pdf_path)
            # Clean up the temp PDF after rasterization
            try:
                os.unlink(pdf_path)
            except:
                pass
            # Add each rasterized image to the output
            for img_path in raster_paths:
                paths.append(img_path)
                mimes.append("image/png")
                kinds.append("image")
        else:
            # Existing image/video flow
            ext = self._ext_for_mime(mime, a.get("fileName"))
            fd, path = tempfile.mkstemp(
                prefix="sidekick-attach-", suffix=ext, dir="/tmp",
            )
            try:
                with os.fdopen(fd, "wb") as f:
                    f.write(payload)
            except Exception:
                logger.exception("[sidekick] failed writing attachment")
                continue
            paths.append(path)
            mimes.append(mime)
            kinds.append(self._kind_for_mime(mime))
    
    if not paths:
        return [], [], MessageType.TEXT
    
    dominant = MessageType.PHOTO  # PDFs rasterize to PHOTO
    first = kinds[0] if kinds else "image"
    if first == "video":
        dominant = MessageType.VIDEO
    elif first == "audio":
        dominant = MessageType.AUDIO
    
    return paths, mimes, dominant

def _rasterize_pdf_to_images(self, pdf_path: str) -> List[str]:
    """Rasterize a PDF file to PNG images (one per page).
    
    Returns list of PNG file paths. Raises on failure.
    Caller is responsible for cleanup if needed.
    """
    import subprocess
    import tempfile
    
    # pdftoppm -png <pdf> <output_prefix>
    # Outputs: <output_prefix>-1.png, <output_prefix>-2.png, ...
    
    fd, prefix = tempfile.mkstemp(prefix="sidekick-pdf-", dir="/tmp")
    os.close(fd)  # close the fd; pdftoppm creates new files with this prefix
    
    try:
        # pdftoppm: convert PDF to PPM/PNG images
        # -png: output format
        # -r 150: DPI (balance quality vs file size)
        # -singlefile: if PDF is 1 page, don't add suffix
        result = subprocess.run(
            ["pdftoppm", "-png", "-r", "150", pdf_path, prefix],
            capture_output=True,
            timeout=30,  # 30s per PDF
            check=True,
        )
    except subprocess.TimeoutExpired:
        logger.error("[sidekick] pdftoppm timeout on %s", pdf_path)
        raise
    except subprocess.CalledProcessError as e:
        logger.error("[sidekick] pdftoppm failed: %s", e.stderr.decode(errors='ignore')[:200])
        raise
    except FileNotFoundError:
        logger.error("[sidekick] pdftoppm not installed")
        raise
    
    # Collect output files: prefix.png (1-page) or prefix-1.png, prefix-2.png, ...
    output_paths = []
    base_path = prefix + ".png"
    if os.path.exists(base_path):
        output_paths.append(base_path)
    else:
        i = 1
        while True:
            numbered_path = f"{prefix}-{i}.png"
            if os.path.exists(numbered_path):
                output_paths.append(numbered_path)
                i += 1
            else:
                break
    
    if not output_paths:
        raise RuntimeError(f"pdftoppm produced no output for {pdf_path}")
    
    return sorted(output_paths)
```

### Key Functions to Add

1. **`_rasterize_pdf_to_images(pdf_path: str) -> List[str]`**: Core rasterization. Calls `pdftoppm`, collects output PNGs, returns list of paths. Raises on failure (missing binary, timeout, corrupt PDF).

2. **Update `_materialize_attachments()`**: Add mime-type check; if PDF, call rasterizer before tempfile write. Accumulate rasterized images into output lists.

3. **Update `_cleanup_turn_attachments()`**: No change needed — already cleans all paths in `_pending_attachment_paths[chat_id]`.

## Tooling Choice: poppler's `pdftoppm`

**Why poppler**:
- Standard library on Linux (Debian/Ubuntu/Alpine: `apt install poppler-utils` or `apk add poppler-utils`)
- Tiny footprint (~2 MB installed); Pi5-friendly.
- Battle-tested; used by countless tools and services.
- C++ backend; fast for typical PDFs (100–500ms per page).
- Memory usage scales with page size, not file size — doesn't load entire PDF into RAM.

**Alternatives considered**:
- **pdfium (Chromium's lib)**: Smaller memory footprint, but not in standard repos; requires compilation or vendored binary.
- **pdf.js (JavaScript)**: Browser-only; requires Node.js and extra deps; slower on large files.
- **PyMuPDF (fitz)**: Python-only, not available in core sidekick (which is TypeScript + Python).
- **ghostscript (gs)**: Works, but larger footprint and older API; poppler is modern.

**Installation**:
- Debian/Ubuntu: `apt install poppler-utils`
- Alpine: `apk add poppler-utils`
- macOS: `brew install poppler`
- Automate in `install.sh` or Docker image.

**Binary location**: assume `pdftoppm` is in `$PATH`. Subprocess call will fail with `FileNotFoundError` if missing; log a clear error and skip the PDF (or fail the turn, depending on policy).

## Failure Modes and Caps

**Concrete limits**:

| Case | Limit | Rationale | Action |
|------|-------|-----------|--------|
| PDF file size | 20 MB | Base64 decode + tempfile I/O; typical PDFs < 5 MB | Reject at PWA input (new validation) |
| Pages per PDF | 50 | Rasterization time; 50 pages × 200ms ≈ 10s, acceptable | Warn in logs; silently truncate to first 50 pages (pdftoppm `-l 50` flag) |
| Output image size per page | 1 MB (PNG) | Memory + vision-tool budget | Use `-r 150` DPI as default; scale down if > 1 MB per page |
| Rasterization timeout | 30 seconds | Prevent wedged processes | Subprocess timeout; emit error envelope, continue |
| Corrupted/encrypted PDF | N/A | pdftoppm skips silently or errors | Catch exception, log, skip attachment (don't fail turn) |

**Error handling**:
- If pdftoppm not installed: log at startup (when adapter connects), warn per-turn if PDF upload attempted. User sees "PDF conversion unavailable" notification.
- If PDF is encrypted: pdftoppm fails; we catch, log, skip this attachment. Other attachments in the same message still process.
- If PDF exceeds page cap: pdftoppm `-l 50` limits output to first 50 pages. Silently applied; no user warning (acceptable — vision models see the most important pages).
- If rasterization times out: abort this attachment, emit error envelope, let the turn continue without it.

**Testing strategy**:
- Unit test: mock `subprocess.run()`, verify output-path parsing works.
- Hermetic test: small 1-page PDF, verify output PNG exists and is valid.
- Load test: 50-page PDF (docx export, ~3 MB), measure rasterization time + memory.
- Edge case: encrypted PDF, corrupted PDF (invalid header), zero-page PDF.

## No PWA Changes Required

The PWA currently rejects PDFs at line 66 of `attachments.ts`:
```typescript
if (!isImage && !isVideo) {
  status.setStatus('Only image and video attachments are supported', 'err');
  return;
}
```

**Step 1 (future)**: Expand this to accept PDFs:
```typescript
const isPdf = file.type === 'application/pdf';
if (!isImage && !isVideo && !isPdf) { ... }
```

**Step 2 (future)**: Update `index.html#attach-input` accept attribute:
```html
<input type="file" id="attach-input" accept="image/*,video/*,.pdf" multiple hidden>
```

**Not part of this proposal**: The PWA gating is a UX choice. For MVP, PDFs arriving via Telegram/WhatsApp auto-rasterize at the plugin; PWA users get PDF support "for free" the moment we flip the toggle. No server-side code change.

## Rollout Plan

### Phase 1: Hermes Plugin (this proposal)

1. **Add dependency**: `pip install` or ensure poppler-utils installed on hermes host.
2. **Implement rasterization**: Add `_rasterize_pdf_to_images()` + update `_materialize_attachments()` in `backends/hermes/plugin/__init__.py`.
3. **Test**: Hermetic unit tests + on-device manual test (upload PDF via Telegram bot, verify agent sees images).
4. **Deploy**: No proxy or PWA changes; hermes restart.

### Phase 2: Proxy (future, optional)

- If we want to cap PDF size at the PWA boundary (before upload), add validation in `proxy/sidekick/messages.ts` to reject PDFs > 20 MB.
- Optional; hermes-side caps are sufficient.

### Phase 3: PWA (future, UX polish)

- Update `index.html#attach-input` to accept PDFs.
- Update `attachments.ts` to allow PDFs.
- Show PDF chip with a "Converting…" spinner during turn (cosmetic; conversion happens server-side).
- Add settings toggle: "Enable PDF upload" (gated on model vision capability, like images today).

## Confidence Assessment

**High confidence (≥90%)**:
- Hermes plugin is the right place (it's the attachment materializer + single agreement point).
- `pdftoppm` is reliable and Pi5-friendly.
- Rasterization output (PNG images) feeds cleanly into existing vision-tool pipeline.
- No breaking changes to proxy or PWA.

**Medium confidence (70–80%)**:
- Exact DPI (150) and page cap (50) will need on-device tuning. Different models may prefer different resolution tradeoffs.
- Memory usage under concurrent multi-page PDFs. Single-user sidekick is fine; would need profiling under load.

**Uncertainty flags**:
- Vision tools' exact input constraints (max images, max total bytes, timeout). Varies by model (Claude, Gemini, GPT-4o have different limits). Propose starting with conservative defaults and documenting the limits clearly.
- Encrypted PDF handling: do we auto-reject, or is there a user-facing password prompt? (Propose: auto-reject with clear error message for now.)

## Next Steps (Post-Proposal)

1. Discuss with Jonathan: DPI choice, page cap, PWA gating timeline.
2. Prototype rasterization function with sample PDFs (1-page, 50-page, corrupted, encrypted).
3. Profile memory + CPU on hermes host during typical use.
4. Integrate into hermes plugin, test against Telegram bot + hermes vision tools.
5. Document limitations in user-facing help: "PDFs are automatically converted to images; scanned PDFs work best; max 50 pages."


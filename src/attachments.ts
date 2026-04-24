/**
 * @fileoverview Composer attachments — image picker + chips UI + send-path
 * data. Models gate what's accepted (image-capable models only).
 *
 * Owns the `pendingAttachments` queue, the chip DOM in `#composer-attachments`,
 * and the enable/disable state of the attach + camera buttons. Everyone else
 * interacts via the exported helpers — no direct DOM pokes.
 */

import { log } from './util/log.ts';
import * as settings from './settings.ts';
import * as status from './status.ts';
import * as chat from './chat.ts';

/** Each pending attachment: { dataUrl, mimeType, fileName, size }. */
const pending = [];
const MAX_BYTES = 5_000_000;  // matches openclaw gateway maxBytes

/** Called after the pending list changes — main wires this to refresh the
 *  composer send-button enabled state. */
let onChange = () => {};

export function init(opts = {}) {
  onChange = opts.onChange || (() => {});
}

export function getPending() { return pending; }
export function hasPending() { return pending.length > 0; }

/** Strip data-url prefix, return a gateway-ready attachment payload list.
 *  We tag videos with `type: 'video'` in case any plugin / model wants
 *  to distinguish; gateways that only recognise 'image' will typically
 *  still pass the bytes through with the mimeType intact. Probing
 *  strategy — if this breaks for a specific model, we'll iterate. */
export function toSendPayload() {
  return pending.map(a => ({
    type: a.mimeType?.startsWith('video/') ? 'video' : 'image',
    mimeType: a.mimeType,
    fileName: a.fileName,
    content: a.dataUrl,  // server strips the `data:...;base64,` prefix
  }));
}

/** Used by the transcript renderer when echoing a user message with images. */
export function toChatEcho() {
  return pending.map(a => ({
    dataUrl: a.dataUrl, mimeType: a.mimeType, fileName: a.fileName,
  }));
}

export function clear() {
  pending.length = 0;
  renderChips();
  onChange();
}

export async function add(file) {
  if (!file) return;
  // Accept images + videos. The gateway currently bundles both as
  // `{ type: 'image', ... }` which some multimodal models (Gemini,
  // some Gemma variants) will happily decode as video frames; others
  // will reject. We keep the client permissive — if the gateway or
  // model rejects, the user sees it in the reply.
  const isImage = file.type.startsWith('image/');
  const isVideo = file.type.startsWith('video/');
  if (!isImage && !isVideo) {
    status.setStatus('Only image and video attachments are supported', 'err');
    return;
  }
  if (file.size > MAX_BYTES) {
    status.setStatus(`File too large (${Math.round(file.size/1024)}KB > ${Math.round(MAX_BYTES/1024)}KB)`, 'err');
    return;
  }
  try {
    const dataUrl = await readAsDataUrl(file);
    const ext = (file.type.split('/')[1] || (isVideo ? 'mp4' : 'jpg')).split(';')[0];
    pending.push({
      dataUrl,
      mimeType: file.type,
      fileName: file.name || `${isVideo ? 'video' : 'image'}-${Date.now()}.${ext}`,
      size: file.size,
    });
    renderChips();
    onChange();
  } catch (e) {
    log('attachment read failed:', e.message);
  }
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(/** @type {string} */ (r.result));
    r.onerror = () => reject(new Error('file read failed'));
    r.readAsDataURL(file);
  });
}

function renderChips() {
  const container = document.getElementById('composer-attachments');
  if (!container) return;
  container.innerHTML = '';
  if (pending.length === 0) {
    container.style.display = 'none';
    return;
  }
  container.style.display = 'flex';
  pending.forEach((att, i) => {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip';
    // Video chips show a small silent <video> poster (iOS may not
    // auto-render frame 1 unless muted+preload=metadata). Image chips
    // stay as <img>.
    if (att.mimeType?.startsWith('video/')) {
      const vid = document.createElement('video');
      vid.src = att.dataUrl;
      vid.muted = true;
      vid.playsInline = true;
      vid.preload = 'metadata';
      vid.title = att.fileName;
      chip.appendChild(vid);
      chip.classList.add('chip-video');
    } else {
      const img = document.createElement('img');
      img.src = att.dataUrl;
      img.alt = att.fileName;
      chip.appendChild(img);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip-remove';
    btn.title = 'Remove';
    btn.textContent = '×';
    btn.onclick = () => {
      pending.splice(i, 1);
      renderChips();
      onChange();
    };
    chip.appendChild(btn);
    container.appendChild(chip);
  });
}

/** Enable/disable composer attach + camera buttons based on whether the
 *  active model supports image input. Server drops non-supported
 *  attachments silently, so we gate client-side for clarity. */
export function updateModelGate() {
  const entry = settings.getCurrentModelEntry?.();
  const canImage = Array.isArray(entry?.input) && entry.input.includes('image');
  for (const id of ['btn-attach', 'btn-camera']) {
    const btn = /** @type {HTMLButtonElement|null} */ (document.getElementById(id));
    if (!btn) continue;
    btn.disabled = !canImage;
    btn.title = canImage
      ? (id === 'btn-camera' ? 'Camera (image)' : 'Attach image')
      : 'Current model does not support images';
  }
  // Drop pending items the new model can't use. Safer than letting the
  // gateway silently drop them; the user sees the chips disappear + a notice.
  if (!canImage && pending.length > 0) {
    clear();
    chat.addSystemLine('Attachments cleared — current model does not support images');
  }
}

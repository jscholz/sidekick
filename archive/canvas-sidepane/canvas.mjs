/**
 * @fileoverview Canvas controller — the single entry point for showing cards.
 *
 * Public API:
 *   show(raw)     — validate + push a card (or replace by id)
 *   dismiss()     — return to ambient
 *   navigate(idx) — jump to a history card
 *   getHistory()  — read-only snapshot of card history
 *
 * All cards — whether from the agent, fallback parser, or client intent —
 * arrive as CanvasCard objects and go through validateAndLog before rendering.
 *
 * @typedef {import('../types.mjs').CanvasCard} CanvasCard
 */

import { validateAndLog } from './validate.mjs';
import { getCard } from './registry.mjs';
import { log } from '../util/log.mjs';

// ─── State ──────────────────────────────────────────────────────────────────

/** @type {CanvasCard[]} */
const history = [];

/** -1 = ambient; >= 0 = index into history */
let currentIdx = -1;

/** @type {(() => void)|null} - called on every state change */
let onChange = null;

// ─── Dedup ──────────────────────────────────────────────────────────────────

const DEDUP_WINDOW_MS = 5 * 60 * 1000;
/** @type {Map<string, number>} hash → timestamp */
const recentHashes = new Map();

function cardHash(card) {
  return `${card.kind}:${JSON.stringify(card.payload)}`;
}

function isDuplicate(card) {
  const h = cardHash(card);
  const prev = recentHashes.get(h);
  const now = Date.now();
  if (prev && (now - prev) < DEDUP_WINDOW_MS) return true;
  recentHashes.set(h, now);
  // Prune old entries occasionally
  if (recentHashes.size > 100) {
    for (const [k, t] of recentHashes) {
      if (now - t > DEDUP_WINDOW_MS) recentHashes.delete(k);
    }
  }
  return false;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Show a card. Validates, deduplicates, handles replace-by-id.
 * @param {unknown} raw - CanvasCard (or candidate to validate).
 * @returns {boolean} true if the card was shown.
 */
export function show(raw) {
  const card = validateAndLog(raw);
  if (!card) return false;

  if (isDuplicate(card)) {
    log('card deduped:', card.kind, card.meta?.title || '');
    return false;
  }

  // Replace by ID?
  const replaceId = card.meta?.replaces || card.id;
  if (replaceId) {
    const idx = history.findIndex(c => c.id === replaceId);
    if (idx >= 0) {
      history[idx] = card;
      if (currentIdx === idx) render();
      else notifyChange();
      return true;
    }
  }

  history.push(card);
  currentIdx = history.length - 1;
  render();
  return true;
}

/** Return to the ambient card. */
export function dismiss() {
  currentIdx = -1;
  render();
}

/** Navigate to a specific history index. */
export function navigate(idx) {
  if (idx >= 0 && idx < history.length) {
    currentIdx = idx;
    render();
  }
}

/** @returns {ReadonlyArray<CanvasCard>} */
export function getHistory() {
  return history;
}

/** @returns {number} */
export function getCurrentIndex() {
  return currentIdx;
}

// ─── Rendering ──────────────────────────────────────────────────────────────

/** @type {HTMLElement|null} */
let bodyEl = null;
/** @type {HTMLElement|null} */
let titleEl = null;
/** @type {HTMLElement|null} */
let iconEl = null;
/** @type {HTMLElement|null} */
let dismissEl = null;
/** @type {HTMLElement|null} */
let filmstripEl = null;
/** @type {(() => HTMLElement)|null} */
let renderAmbient = null;

/**
 * Bind the canvas to DOM elements. Called once at startup.
 * @param {Object} els
 * @param {HTMLElement} els.body - The .canvas-body container.
 * @param {HTMLElement} els.title - The .card-title span.
 * @param {HTMLElement} els.icon - The .card-icon span.
 * @param {HTMLElement} els.dismiss - The dismiss button.
 * @param {HTMLElement} els.filmstrip - The filmstrip container.
 * @param {() => HTMLElement} els.ambient - Function that returns an ambient card DOM node.
 * @param {() => void} [els.onChange] - Optional callback on every state change.
 */
export function bind(els) {
  bodyEl = els.body;
  titleEl = els.title;
  iconEl = els.icon;
  dismissEl = els.dismiss;
  filmstripEl = els.filmstrip;
  renderAmbient = els.ambient;
  onChange = els.onChange || null;
  render();
}

function render() {
  if (!bodyEl) return;

  const isAmbient = currentIdx < 0;
  const card = isAmbient ? null : history[currentIdx];

  // Header
  if (card) {
    const mod = getCard(card.kind);
    if (iconEl) iconEl.textContent = mod?.icon || '?';
    if (titleEl) titleEl.textContent = card.meta?.title || mod?.label || card.kind;
    if (dismissEl) dismissEl.style.visibility = 'visible';
  } else {
    if (iconEl) iconEl.textContent = '◉';
    if (titleEl) titleEl.textContent = 'Ambient';
    if (dismissEl) dismissEl.style.visibility = 'hidden';
  }

  // Body
  bodyEl.innerHTML = '';
  if (card) {
    const mod = getCard(card.kind);
    if (mod) {
      try {
        mod.render(card, bodyEl);
      } catch (err) {
        log('card render error:', card.kind, err.message);
        bodyEl.textContent = `Render error: ${err.message}`;
      }
    } else {
      bodyEl.textContent = `Unknown card kind: ${card.kind}`;
    }
  } else if (renderAmbient) {
    bodyEl.appendChild(renderAmbient());
  }

  renderFilmstrip();
  notifyChange();
}

function renderFilmstrip() {
  if (!filmstripEl) return;
  filmstripEl.innerHTML = '';

  if (history.length === 0) {
    const span = document.createElement('span');
    span.className = 'empty';
    span.textContent = 'NO CARDS YET';
    filmstripEl.appendChild(span);
    return;
  }

  for (let i = 0; i < history.length; i++) {
    const c = history[i];
    const mod = getCard(c.kind);
    const chip = document.createElement('button');
    chip.className = 'chip' + (i === currentIdx ? ' active' : '');
    const label = mod?.label || c.kind;
    const title = c.meta?.title ? ` · ${c.meta.title.slice(0, 16)}` : '';
    chip.textContent = label + title;
    chip.onclick = () => navigate(i);
    filmstripEl.appendChild(chip);
  }
}

function notifyChange() {
  if (onChange) onChange();
}

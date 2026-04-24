/**
 * Voice memo card — WhatsApp-style playback widget in the chat transcript.
 * Shows waveform bars, play/pause button, duration, transcript (when arrives),
 * and a status indicator (queued / sent).
 */

const playSvg = `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5v11l10-5.5z"/></svg>`;
const pauseSvg = `<svg viewBox="0 0 16 16" fill="currentColor"><rect x="3.5" y="3" width="3" height="10" rx="0.5"/><rect x="9.5" y="3" width="3" height="10" rx="0.5"/></svg>`;

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}

function drawBars(canvas, bars, progress) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const n = bars.length;
  const dotSpacing = w / n;
  const style = getComputedStyle(document.documentElement);
  const primary = style.getPropertyValue('--primary').trim() || '#6b8f5e';
  const muted = style.getPropertyValue('--muted').trim() || '#8a8a8a';
  const playedIdx = Math.floor(progress * n);
  for (let i = 0; i < n; i++) {
    const amp = bars[i];
    const barH = Math.max(2, amp * h * 1.6);
    const x = i * dotSpacing + dotSpacing / 2;
    const y = (h - barH) / 2;
    ctx.fillStyle = i < playedIdx ? primary : muted;
    ctx.beginPath();
    ctx.roundRect(x - 1.5, y, 3, barH, 1.5);
    ctx.fill();
  }
}

/**
 * Render a memo card into the container. Returns the root element.
 * @param {HTMLElement} container
 * @param {Object} rec - { id, blob, mimeType, durationMs, waveform, transcript, status }
 * @param {Object} [opts] - { onSend }
 */
export function render(container, rec, opts = {}) {
  // If a card for this id already exists, return it (no-op)
  const existing = container.querySelector(`.memo-card[data-memo-id="${rec.id}"]`);
  if (existing) return existing;

  const card = document.createElement('div');
  card.className = 'line memo-card';
  card.dataset.memoId = rec.id;

  // Top row: play button, waveform, duration, status
  const topRow = document.createElement('div');
  topRow.className = 'memo-card-top';

  const playBtn = document.createElement('button');
  playBtn.className = 'memo-card-play';
  playBtn.innerHTML = playSvg;

  const canvas = document.createElement('canvas');
  canvas.className = 'memo-card-wave';
  canvas.height = 32;

  const durEl = document.createElement('span');
  durEl.className = 'memo-card-duration';
  durEl.textContent = formatDuration(rec.durationMs);

  const statusEl = document.createElement('span');
  statusEl.className = 'memo-card-status';

  topRow.append(playBtn, canvas, durEl, statusEl);

  // Transcript row (below, shown once transcript arrives)
  const transcriptEl = document.createElement('div');
  transcriptEl.className = 'memo-card-transcript';

  // Timestamp
  const tsEl = document.createElement('span');
  tsEl.className = 'line-ts';
  const ts = rec.timestamp || Date.now();
  tsEl.textContent = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  tsEl.title = new Date(ts).toLocaleString();

  card.append(topRow, transcriptEl, tsEl);
  container.appendChild(card);

  // ── Audio playback ──
  let bars = rec.waveform instanceof Float32Array ? rec.waveform : Float32Array.from(rec.waveform || []);
  let lastProgress = 0;
  let blobUrl = null;
  const audio = new Audio();
  audio.preload = 'metadata';

  function ensureCanvasWidth() {
    const rect = canvas.getBoundingClientRect();
    if (rect.width > 0 && canvas.width !== Math.round(rect.width)) {
      canvas.width = Math.round(rect.width);
    }
  }

  function redraw(progress = 0) {
    lastProgress = progress;
    ensureCanvasWidth();
    drawBars(canvas, bars, progress);
  }
  // Initial draw once the layout settles
  requestAnimationFrame(() => redraw(0));

  // Allow late waveform updates (extraction is async + may fail/timeout)
  (card as any)._setWaveform = (newBars: Float32Array | number[] | null) => {
    bars = newBars instanceof Float32Array ? newBars : Float32Array.from(newBars || []);
    redraw(lastProgress);
  };

  playBtn.onclick = () => {
    if (!blobUrl && rec.blob) {
      blobUrl = URL.createObjectURL(rec.blob);
      audio.src = blobUrl;
    }
    if (audio.paused) {
      audio.play().catch(() => {});
      playBtn.innerHTML = pauseSvg;
    } else {
      audio.pause();
      playBtn.innerHTML = playSvg;
    }
  };
  audio.ontimeupdate = () => {
    const progress = audio.duration ? audio.currentTime / audio.duration : 0;
    redraw(progress);
  };
  audio.onended = () => {
    playBtn.innerHTML = playSvg;
    redraw(0);
  };

  // Set initial state
  update(card, { transcript: rec.transcript, status: rec.status });

  return card;
}

/**
 * Update an existing card's transcript and/or status.
 * @param {HTMLElement} card
 * @param {Object} patch — { transcript, status }
 */
export function update(card: HTMLElement, { transcript, status }: {
  transcript?: string | null;
  status?: string;
} = {}) {
  if (!card) return;
  if (transcript !== undefined) {
    const el = card.querySelector('.memo-card-transcript') as HTMLElement | null;
    if (el) {
      el.textContent = transcript || '';
      el.style.display = transcript ? '' : 'none';
    }
  }
  if (status !== undefined) {
    const el = card.querySelector('.memo-card-status');
    if (el) {
      card.classList.toggle('queued', status === 'queued');
      card.classList.toggle('sent', status === 'sent');
      card.classList.toggle('failed', status === 'failed');
      el.textContent = status === 'queued' ? '⏳' : status === 'failed' ? '⚠' : '';
    }
  }
}

/** Find an existing card in the container by memo id. */
export function find(container, id) {
  return container.querySelector(`.memo-card[data-memo-id="${id}"]`);
}

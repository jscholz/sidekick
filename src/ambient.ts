/**
 * @fileoverview Ambient clock + weather widget — floats in the lower-
 * right of the desktop viewport. Two states:
 *   - compact  (default): thin pill with time + current temp/icon
 *   - expanded (on click): rounded card with big clock, current weather
 *     detail, and a 3-day forecast strip. Click the card itself to
 *     collapse. Stays expanded otherwise — lets the HUD persist while
 *     the user chats.
 *
 * Hidden on mobile via CSS media query. Weather fetches the gateway's
 * /weather passthrough (Open-Meteo) with 15-min caching.
 */

import { escapeHtml } from './util/dom.ts';
import { log } from './util/log.ts';

const WEATHER_TTL_MS = 15 * 60 * 1000;

/** WMO → [emoji, description]. Used in both compact + expanded states. */
const WMO = {
  0: ['☀️', 'clear'],
  1: ['🌤', 'mainly clear'], 2: ['⛅', 'partly cloudy'], 3: ['☁️', 'overcast'],
  45: ['🌫', 'fog'], 48: ['🌫', 'rime fog'],
  51: ['🌦', 'light drizzle'], 53: ['🌦', 'drizzle'], 55: ['🌧', 'heavy drizzle'],
  56: ['🌧', 'freezing drizzle'], 57: ['🌧', 'freezing drizzle'],
  61: ['🌦', 'light rain'], 63: ['🌧', 'rain'], 65: ['🌧', 'heavy rain'],
  66: ['🌧', 'freezing rain'], 67: ['🌧', 'freezing rain'],
  71: ['🌨', 'light snow'], 73: ['🌨', 'snow'], 75: ['❄️', 'heavy snow'],
  77: ['🌨', 'snow grains'],
  80: ['🌦', 'rain showers'], 81: ['🌦', 'rain showers'], 82: ['🌧', 'violent showers'],
  85: ['🌨', 'snow showers'], 86: ['🌨', 'heavy snow showers'],
  95: ['⛈', 'thunderstorm'], 96: ['⛈', 'thunder + hail'], 99: ['⛈', 'thunder + hail'],
};

let weatherCache = null;
let weatherFetchedAt = 0;
/** @type {HTMLElement|null} */
let rootEl = null;
let tickTimer = null;
let expanded = false;

async function loadWeather() {
  const now = Date.now();
  if (weatherCache && (now - weatherFetchedAt) < WEATHER_TTL_MS) return weatherCache;
  try {
    const { fetchWithTimeout } = await import('./util/fetchWithTimeout.ts');
    const r = await fetchWithTimeout('/weather', { timeoutMs: 10_000 });
    weatherCache = await r.json();
    weatherFetchedAt = now;
  } catch (e) {
    log('ambient weather fetch failed:', e.message);
    weatherCache = null;
  }
  return weatherCache;
}

export function init() {
  if (rootEl) return;
  rootEl = document.createElement('div');
  rootEl.className = 'ambient-widget';
  rootEl.addEventListener('click', () => {
    expanded = !expanded;
    render();
  });
  document.body.appendChild(rootEl);
  render();
  tickTimer = setInterval(render, 60_000);
}

async function render() {
  if (!rootEl) return;
  rootEl.classList.toggle('expanded', expanded);
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const w = await loadWeather();
  if (!rootEl) return;  // disposed during fetch
  rootEl.innerHTML = expanded
    ? renderExpanded(hh, mm, now, w)
    : renderCompact(hh, mm, w);
}

function renderCompact(hh, mm, w) {
  const code = w?.current?.weather_code;
  const [icon] = code != null ? (WMO[code] || ['', '']) : ['', ''];
  const temp = w?.current?.temperature_2m;
  const tempStr = temp != null ? `${Math.round(temp)}°` : '';
  const weatherHtml = icon || tempStr
    ? `<span class="ambient-weather">${icon}<span class="ambient-temp">${escapeHtml(tempStr)}</span></span>`
    : '';
  return `<span class="ambient-time">${hh}:${mm}</span>${weatherHtml}`;
}

function renderExpanded(hh, mm, dateObj, w) {
  const dateStr = dateObj.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const cur = w?.current;
  const daily = w?.daily;
  const code = cur?.weather_code;
  const [icon, desc] = code != null ? (WMO[code] || ['❔', 'weather']) : ['❔', 'weather'];
  const temp = cur?.temperature_2m != null ? Math.round(cur.temperature_2m) : null;
  const hi = daily?.temperature_2m_max?.[0] != null ? Math.round(daily.temperature_2m_max[0]) : null;
  const lo = daily?.temperature_2m_min?.[0] != null ? Math.round(daily.temperature_2m_min[0]) : null;

  const currentRow = temp != null ? `
    <div class="amb-current">
      <span class="amb-icon">${icon}</span>
      <div class="amb-cur-meta">
        <div class="amb-cur-temp">${temp}°</div>
        <div class="amb-cur-desc">${escapeHtml(desc)}${hi != null && lo != null ? ` · h${hi}° l${lo}°` : ''}</div>
      </div>
    </div>` : '';

  // Forecast strip — tomorrow onwards. /weather returns 4 days total,
  // so we slice [1..4).
  let forecastHtml = '';
  if (daily?.time?.length > 1) {
    const rows = [];
    for (let i = 1; i < Math.min(daily.time.length, 4); i++) {
      const d = new Date(daily.time[i] + 'T00:00');
      const wd = d.toLocaleDateString(undefined, { weekday: 'short' });
      const [fi] = WMO[daily.weather_code?.[i]] || ['❔', ''];
      const fhi = daily.temperature_2m_max?.[i] != null ? Math.round(daily.temperature_2m_max[i]) : '—';
      const flo = daily.temperature_2m_min?.[i] != null ? Math.round(daily.temperature_2m_min[i]) : '—';
      rows.push(`
        <div class="amb-forecast-row">
          <span class="amb-fc-day">${escapeHtml(wd)}</span>
          <span class="amb-fc-icon">${fi}</span>
          <span class="amb-fc-temps">${fhi}° <span class="amb-fc-lo">${flo}°</span></span>
        </div>`);
    }
    forecastHtml = `<div class="amb-forecast">${rows.join('')}</div>`;
  }

  return `
    <div class="amb-clock">${hh}:${mm}</div>
    <div class="amb-date">${escapeHtml(dateStr)}</div>
    ${currentRow}
    ${forecastHtml}
  `;
}

export function dispose() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  if (rootEl) { rootEl.remove(); rootEl = null; }
}

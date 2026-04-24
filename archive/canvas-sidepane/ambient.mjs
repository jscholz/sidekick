/**
 * @fileoverview Ambient card — clock + weather + brand mark.
 */

import { escapeHtml } from '../util/dom.mjs';

let weatherCache = null;
let weatherFetchedAt = 0;
const WEATHER_TTL_MS = 15 * 60 * 1000;

const WMO_ICON = {
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

async function loadWeather() {
  const now = Date.now();
  if (weatherCache && (now - weatherFetchedAt) < WEATHER_TTL_MS) return weatherCache;
  try {
    const r = await fetch('/weather');
    weatherCache = await r.json();
    weatherFetchedAt = now;
  } catch { weatherCache = null; }
  return weatherCache;
}

/** @returns {HTMLElement} */
export function render() {
  const root = document.createElement('div');
  root.className = 'card-ambient';
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const dateStr = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  root.innerHTML = `
    <div class="clock">${hh}:${mm}</div>
    <div class="date">${escapeHtml(dateStr)}</div>
    <div class="weather" id="ambient-weather"><div class="icon">…</div><div class="meta"><div class="temp">—</div><div class="desc">loading weather</div></div></div>
    <div class="brand-mark"><img src="/assets/icon.png" alt=""></div>`;

  loadWeather().then(w => {
    const box = root.querySelector('#ambient-weather');
    if (!box) return;
    if (!w?.current) {
      box.innerHTML = `<div class="icon">⚠️</div><div class="meta"><div class="temp">—</div><div class="desc">weather unavailable</div></div>`;
      return;
    }
    const [icon, desc] = WMO_ICON[w.current.weather_code] || ['❔', 'weather'];
    const temp = Math.round(w.current.temperature_2m);
    const hi = Math.round(w.daily?.temperature_2m_max?.[0] ?? temp);
    const lo = Math.round(w.daily?.temperature_2m_min?.[0] ?? temp);
    box.innerHTML = `
      <div class="icon">${icon}</div>
      <div class="meta">
        <div class="temp">${temp}°</div>
        <div class="desc">${escapeHtml(desc)} · h${hi}° l${lo}°</div>
      </div>`;
  });

  return root;
}

/**
 * @fileoverview Agent-declared settings panel — generic renderer for
 * the optional /v1/settings/* contract documented in
 * docs/ABSTRACT_AGENT_PROTOCOL.md.
 *
 * The agent declares a SettingDef[] (model, persona, temperature, ...);
 * we render each to a settings-panel row by `type`. Updates POST back
 * to /api/sidekick/settings/{id} via the backend adapter; the response
 * (the updated def) replaces the local copy. On error, we revert the
 * input to the previous value so a rejection is visible.
 *
 * Sidekick-owned settings (theme, hotkeys, mic, TTS) stay in their
 * original groups; this module only renders rows the agent declares.
 *
 * Refresh policy: load() on settings-panel open AND close — the panel
 * is the only UI surface that mutates these, so re-fetching on close
 * surfaces drift caused by parallel clients (CLI, another PWA tab,
 * a sibling agent) without a live SSE channel.
 */

import * as backend from './backend.ts';

export interface AgentSettingOption {
  value: string;
  label: string;
  description?: string;
}

export interface AgentSettingDef {
  id: string;
  label: string;
  description?: string;
  category?: string;
  type: 'enum' | 'slider' | 'toggle' | 'text' | 'string-list';
  value: string | number | boolean | string[];
  options?: AgentSettingOption[];
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
}

let lastSchema: AgentSettingDef[] = [];

/** Strip rows we previously injected. Match by data-agent-setting
 *  attr so we never touch hand-authored markup or the static
 *  placeholder (which uses data-agent-setting-placeholder — kept
 *  visible until a SUCCESSFUL schema response arrives). */
function clearInjectedRows(host: HTMLElement) {
  for (const el of Array.from(host.querySelectorAll('[data-agent-setting]'))) {
    el.remove();
  }
}

/** Remove the static `<div data-agent-setting-placeholder>` markup
 *  that ships in index.html. Only called on a successful schema
 *  response — null/error responses leave the placeholder visible so
 *  the user sees "Loading…" instead of an empty group (a transient
 *  upstream outage shouldn't make the picker silently disappear). */
function clearPlaceholderRows(host: HTMLElement) {
  for (const el of Array.from(host.querySelectorAll('[data-agent-setting-placeholder]'))) {
    el.remove();
  }
}

/** Render one SettingDef into a `.row` element. Returns null when the
 *  type is unknown so the caller can skip silently — forks may declare
 *  new types we don't render here (no harm done; they just don't show). */
function renderRow(def: AgentSettingDef): HTMLElement | null {
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.agentSetting = def.id;

  const label = document.createElement('label');
  label.textContent = def.label;
  label.htmlFor = `agent-set-${def.id}`;
  row.appendChild(label);

  let input: HTMLElement | null = null;

  switch (def.type) {
    case 'enum': {
      const sel = document.createElement('select');
      sel.id = `agent-set-${def.id}`;
      for (const opt of def.options ?? []) {
        const o = document.createElement('option');
        o.value = String(opt.value);
        o.textContent = opt.label;
        if (opt.description) o.title = opt.description;
        sel.appendChild(o);
      }
      sel.value = String(def.value ?? '');
      sel.onchange = () => onSubmit(def, sel.value, sel);
      input = sel;
      break;
    }
    case 'toggle': {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = `agent-set-${def.id}`;
      cb.checked = !!def.value;
      cb.onchange = () => onSubmit(def, cb.checked, cb);
      input = cb;
      break;
    }
    case 'slider': {
      const wrap = document.createElement('div');
      wrap.style.display = 'contents';
      const range = document.createElement('input');
      range.type = 'range';
      range.id = `agent-set-${def.id}`;
      range.min = String(def.min ?? 0);
      range.max = String(def.max ?? 100);
      range.step = String(def.step ?? 1);
      range.value = String(def.value ?? def.min ?? 0);
      const valSpan = document.createElement('span');
      valSpan.className = 'val';
      valSpan.textContent = String(range.value);
      range.oninput = () => { valSpan.textContent = range.value; };
      // Commit on `change` (release), not `input` — slider drag would
      // POST per-frame otherwise. Each release = one POST.
      range.onchange = () => onSubmit(def, Number(range.value), range);
      wrap.appendChild(range);
      wrap.appendChild(valSpan);
      input = wrap;
      break;
    }
    case 'text': {
      const txt = document.createElement('input');
      txt.type = 'text';
      txt.id = `agent-set-${def.id}`;
      txt.value = String(def.value ?? '');
      if (def.placeholder) txt.placeholder = def.placeholder;
      // Commit on blur or Enter — typing every keystroke would POST
      // per-character.
      const commit = () => onSubmit(def, txt.value, txt);
      txt.onblur = commit;
      txt.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); txt.blur(); } };
      input = txt;
      break;
    }
    case 'string-list': {
      // Chip-list editor: each entry renders as a removable chip;
      // Enter or comma in the input commits a new entry. POSTs the
      // entire updated list to the agent on each add/remove (full
      // replacement; the contract doesn't have a partial-update
      // shape and the lists are small enough to round-trip whole).
      // Returns a `display: contents` wrapper so the chips + input
      // share row layout with the label.
      row.classList.add('row-wide');
      const wrap = document.createElement('div');
      wrap.style.display = 'contents';
      const chips = document.createElement('div');
      chips.className = 'keyterms-chips';
      chips.setAttribute('aria-label', def.label);
      const txt = document.createElement('input');
      txt.type = 'text';
      txt.id = `agent-set-${def.id}`;
      txt.autocomplete = 'off';
      txt.spellcheck = false;
      if (def.placeholder) txt.placeholder = def.placeholder;
      const renderChips = () => {
        chips.innerHTML = '';
        const list = Array.isArray(def.value) ? def.value as string[] : [];
        for (const term of list) {
          const chip = document.createElement('span');
          chip.className = 'kt-chip';
          chip.textContent = term;
          const x = document.createElement('button');
          x.className = 'kt-chip-x';
          x.type = 'button';
          x.setAttribute('aria-label', `remove ${term}`);
          x.textContent = '×';
          x.onclick = () => {
            const next = (def.value as string[]).filter((t) => t !== term);
            void onSubmit(def, next, chips, renderChips);
          };
          chip.appendChild(x);
          chips.appendChild(chip);
        }
      };
      renderChips();
      txt.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ',') {
          e.preventDefault();
          const term = txt.value.trim();
          if (!term) return;
          const list = Array.isArray(def.value) ? def.value as string[] : [];
          if (list.includes(term)) { txt.value = ''; return; }
          const next = [...list, term];
          txt.value = '';
          void onSubmit(def, next, chips, renderChips);
        }
      };
      wrap.appendChild(chips);
      wrap.appendChild(txt);
      input = wrap;
      break;
    }
    default:
      return null;
  }

  row.appendChild(input);

  if (def.description) {
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = def.description;
    row.appendChild(hint);
  }
  return row;
}

/** POST the new value to the agent. Optimistic — the caller already
 *  updated the input by user action — so on error we revert via the
 *  inputEl's display refresh, and surface the agent's message via
 *  window.alert (settings-panel-only; drives users back to a valid
 *  value). For chip-list rows, the caller passes a `refresh` callback
 *  that re-renders the chip strip (since the chips container isn't
 *  a primitive input syncInputToValue can drive). */
async function onSubmit(
  def: AgentSettingDef,
  value: unknown,
  inputEl: HTMLElement,
  refresh?: () => void,
) {
  const prev = def.value;
  try {
    const adapter: any = (backend as any).adapter ?? await getAdapter();
    if (!adapter?.updateSetting) {
      throw new Error('agent settings not supported by this backend');
    }
    const updated: AgentSettingDef = await adapter.updateSetting(def.id, value);
    // Replace our cached copy with the agent's response (lets the
    // agent normalize — e.g. trim whitespace, lower-case, snap-to-step).
    Object.assign(def, updated);
    // Re-sync the input in case the agent normalized.
    syncInputToValue(inputEl, def);
    refresh?.();
  } catch (e: any) {
    // Revert.
    syncInputToValue(inputEl, { ...def, value: prev });
    // For chip-list, restore the previous list before re-rendering.
    if (refresh) {
      def.value = prev;
      refresh();
    }
    // Surface the agent's rejection message — this only fires from
    // settings-panel interactions so window.alert is acceptable; a
    // toast would be nicer when the toast util lands.
    try { window.alert(`Couldn't update ${def.label}: ${e?.message ?? e}`); } catch {}
  }
}

function syncInputToValue(inputEl: HTMLElement, def: AgentSettingDef) {
  if (inputEl instanceof HTMLSelectElement) inputEl.value = String(def.value ?? '');
  else if (inputEl instanceof HTMLInputElement) {
    if (inputEl.type === 'checkbox') inputEl.checked = !!def.value;
    else inputEl.value = String(def.value ?? '');
  }
  // string-list rows pass a non-input wrapper as inputEl; the
  // refresh() callback in onSubmit owns their re-render.
}

/** Fetch the adapter via backend.ts internals. backend.ts proxies most
 *  methods but doesn't yet expose getSettingsSchema/updateSetting; this
 *  reaches the live adapter so we don't need to add a wrapper for each. */
async function getAdapter(): Promise<any> {
  // backend.ts's loadAdapter returns the configured adapter. We import
  // the proxy-client directly because that's the only adapter wired in
  // post-refactor.
  const mod: any = await import('./proxyClient.ts');
  return mod.proxyClientAdapter;
}

/** Render the agent-settings rows into the "Agent" group. Idempotent:
 *  re-runs replace previously-injected rows without touching static
 *  markup (the group label, the Preferred-models chip input). */
export async function load() {
  const host = document.getElementById('settings-group-agent');
  if (!host) return;
  const adapter: any = await getAdapter();
  if (!adapter?.getSettingsSchema) {
    // Adapter doesn't implement the extension — leave placeholder +
    // hand-authored rows untouched.
    return;
  }
  let schema: AgentSettingDef[] | null;
  try {
    schema = await adapter.getSettingsSchema();
  } catch {
    // Treat fetch errors as "leave-as-is" so a transient outage doesn't
    // strip a previously-rendered picker. Next panel-open retries.
    return;
  }
  if (schema === null) {
    // Agent doesn't implement /v1/settings/* (404). Leave placeholder
    // + previously-injected rows alone — same rationale as the error
    // case. If the user wants to see "no settings" we'd need a
    // dedicated empty-state row; not worth the complexity yet.
    return;
  }
  // Successful response → drop placeholder + previously-injected
  // rows, then render fresh. Empty array is a valid success: it
  // means "agent supports settings but currently exposes none."
  clearPlaceholderRows(host);
  clearInjectedRows(host);
  if (schema.length === 0) {
    lastSchema = [];
    return;
  }
  lastSchema = schema;
  // Insert AFTER the group label, BEFORE the static rows (preferred-
  // models chip input). Group-label is the first child by convention.
  const anchor = host.querySelector('.group-label') as HTMLElement | null;
  for (const def of schema) {
    const row = renderRow(def);
    if (!row) continue;
    if (anchor && anchor.nextSibling) {
      host.insertBefore(row, anchor.nextSibling);
    } else {
      host.appendChild(row);
    }
  }
}

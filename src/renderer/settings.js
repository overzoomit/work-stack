// Settings… (⋯ menu, macOS app menu and Ctrl/⌘+,): the credentials Work uses
// for the external services (backend: settings.rs). The keys are secrets:
// they are written to a file only the user can read, never to the app state.
import { $, esc, toast, toastError, leave } from './ui.js';

const { work } = window;

export const DEFAULT_BASE_URL = 'https://plane.overzoom.it';
export const DEFAULT_WORKSPACE = 'overzoom';

let sheet = null;
let back = null; // what had the focus before the dialog
let busy = null; // 'save' | 'test'

const q = (sel) => sheet.querySelector(sel);
const value = (root, sel) => root.querySelector(sel).value ?? '';

// KEY=value per line: comments and malformed lines are ignored, so the saved
// environment never contains something the shell could not export.
export function parseEnv(text) {
  const env = {};
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

export function formatEnv(env) {
  return Object.entries(env || {}).map(([k, v]) => `${k}=${v}`).join('\n');
}

// What the form sends to settings_save: the same shape as AppSettings.
export function settingsFrom(root) {
  return {
    plane_api_key: value(root, '.st-plane-key'),
    plane_base_url: value(root, '.st-plane-url'),
    plane_workspace: value(root, '.st-plane-ws'),
    jev_api_key: value(root, '.st-jev-key'),
    jev_endpoint: value(root, '.st-jev-url'),
    custom_env: parseEnv(value(root, '.st-env')),
  };
}

export function fillSettings(root, s = {}) {
  root.querySelector('.st-plane-url').value = s.plane_base_url || DEFAULT_BASE_URL;
  root.querySelector('.st-plane-ws').value = s.plane_workspace || DEFAULT_WORKSPACE;
  const planeKey = root.querySelector('.st-plane-key');
  planeKey.value = s.plane_api_key || '';
  planeKey.type = 'password'; // a loaded key is masked again
  const jevKey = root.querySelector('.st-jev-key');
  jevKey.value = s.jev_api_key || '';
  jevKey.type = 'password';
  root.querySelector('.st-jev-url').value = s.jev_endpoint || '';
  root.querySelector('.st-env').value = formatEnv(s.custom_env);
}

function showTab(name) {
  if (!sheet) return;
  for (const b of ['.st-tab-plane', '.st-tab-jev', '.st-tab-env', '.st-tab-backup']) {
    q(b)?.classList.toggle('active', b === `.st-tab-${name}`);
  }
  for (const p of ['.st-panel-plane', '.st-panel-jev', '.st-panel-env', '.st-panel-backup']) {
    const el = q(p);
    if (el) el.hidden = p !== `.st-panel-${name}`;
  }
}

function reveal(which) {
  if (!sheet) return;
  const input = q(which === 'plane' ? '.st-plane-key' : '.st-jev-key');
  const shown = input.type === 'text';
  input.type = shown ? 'password' : 'text';
  const button = q(which === 'plane' ? '.st-eye-plane' : '.st-eye-jev');
  button.textContent = shown ? '👁' : '🙈';
  button.setAttribute('aria-label', shown ? 'Show key' : 'Hide key');
}

function setResult(text, error = false) {
  if (!sheet) return;
  const result = q('.st-result');
  result.textContent = text;
  result.classList.toggle('error', !!error);
}

async function testConnection() {
  if (!sheet || busy) return;
  const s = settingsFrom(sheet);
  const button = q('.st-test');
  busy = 'test';
  button.disabled = true;
  button.textContent = 'Testing…';
  setResult('');
  try {
    const base = s.plane_base_url.trim() || DEFAULT_BASE_URL;
    const workspace = s.plane_workspace.trim() || DEFAULT_WORKSPACE;
    setResult(await work.settings.testPlane(base, s.plane_api_key, workspace));
  } catch (e) {
    setResult(e?.message ?? String(e), true);
  } finally {
    busy = null;
    if (sheet) {
      button.disabled = false;
      button.textContent = 'Test connection';
    }
  }
}

async function save() {
  if (!sheet || busy) return;
  const button = q('.st-save');
  busy = 'save';
  button.disabled = true;
  button.textContent = 'Saving…';
  try {
    const saved = await work.settings.save(settingsFrom(sheet));
    toast('Settings saved');
    // The backend may have filled in defaults: show what was actually saved.
    if (sheet) fillSettings(sheet, saved);
    closeSettingsDialog();
  } catch (e) {
    toastError(e);
  } finally {
    busy = null;
    if (sheet) {
      button.disabled = false;
      button.textContent = 'Save';
    }
  }
}

async function exportConfig() {
  if (!sheet) return;
  try {
    const bundleText = await work.settings.exportConfig();
    const blob = new Blob([bundleText], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `work-config-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Configuration exported successfully');
  } catch (e) {
    toastError(e);
  }
}

async function importConfigFile(input) {
  const file = input.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const updated = await work.settings.importConfig(text);
    if (sheet) fillSettings(sheet, updated);
    toast('Configuration imported successfully!');
  } catch (e) {
    toastError(e);
  } finally {
    input.value = '';
  }
}

const acts = {
  close: () => closeSettingsDialog(),
  cancel: () => closeSettingsDialog(),
  save: () => save(),
  test: () => testConnection(),
  export: () => exportConfig(),
  reveal: ({ target }) => reveal(target),
  tab: ({ tab }) => showTab(tab),
};

function onClick(e) {
  const b = e.target.closest('[data-act]');
  if (b && !b.disabled) acts[b.dataset.act]?.(b.dataset);
}

// Esc closes the dialog, unless the confirm modal above it is asking.
function onKey(e) {
  if (e.key !== 'Escape' || !$('#modal').hidden) return;
  e.preventDefault();
  e.stopPropagation();
  closeSettingsDialog();
}

export function closeSettingsDialog() {
  if (!sheet) return;
  const el = sheet;
  sheet = null;
  removeEventListener('keydown', onKey, true);
  leave(el, () => el.remove());
  back?.focus?.();
}

export async function openSettingsDialog() {
  if (sheet) return;
  back = document.activeElement;
  sheet = document.createElement('div');
  sheet.className = 'sheet settings-sheet';
  sheet.innerHTML = `
    <div class="modal-card settings-card" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header class="st-head">
        <div>
          <h3 id="settings-title">Settings</h3>
          <p class="st-sub">API keys for the services Work and its agents use. Saved in a file readable by you only.</p>
        </div>
        <button class="icon-btn" data-act="close" title="Close (Esc)" aria-label="Close">✕</button>
      </header>
      <nav class="st-tabs" aria-label="Settings sections">
        <button type="button" class="st-tab st-tab-plane active" data-act="tab" data-tab="plane">✈️ Plane</button>
        <button type="button" class="st-tab st-tab-jev" data-act="tab" data-tab="jev">⚡ Jev</button>
        <button type="button" class="st-tab st-tab-env" data-act="tab" data-tab="env">Environment</button>
        <button type="button" class="st-tab st-tab-backup" data-act="tab" data-tab="backup">📦 Portability</button>
      </nav>
      <form class="st-form" autocomplete="off">
        <section class="st-panel st-panel-plane">
          <label class="st-field">
            <span>Server URL</span>
            <input class="st-plane-url" spellcheck="false" placeholder="${DEFAULT_BASE_URL}">
          </label>
          <label class="st-field">
            <span>Workspace slug</span>
            <input class="st-plane-ws" spellcheck="false" placeholder="${DEFAULT_WORKSPACE}">
          </label>
          <label class="st-field">
            <span>API key</span>
            <span class="st-secret">
              <input class="st-plane-key" type="password" spellcheck="false" autocomplete="new-password">
              <button type="button" class="st-eye st-eye-plane" data-act="reveal" data-target="plane" title="Show key" aria-label="Show key">👁</button>
            </span>
          </label>
          <div class="st-test-row">
            <button type="button" class="btn st-test" data-act="test">Test connection</button>
            <span class="st-result" role="status"></span>
          </div>
        </section>
        <section class="st-panel st-panel-jev" hidden>
          <label class="st-field">
            <span>Jev API key</span>
            <span class="st-secret">
              <input class="st-jev-key" type="password" spellcheck="false" autocomplete="new-password">
              <button type="button" class="st-eye st-eye-jev" data-act="reveal" data-target="jev" title="Show key" aria-label="Show key">👁</button>
            </span>
          </label>
          <label class="st-field">
            <span>Endpoint</span>
            <input class="st-jev-url" spellcheck="false" placeholder="https://…">
          </label>
          <p class="st-note">Leave the endpoint empty to use the default one.</p>
        </section>
        <section class="st-panel st-panel-env" hidden>
          <label class="st-field">
            <span>Environment variables</span>
            <textarea class="st-env" spellcheck="false" rows="8" placeholder="OPENAI_API_KEY=sk-…"></textarea>
          </label>
          <p class="st-note">One <code>KEY=value</code> per line. Comments with <code>#</code> are ignored.</p>
        </section>
        <section class="st-panel st-panel-backup" hidden>
          <p class="st-note">Export or import credentials, settings and project references to migrate Work Stack to another machine.</p>
          <div style="display:flex;gap:10px;margin-top:12px;align-items:center;">
            <button type="button" class="btn" data-act="export">📥 Export Configuration</button>
            <label class="btn" style="cursor:pointer;display:inline-flex;align-items:center;">
              📤 Import Configuration
              <input type="file" accept=".json,application/json" class="st-import-file" style="display:none">
            </label>
          </div>
        </section>
      </form>
      <footer class="st-foot">
        <button type="button" class="btn" data-act="cancel">Cancel</button>
        <button type="button" class="btn btn-accent st-save" data-act="save">Save</button>
      </footer>
    </div>`;
  document.body.appendChild(sheet);
  sheet.onpointerdown = (e) => {
    if (e.target === sheet) closeSettingsDialog();
  };
  sheet.onclick = onClick;
  const importInput = sheet.querySelector('.st-import-file');
  if (importInput) {
    importInput.onchange = () => importConfigFile(importInput);
  }
  sheet.querySelector('.st-form').onsubmit = (e) => {
    e.preventDefault();
    save();
  };
  addEventListener('keydown', onKey, true);
  fillSettings(sheet);
  sheet.querySelector('.st-plane-key').focus();
  try {
    const saved = await work.settings.get();
    if (sheet) fillSettings(sheet, saved);
  } catch (e) {
    toastError(e);
  }
}

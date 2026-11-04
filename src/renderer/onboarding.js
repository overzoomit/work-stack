// First-run Onboarding Wizard: launched when Work Stack starts on a new machine
// or when no Plane/Jev credentials are configured yet.
import { $, esc, toast, toastError, leave } from './ui.js';
import { DEFAULT_BASE_URL, DEFAULT_WORKSPACE } from './settings.js';

const { work } = window;

let wizardEl = null;
let busy = false;

function setResult(text, isError = false) {
  if (!wizardEl) return;
  const el = wizardEl.querySelector('.ob-result');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('error', !!isError);
}

async function testConnection() {
  if (!wizardEl || busy) return;
  const btn = wizardEl.querySelector('.ob-test');
  const keyInput = wizardEl.querySelector('.ob-plane-key');
  const urlInput = wizardEl.querySelector('.ob-plane-url');
  const wsInput = wizardEl.querySelector('.ob-plane-ws');

  const apiKey = keyInput?.value?.trim() || '';
  const baseUrl = urlInput?.value?.trim() || DEFAULT_BASE_URL;
  const workspace = wsInput?.value?.trim() || DEFAULT_WORKSPACE;

  if (!apiKey) {
    setResult('Enter a Plane API key first', true);
    return;
  }

  busy = true;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Testing…';
  }
  setResult('');

  try {
    const res = await work.settings.testPlane(baseUrl, apiKey, workspace);
    setResult(res || 'Connected!');
  } catch (err) {
    setResult(err?.message || String(err), true);
  } finally {
    busy = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Test connection';
    }
  }
}

async function handleImport(input, onDone) {
  const file = input?.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    await work.settings.importConfig(text);
    toast('Configuration imported successfully!');
    closeOnboarding();
    onDone?.();
  } catch (err) {
    toastError(err);
  } finally {
    if (input) input.value = '';
  }
}

async function handleSave(onDone) {
  if (!wizardEl || busy) return;
  const saveBtn = wizardEl.querySelector('.ob-save');
  const keyInput = wizardEl.querySelector('.ob-plane-key');
  const urlInput = wizardEl.querySelector('.ob-plane-url');
  const wsInput = wizardEl.querySelector('.ob-plane-ws');
  const jevInput = wizardEl.querySelector('.ob-jev-key');
  const tgInput = wizardEl.querySelector('.ob-tg-token');

  const planeKey = keyInput?.value?.trim() || '';
  const planeUrl = urlInput?.value?.trim() || DEFAULT_BASE_URL;
  const planeWs = wsInput?.value?.trim() || DEFAULT_WORKSPACE;
  const jevKey = jevInput?.value?.trim() || '';
  const tgToken = tgInput?.value?.trim() || '';

  busy = true;
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
  }

  try {
    await work.settings.save({
      plane_api_key: planeKey,
      plane_base_url: planeUrl,
      plane_workspace: planeWs,
      jev_api_key: jevKey,
      jev_endpoint: '',
      custom_env: {},
    });

    if (tgToken) {
      try {
        await work.telegram.connect(tgToken);
      } catch (tgErr) {
        console.warn('Telegram connect skipped or failed:', tgErr);
      }
    }

    toast('Welcome to Work Stack!');
    closeOnboarding();
    onDone?.();
  } catch (err) {
    toastError(err);
  } finally {
    busy = false;
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save and start working';
    }
  }
}

export function closeOnboarding() {
  if (!wizardEl) return;
  const el = wizardEl;
  wizardEl = null;
  leave(el, () => el.remove());
}

export function openOnboardingWizard({ onDone = null } = {}) {
  if (wizardEl) return;

  wizardEl = document.createElement('div');
  wizardEl.className = 'sheet settings-sheet';
  wizardEl.innerHTML = `
    <div class="modal-card settings-card" role="dialog" aria-modal="true" aria-labelledby="ob-title" style="width: min(580px, calc(100vw - 32px));">
      <header class="st-head" style="padding-bottom: 6px;">
        <div>
          <h3 id="ob-title" style="font-size: 16px;">🚀 Welcome to Work Stack</h3>
          <p class="st-sub">Set up your environment in seconds. You can import existing settings or connect your services.</p>
        </div>
        <button class="icon-btn ob-skip" title="Skip for now" aria-label="Close">✕</button>
      </header>

      <div style="padding: 10px 18px 0;">
        <div style="background: rgba(10, 132, 255, 0.08); border: 1px dashed var(--accent); border-radius: 8px; padding: 12px 14px; display: flex; align-items: center; justify-content: space-between; gap: 10px;">
          <div>
            <div style="font-weight: 600; font-size: 12px; color: var(--text);">Moving from another machine?</div>
            <div style="font-size: 11px; color: var(--muted);">Import your backup to restore Plane, Jev, Telegram and projects.</div>
          </div>
          <label class="btn btn-accent" style="cursor: pointer; display: inline-flex; align-items: center; font-size: 11px; padding: 5px 12px;">
            📥 Import Backup
            <input type="file" accept=".json,application/json" class="ob-import-file" style="display: none;">
          </label>
        </div>
      </div>

      <form class="st-form ob-form" autocomplete="off" style="margin-top: 6px;">
        <div style="font-weight: 600; font-size: 12px; margin-bottom: 8px; color: var(--text);">Or configure credentials:</div>
        
        <label class="st-field">
          <span>Plane Server URL</span>
          <input class="ob-plane-url" spellcheck="false" value="${DEFAULT_BASE_URL}">
        </label>
        <label class="st-field">
          <span>Plane Workspace</span>
          <input class="ob-plane-ws" spellcheck="false" value="${DEFAULT_WORKSPACE}">
        </label>
        <label class="st-field">
          <span>Plane API Key</span>
          <input class="ob-plane-key" type="password" spellcheck="false" placeholder="plane_api_…" autocomplete="new-password">
        </label>
        <div class="st-test-row" style="margin-top: -4px;">
          <button type="button" class="btn ob-test" style="font-size: 11px; padding: 3px 8px;">Test connection</button>
          <span class="st-result ob-result" role="status"></span>
        </div>

        <label class="st-field" style="margin-top: 6px;">
          <span>Jev / Typesafe API Key (AI model routing)</span>
          <input class="ob-jev-key" type="password" spellcheck="false" placeholder="Optional — for automated model & effort selection" autocomplete="new-password">
        </label>

        <label class="st-field">
          <span>Telegram Bot Token (Remote PM chat)</span>
          <input class="ob-tg-token" type="password" spellcheck="false" placeholder="Optional — 123456:ABC-DEF…" autocomplete="new-password">
        </label>
      </form>

      <footer class="st-foot">
        <button type="button" class="btn ob-skip">Skip for now</button>
        <button type="button" class="btn btn-accent ob-save">Save and start working</button>
      </footer>
    </div>`;

  document.body.appendChild(wizardEl);

  const importInput = wizardEl.querySelector('.ob-import-file');
  if (importInput) {
    importInput.onchange = () => handleImport(importInput, onDone);
  }

  wizardEl.querySelector('.ob-test')?.addEventListener('click', testConnection);
  wizardEl.querySelector('.ob-save')?.addEventListener('click', () => handleSave(onDone));
  wizardEl.querySelectorAll('.ob-skip').forEach((b) => b.addEventListener('click', closeOnboarding));

  wizardEl.querySelector('.ob-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    handleSave(onDone);
  });
}

export async function checkOnboarding({ onDone = null } = {}) {
  try {
    const configured = await work.settings.isConfigured();
    if (!configured) {
      openOnboardingWizard({ onDone });
    }
  } catch (err) {
    console.warn('checkOnboarding error:', err);
  }
}

// ngrok Tunnel… (Run menu, the tunnel chip in the Run bar): exposes a local
// port of the project on a public URL through the ngrok CLI (backend:
// ngrok.rs). The last port, protocol and domain used are kept in the
// project's run settings (p.run.ngrok), saved with the project.
import { esc, toast, toastError, leave } from './ui.js';

const { work } = window;

const PROTOCOLS = [['http', 'HTTP'], ['tcp', 'TCP'], ['tls', 'TLS']];

let hooks = { save() {}, changed() {}, suggestPort: () => null };
let sheet = null;
let back = null; // what had the focus before the dialog
let project = null;
const busy = new Map(); // project -> 'start' | 'stop'

export const prefsOf = (p) => ({ port: null, protocol: 'http', domain: '', ...p.run?.ngrok });
const browsable = (url) => /^https?:\/\//.test(url || '');
const q = (s) => sheet.querySelector(s);

export function initNgrok(opts) {
  hooks = { ...hooks, ...opts };
}

// A tunnel that closed on its own (session ended, agent killed) says why, once.
export async function refreshTunnel(p) {
  const was = p.tunnel?.active;
  try {
    p.tunnel = await work.ngrok.status(p.path);
  } catch {
    p.tunnel = null;
  }
  if (was && !p.tunnel?.active && p.tunnel?.error) toast(`ngrok tunnel closed: ${p.tunnel.error}`, { error: true });
  if (p === project) render();
  return p.tunnel;
}

function copy(url, action = null) {
  work.app.copy(url);
  toast(`Copied ${url}`, { action });
}

export function copyTunnelUrl(p) {
  const url = p.tunnel?.public_url;
  if (url) copy(url, { label: 'Manage', run: () => openNgrokPanel(p) });
}

function render() {
  if (!sheet) return;
  const t = project.tunnel;
  const on = !!t?.active;
  const now = busy.get(project);
  if (on) {
    q('.ng-port').value = String(t.port ?? '');
    q('.ng-proto').value = t.protocol || 'http';
    q('.ng-domain').value = t.domain || '';
  }
  for (const s of ['.ng-port', '.ng-proto', '.ng-domain']) q(s).disabled = on || !!now;
  const toggle = q('.ng-toggle');
  toggle.disabled = !!now;
  toggle.className = `btn ng-toggle ${on ? 'btn-danger' : 'btn-accent'}${now ? ' loading' : ''}`;
  toggle.textContent = now === 'start' ? 'Starting…' : now === 'stop' ? 'Stopping…' : on ? 'Stop' : 'Start';
  q('.ng-live').hidden = !on;
  if (!on) return;
  q('.ng-public').textContent = t.public_url;
  q('[data-act="open"]').hidden = !browsable(t.public_url);
  q('.ng-inspect').hidden = !t.inspect_url;
  q('.ng-inspect').textContent = `Inspect traffic · ${(t.inspect_url || '').replace(/^https?:\/\//, '')} ↗`;
}

// The project is captured: the dialog may close, or show another one, meanwhile.
async function act(p, what, fn) {
  busy.set(p, what);
  render();
  try {
    await fn();
  } catch (e) {
    toastError(e);
  } finally {
    busy.delete(p);
    render();
    hooks.changed();
  }
}

async function toggleTunnel() {
  const p = project;
  if (!sheet || busy.has(p)) return;
  if (p.tunnel?.active) {
    return act(p, 'stop', async () => {
      p.tunnel = await work.ngrok.stop(p.path);
      toast('ngrok tunnel closed');
    });
  }
  const port = Number(q('.ng-port').value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return toastError('Enter a local port between 1 and 65535');
  const protocol = q('.ng-proto').value;
  const domain = q('.ng-domain').value.trim();
  p.run.ngrok = { port, protocol, domain };
  hooks.save();
  return act(p, 'start', async () => {
    p.tunnel = await work.ngrok.start(p.path, port, protocol, domain || null);
    if (p.tunnel?.active) toast(`Tunnel open: ${p.tunnel.public_url}`);
  });
}

const acts = {
  close: () => closeNgrokPanel(),
  copy: () => project.tunnel?.public_url && copy(project.tunnel.public_url),
  open: () => project.tunnel?.public_url && work.app.openExternal(project.tunnel.public_url),
  inspect: () => project.tunnel?.inspect_url && work.app.openExternal(project.tunnel.inspect_url),
};

function onClick(e) {
  const b = e.target.closest('[data-act]');
  if (b && !b.disabled) acts[b.dataset.act]?.();
}

function onKey(e) {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  e.stopPropagation();
  closeNgrokPanel();
}

export function closeNgrokPanel() {
  if (!sheet) return;
  const el = sheet;
  sheet = null;
  project = null;
  removeEventListener('keydown', onKey, true);
  leave(el, () => el.remove());
  back?.focus?.();
}

// The port: the open tunnel's, else the one a running command serves, else the last used.
export async function openNgrokPanel(p) {
  if (sheet || !p) return;
  project = p;
  back = document.activeElement;
  const prefs = prefsOf(p);
  sheet = document.createElement('div');
  sheet.className = 'sheet ngrok-sheet';
  sheet.innerHTML = `
    <div class="ngrok-card" role="dialog" aria-modal="true" aria-labelledby="ngrok-title">
      <header class="pl-head">
        <div>
          <h3 id="ngrok-title">ngrok Tunnel</h3>
          <p class="pl-sub">Expose a local port of ${esc(p.name)} on a public URL</p>
        </div>
        <button class="icon-btn" data-act="close" title="Close (Esc)" aria-label="Close">✕</button>
      </header>
      <form class="ng-form">
        <label class="ng-field"><span>Local port</span><input class="ng-port" type="number" min="1" max="65535" placeholder="3000" required></label>
        <label class="ng-field"><span>Protocol</span><select class="ng-proto">${PROTOCOLS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
        <label class="ng-field ng-wide"><span>Custom domain</span><input class="ng-domain" placeholder="my-app.ngrok-free.app (optional)" autocomplete="off" spellcheck="false"></label>
        <button class="btn btn-accent ng-toggle" type="submit">Start</button>
      </form>
      <div class="ng-live" hidden>
        <div class="ng-url"><span class="dot running"></span><code class="ng-public"></code>
          <button class="btn btn-small" type="button" data-act="copy">Copy</button>
          <button class="btn btn-small" type="button" data-act="open">Open</button>
        </div>
        <button class="link ng-inspect" type="button" data-act="inspect"></button>
      </div>
    </div>`;
  document.body.appendChild(sheet);
  q('.ng-port').value = String(hooks.suggestPort(p) ?? prefs.port ?? '');
  q('.ng-proto').value = prefs.protocol;
  q('.ng-domain').value = prefs.domain;
  sheet.onpointerdown = (e) => {
    if (e.target === sheet) closeNgrokPanel();
  };
  sheet.onclick = onClick;
  q('.ng-form').onsubmit = (e) => {
    e.preventDefault();
    toggleTunnel();
  };
  addEventListener('keydown', onKey, true);
  render();
  q(p.tunnel?.active ? '.ng-toggle' : '.ng-port').focus();
  await refreshTunnel(p);
}

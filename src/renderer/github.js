// GitHub tab: the active project's repository, through the gh CLI the user is signed in with.
import { $, esc, setHtml } from './ui.js';

const { work } = window;

const CLI_URL = 'https://cli.github.com';

let hooks = {}; // { activeProject(), login(project) }
let visible = false;

// What the tab shows instead of the repository when gh can't give it; null when it can.
export function emptyState(s) {
  if (!s.installed) {
    return { id: 'install', title: 'Serve GitHub CLI', text: 'Work usa il CLI di GitHub per leggere e governare il repository: installalo e torna qui.', action: 'Scarica GitHub CLI' };
  }
  if (s.old) {
    return { id: 'install', title: 'Serve GitHub CLI 2.40 o più recente', text: 'La versione installata è troppo vecchia: aggiornala e torna qui.', action: 'Scarica GitHub CLI' };
  }
  if (!s.authed) {
    return { id: 'login', title: 'Accedi a GitHub', text: 'Si apre un terminale con gh auth login. Work non vede né salva il tuo token.', action: 'Accedi a GitHub' };
  }
  if (!s.repo) return { id: 'none', title: 'Questo progetto non ha un repository su GitHub', text: '', action: null };
  return null;
}

const card = (title, text, id, action) => `<div class="gh-empty">
  <h3>${esc(title)}</h3>
  ${text ? `<p>${esc(text)}</p>` : ''}
  ${action ? `<button class="btn btn-accent" data-gh="${id}">${esc(action)}</button>` : ''}
</div>`;

function html(p) {
  const g = p.gh;
  if (g?.error) return card('Impossibile leggere GitHub', g.error, 'retry', 'Riprova');
  if (!g?.status) return '<p class="empty">Carico…</p>';
  const e = emptyState(g.status);
  if (e) return card(e.title, e.text, e.id, e.action);
  return `<div class="gh-head"><b>${esc(g.status.repo)}</b><button class="btn btn-small" data-gh="open">Apri su GitHub</button></div>`;
}

function render() {
  const p = hooks.activeProject();
  if (p) setHtml($('#gh-body'), html(p));
}

async function load(p) {
  p.gh = { ...p.gh, error: null };
  try {
    p.gh = { status: await work.github.status(p.path) };
  } catch (e) {
    p.gh = { status: p.gh.status, error: e?.message ?? String(e) };
  }
  if (p === hooks.activeProject()) render();
}

function refresh() {
  const p = hooks.activeProject();
  if (p) load(p);
}

function onClick(e) {
  const act = e.target.closest('[data-gh]')?.dataset.gh;
  const p = hooks.activeProject();
  if (!act || !p) return;
  if (act === 'install') work.app.openExternal(CLI_URL);
  else if (act === 'login') hooks.login(p);
  else if (act === 'open') work.app.openExternal(p.gh.status.url);
  else if (act === 'retry') refresh();
}

export function initGithub(opts) {
  hooks = opts;
  $('#gh-body').onclick = onClick;
  // Back from a browser or a terminal: the login or the repository may have changed.
  work.app.onFocus(() => visible && refresh());
}

// The tab was shown or hidden. Nothing talks to gh while it is hidden.
export function setGithubVisible(on) {
  visible = on;
  if (on) {
    render();
    refresh();
  }
}

// Another project became the active one.
export function showGithub() {
  render();
  if (visible) refresh();
}

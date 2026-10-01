// GitHub tab: the active project's repository, through the gh CLI the user is signed in with.
import { $, esc, ago, setHtml } from './ui.js';

const { work } = window;

const CLI_URL = 'https://cli.github.com';

let hooks = {}; // { activeProject(), login(project) }
let visible = false; // the GitHub tab is the one showing
let timer = 0;
// Before initGithub (the panel state is restored first) there is no project yet.
const activeProject = () => hooks.activeProject?.();

const STATE_LABEL = { queued: 'In coda', running: 'In corso', success: 'Riuscita', failure: 'Fallita', cancelled: 'Annullata' };
const live = (runs) => runs.some((r) => r.state === 'running' || r.state === 'queued');
// The panel is on screen only with the GitHub tab selected and the right panel open.
const shown = () => visible && !document.body.classList.contains('panel-hidden');

// Every 10 s while a run is live and the tab is in view; otherwise once a
// minute, which also keeps the tab's dot current when it is hidden.
export const pollDelay = (inView, running) => (inView && running ? 10_000 : 60_000);

// Red when the newest run of the current branch failed, blue while it is live.
export function tabDot(runs, branch) {
  const last = runs?.find((r) => r.branch === branch);
  if (last?.state === 'failure') return 'failure';
  return last && (last.state === 'running' || last.state === 'queued') ? 'running' : null;
}

export function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

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

function runRow(r) {
  const start = Date.parse(r.createdAt);
  const took = r.state === 'running' || r.state === 'queued' ? '' : `<i>${duration(Date.parse(r.updatedAt) - start)}</i>`;
  return `<li class="gh-item" data-id="${r.id}">
    <div class="gh-row">
      <span class="dot g-${r.state}" title="${STATE_LABEL[r.state]}"></span>
      <div class="li-main">
        <div class="li-title">${esc(r.title || r.workflow)}</div>
        <div class="li-sub">${esc(r.workflow)} · ${esc(r.branch)} · ${esc(r.event)}</div>
      </div>
      <span class="gh-time"><b>${ago(start)}</b>${took}</span>
    </div>
  </li>`;
}

function actionsHtml(g) {
  if (g.runsError) return card('Impossibile leggere le run', g.runsError, 'retry', 'Riprova');
  if (!g.runs) return '<p class="empty">Carico le run…</p>';
  if (!g.runs.length) return '<p class="empty">Nessuna run in questo repository.</p>';
  return `<ul class="list gh-list">${g.runs.map(runRow).join('')}</ul>`;
}

function html(p) {
  const g = p.gh;
  if (g?.error) return card('Impossibile leggere GitHub', g.error, 'retry', 'Riprova');
  if (!g?.status) return '<p class="empty">Carico…</p>';
  const e = emptyState(g.status);
  if (e) return card(e.title, e.text, e.id, e.action);
  return `<div class="gh-head"><b>${esc(g.status.repo)}</b><button class="btn btn-small" data-gh="open">Apri su GitHub</button></div>${actionsHtml(g)}`;
}

function render() {
  const p = activeProject();
  if (p) setHtml($('#gh-body'), html(p));
}

export function updateDot() {
  const p = activeProject();
  const dot = tabDot(p?.gh?.runs, p?.gitStatus?.branch?.name);
  $('#gh-tab-dot').className = dot ? `dot g-${dot}` : 'dot hidden';
}

const message = (e) => e?.message ?? String(e);

// `status: false` re-reads only the runs: the repository and the login do not change by the minute.
async function load(p, { status = true } = {}) {
  const g = (p.gh ??= {});
  if (g.busy) return;
  g.busy = true;
  try {
    if (status || !g.status) {
      g.status = await work.github.status(p.path);
      g.error = null;
    }
    if (!emptyState(g.status)) {
      try {
        g.runs = await work.github.runs(p.path);
        g.runsError = null;
      } catch (e) {
        g.runsError = message(e);
      }
    }
  } catch (e) {
    g.error = message(e);
  } finally {
    g.busy = false;
    g.at = Date.now();
  }
  if (p === activeProject()) {
    render();
    updateDot();
    schedule();
  }
}

function schedule() {
  clearTimeout(timer);
  const runs = activeProject()?.gh?.runs;
  if (!runs) return; // nothing to poll until a repository answered
  timer = setTimeout(() => {
    const p = activeProject();
    if (p) load(p, { status: false });
  }, pollDelay(shown(), live(runs)));
}

function refresh(opts) {
  const p = activeProject();
  if (p) load(p, opts);
}

function onClick(e) {
  const act = e.target.closest('[data-gh]')?.dataset.gh;
  const p = activeProject();
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
  work.app.onFocus(() => shown() && refresh());
}

// The GitHub tab was shown or hidden. Nothing but the dot's minute poll talks to gh while it is hidden.
export function setGithubVisible(on) {
  visible = on;
  if (on) {
    render();
    refresh();
  } else schedule();
}

// The right panel opened or closed.
export function githubPanelChanged() {
  if (shown()) refresh();
  else schedule();
}

// Another project became the active one: its dot needs data even with the tab hidden.
export function showGithub() {
  const p = activeProject();
  render();
  updateDot();
  if (p && (shown() || !p.gh?.at || Date.now() - p.gh.at > 60_000)) refresh({ status: !p.gh?.status });
  else schedule();
}

// Work pushed: the run takes a few seconds to appear on GitHub.
export function githubPushed() {
  refresh({ status: false });
  setTimeout(() => refresh({ status: false }), 5000);
}

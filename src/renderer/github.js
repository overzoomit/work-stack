// GitHub tab: the active project's repository, through the gh CLI the user is signed in with.
import { $, esc, ago, setHtml, setOpenRow, contextMenu, ask, toast, toastError } from './ui.js';

const { work } = window;

const CLI_URL = 'https://cli.github.com';

let hooks = {}; // { activeProject(), login(project) }
let visible = false; // the GitHub tab is the one showing
let timer = 0;
// Before initGithub (the panel state is restored first) there is no project yet.
const activeProject = () => hooks.activeProject?.();

const DONE = { rerun: 'Run rimessa in coda', rerunFailed: 'Job falliti rimessi in coda', cancel: 'Run annullata' };
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

// A job that never started has no usable times.
const jobTook = (j) => {
  const [a, b] = [Date.parse(j.startedAt), Date.parse(j.completedAt)];
  return j.state === 'running' || j.state === 'queued' || !(a > 9e11 && b >= a) ? '' : duration(b - a);
};

function jobsHtml(g, r) {
  const j = g.jobs?.[r.id];
  if (!j) return '<p class="gh-note">Carico i job…</p>';
  if (j.error) return `<p class="gh-note">${esc(j.error)}</p>`;
  if (!j.list.length) return '<p class="gh-note">Nessun job.</p>';
  return `<ul class="gh-jobs">${j.list.map((x) => `<li><span class="dot g-${x.state}" title="${STATE_LABEL[x.state]}"></span><span class="gh-job-name">${esc(x.name)}</span><i>${jobTook(x)}</i></li>`).join('')}</ul>`;
}

function runRow(g, r) {
  const start = Date.parse(r.createdAt);
  const isLive = r.state === 'running' || r.state === 'queued';
  const took = isLive ? '' : `<i>${duration(Date.parse(r.updatedAt) - start)}</i>`;
  const open = r.id === g.open;
  return `<li data-id="${r.id}" class="row-item gh-item${open ? ' open' : ''}">
    <button class="row-main" aria-expanded="${open}">
      <span class="dot g-${r.state}" title="${STATE_LABEL[r.state]}"></span>
      <div class="li-main">
        <div class="li-title">${esc(r.title || r.workflow)}</div>
        <div class="li-sub">${esc(r.workflow)} · ${esc(r.branch)} · ${esc(r.event)}</div>
      </div>
      <span class="gh-time"><b>${ago(start)}</b>${took}</span>
      <span class="chev">›</span>
    </button>
    <div class="row-actions"><div>
      <div class="gh-detail">${jobsHtml(g, r)}</div>
      <div class="row-btns">
        <button class="btn btn-small" data-gh="rerun">Riesegui</button>
        ${r.state === 'failure' ? '<button class="btn btn-small" data-gh="rerunFailed">Riesegui falliti</button>' : ''}
        ${isLive ? '<button class="btn btn-small btn-danger-text" data-gh="cancel">Annulla</button>' : ''}
        <button class="btn btn-small" data-gh="openRun">Apri su GitHub</button>
      </div>
    </div></div>
  </li>`;
}

function actionsHtml(g) {
  if (g.runsError) return card('Impossibile leggere le run', g.runsError, 'retry', 'Riprova');
  if (!g.runs) return '<p class="empty">Carico le run…</p>';
  if (!g.runs.length) return '<p class="empty">Nessuna run in questo repository.</p>';
  return `<ul class="list gh-list">${g.runs.map((r) => runRow(g, r)).join('')}</ul>`;
}

function html(p) {
  const g = p.gh;
  if (g?.error) return card('Impossibile leggere GitHub', g.error, 'retry', 'Riprova');
  if (!g?.status) return '<p class="empty">Carico…</p>';
  const e = emptyState(g.status);
  if (e) return card(e.title, e.text, e.id, e.action);
  return `<div class="gh-head"><b>${esc(g.status.repo)}</b>
    <button class="btn btn-small" data-gh="workflow">Esegui workflow <span class="btn-chev">⌄</span></button>
    <button class="btn btn-small" data-gh="open">Apri su GitHub</button></div>${actionsHtml(g)}`;
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
        syncOpenRun(p);
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

// The open run's jobs: loaded when it opens, and again when its state moves.
async function loadJobs(p, id) {
  const g = p.gh;
  const run = g.runs?.find((r) => r.id === id);
  try {
    g.jobs = { ...g.jobs, [id]: { list: await work.github.jobs(p.path, id), runState: run?.state } };
  } catch (e) {
    g.jobs = { ...g.jobs, [id]: { error: message(e) } };
  }
  if (p === activeProject() && g.open === id) render();
}

function syncOpenRun(p) {
  const g = p.gh;
  const run = g.runs.find((r) => r.id === g.open);
  if (!run) g.open = null;
  else if (g.jobs?.[run.id]?.runState !== run.state || live([run])) loadJobs(p, run.id);
}

function toggleRun(p, id) {
  const g = p.gh;
  g.open = g.open === id ? null : id;
  setOpenRow($('#gh-body'), g.open);
  if (g.open) loadJobs(p, id);
}

// The button reads "…" while gh works; a toast says how it went.
async function act(p, btn, work_, done) {
  const label = btn.textContent;
  btn.textContent = '…';
  btn.disabled = true;
  try {
    await work_();
    if (done) toast(done);
    return true;
  } catch (e) {
    toastError(e);
    return false;
  } finally {
    btn.textContent = label;
    btn.disabled = false;
  }
}

async function runAction(p, btn, run, action) {
  if (action === 'cancel') {
    const ok = await ask({ text: `Annullare la run «${run.title || run.workflow}»?`, input: false, danger: true, okLabel: 'Annulla run' });
    if (!ok) return;
  }
  if (await act(p, btn, () => work.github.runAction(p.path, run.id, action), DONE[action])) refreshSoon();
}

async function workflowMenu(p, btn) {
  const branch = p.gitStatus?.branch?.name;
  let list;
  const ok = await act(p, btn, async () => {
    if (!branch) throw new Error('Nessun branch attuale: sei in detached HEAD.');
    list = await work.github.workflows(p.path);
  });
  if (!ok) return;
  if (!list.length) return toast('Nessun workflow da avviare in questo repository.');
  contextMenu(0, 0, list.map((w) => ({
    label: w.name,
    detail: `su ${branch}`,
    run: async () => {
      try {
        await work.github.runWorkflow(p.path, w.id, branch);
        toast(`«${w.name}» avviato su ${branch}`);
        refreshSoon();
      } catch (e) {
        toastError(e);
      }
    },
  })), { anchor: btn });
}

const rowOf = (e) => e.target.closest('.row-main') && e.target.closest('li[data-id]');

// Opens on pointerdown, like the other rows; Enter and Space arrive as a click with no pointer.
function onPointerDown(e) {
  const li = e.button === 0 && rowOf(e);
  const p = activeProject();
  if (li && p) toggleRun(p, Number(li.dataset.id));
}

function onClick(e) {
  const p = activeProject();
  if (!p) return;
  const li = rowOf(e);
  if (li) {
    if (e.detail === 0) toggleRun(p, Number(li.dataset.id));
    return;
  }
  const btn = e.target.closest('[data-gh]');
  const act = btn?.dataset.gh;
  if (!act) return;
  const run = e.target.closest('li[data-id]') && p.gh.runs?.find((r) => r.id === Number(e.target.closest('li[data-id]').dataset.id));
  if (act === 'install') work.app.openExternal(CLI_URL);
  else if (act === 'login') hooks.login(p);
  else if (act === 'open') work.app.openExternal(p.gh.status.url);
  else if (act === 'retry') refresh();
  else if (act === 'workflow') workflowMenu(p, btn);
  else if (act === 'openRun' && run) work.app.openExternal(run.url);
  else if (run && ['rerun', 'rerunFailed', 'cancel'].includes(act)) runAction(p, btn, run, act);
}

export function initGithub(opts) {
  hooks = opts;
  $('#gh-body').onpointerdown = onPointerDown;
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

// A push, a re-run or a started workflow: the run takes a few seconds to show on GitHub.
function refreshSoon() {
  refresh({ status: false });
  setTimeout(() => refresh({ status: false }), 5000);
}
export const githubPushed = refreshSoon;

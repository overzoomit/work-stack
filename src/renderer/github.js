// GitHub tab: the active project's repository, through the gh CLI the user is signed in with.
import { $, esc, ago, setHtml, setOpenRow, contextMenu, ask, leave, toast, toastError } from './ui.js';

const { work } = window;

const CLI_URL = 'https://cli.github.com';

let hooks = {}; // { activeProject(), login(project) }
let visible = false; // the GitHub tab is the one showing
let timer = 0;
// Before initGithub (the panel state is restored first) there is no project yet.
const activeProject = () => hooks.activeProject?.();

const SECTIONS = [['actions', 'Actions'], ['secrets', 'Secrets'], ['artifacts', 'Artifacts']];
const DONE = { rerun: 'Run re-queued', rerunFailed: 'Failed jobs re-queued', cancel: 'Run cancelled' };
const STATE_LABEL = { queued: 'Queued', running: 'In progress', success: 'Succeeded', failure: 'Failed', cancelled: 'Cancelled' };
const live = (runs) => runs.some((r) => r.state === 'running' || r.state === 'queued');
// The GitHub section is on screen only while it is expanded.
const shown = () => visible;

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
    return { id: 'install', title: 'GitHub CLI required', text: 'Work uses the GitHub CLI to read and manage the repository: install it and come back.', action: 'Download GitHub CLI' };
  }
  if (s.old) {
    return { id: 'install', title: 'GitHub CLI 2.40 or later required', text: 'The installed version is too old: update it and come back.', action: 'Download GitHub CLI' };
  }
  if (!s.authed) {
    return { id: 'login', title: 'Sign in to GitHub', text: 'A terminal opens with gh auth login. Work never sees or stores your token.', action: 'Sign in to GitHub' };
  }
  if (!s.repo) return { id: 'none', title: 'This project has no GitHub repository', text: '', action: null };
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
  if (!j) return '<p class="gh-note">Loading jobs…</p>';
  if (j.error) return `<p class="gh-note">${esc(j.error)}</p>`;
  if (!j.list.length) return '<p class="gh-note">No jobs.</p>';
  return `<ul class="gh-jobs">${j.list.map((x) => `<li><span class="dot g-${x.state}" title="${STATE_LABEL[x.state]}"></span><span class="gh-job-name">${esc(x.name)}</span><i>${jobTook(x)}</i></li>`).join('')}</ul>`;
}

function runRow(g, r) {
  const start = Date.parse(r.createdAt);
  const isLive = r.state === 'running' || r.state === 'queued';
  const took = isLive ? '' : `<i>${duration(Date.parse(r.updatedAt) - start)}</i>`;
  const open = String(r.id) === g.open;
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
        <button class="btn btn-small" data-gh="rerun">Re-run</button>
        ${r.state === 'failure' ? '<button class="btn btn-small" data-gh="rerunFailed">Re-run failed</button>' : ''}
        ${isLive ? '<button class="btn btn-small btn-danger-text" data-gh="cancel">Cancel</button>' : ''}
        <button class="btn btn-small" data-gh="openRun">Open on GitHub</button>
      </div>
    </div></div>
  </li>`;
}

function actionsHtml(g) {
  if (g.runsError) return card('Couldn’t load runs', g.runsError, 'retry', 'Retry');
  if (!g.runs) return '<p class="empty">Loading runs…</p>';
  if (!g.runs.length) return '<p class="empty">No runs in this repository.</p>';
  return `<ul class="list gh-list">${g.runs.map((r) => runRow(g, r)).join('')}</ul>`;
}

const actionsPage = (g) => `<div class="gh-head"><b>${esc(g.status.repo)}</b>
  <button class="btn btn-small" data-gh="workflow">Run workflow <span class="btn-chev">⌄</span></button>
  <button class="btn btn-small" data-gh="open">Open on GitHub</button></div>${actionsHtml(g)}`;

// GitHub never gives a secret's value back: a row has a name and an age.
const since = (iso) => {
  const a = ago(Date.parse(iso));
  if (a === 'now') return 'updated just now';
  return /^\d+(s| min| h| d)$/.test(a) ? `updated ${a} ago` : `updated on ${a}`;
};

function secretRow(g, x) {
  const open = x.name === g.open;
  return `<li data-id="${esc(x.name)}" class="row-item gh-item gh-secret${open ? ' open' : ''}">
    <button class="row-main" aria-expanded="${open}">
      <div class="li-main">
        <div class="li-title gh-mono">${esc(x.name)}</div>
        <div class="li-sub">${since(x.updatedAt)}</div>
      </div>
      <span class="chev">›</span>
    </button>
    <div class="row-actions"><div>
      <div class="row-btns">
        <button class="btn btn-small" data-gh="updateSecret">Update value</button>
        <button class="btn btn-small btn-danger-text" data-gh="deleteSecret">Delete</button>
      </div>
    </div></div>
  </li>`;
}

function secretsPage(g) {
  const head = '<div class="gh-head"><b>Repository secrets</b><button class="btn btn-small" data-gh="newSecret">＋ New secret</button></div>';
  if (g.secretsError) return head + card('Couldn’t load secrets', g.secretsError, 'retrySecrets', 'Retry');
  if (!g.secrets) return `${head}<p class="empty">Loading secrets…</p>`;
  if (!g.secrets.length) return `${head}<p class="empty">No secrets in this repository.</p>`;
  return `${head}<ul class="list gh-list">${g.secrets.map((x) => secretRow(g, x)).join('')}</ul>`;
}

export function bytes(n) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toLocaleString('en-US', { maximumFractionDigits: i ? 1 : 0 })} ${units[i]}`;
}

// "expires in 12 d", or "expired" once it is past.
export function expiry(iso, now = Date.now()) {
  const s = (Date.parse(iso) - now) / 1000;
  if (!(s > 0)) return 'expired';
  if (s < 3600) return `expires in ${Math.max(1, Math.floor(s / 60))} min`;
  if (s < 86400) return `expires in ${Math.floor(s / 3600)} h`;
  return `expires in ${Math.floor(s / 86400)} d`;
}

function artifactRow(g, a) {
  const open = String(a.id) === g.open;
  const gone = a.expired || expiry(a.expiresAt) === 'expired';
  return `<li data-id="${a.id}" class="row-item gh-item gh-artifact${open ? ' open' : ''}${gone ? ' expired' : ''}">
    <button class="row-main" aria-expanded="${open}">
      <div class="li-main">
        <div class="li-title">${esc(a.name)}</div>
        <div class="li-sub">run ${a.run} · ${bytes(a.size)} · ${gone ? 'expired' : expiry(a.expiresAt)}</div>
      </div>
      <span class="chev">›</span>
    </button>
    <div class="row-actions"><div>
      <div class="row-btns">
        ${gone ? '' : '<button class="btn btn-small" data-gh="downloadArtifact">Download</button>'}
        <button class="btn btn-small btn-danger-text" data-gh="deleteArtifact">Delete</button>
      </div>
    </div></div>
  </li>`;
}

function artifactsPage(g) {
  const head = '<div class="gh-head"><b>Repository artifacts</b></div>';
  if (g.artifactsError) return head + card('Couldn’t load artifacts', g.artifactsError, 'retryArtifacts', 'Retry');
  if (!g.artifacts) return `${head}<p class="empty">Loading artifacts…</p>`;
  if (!g.artifacts.length) return `${head}<p class="empty">No artifacts in this repository.</p>`;
  return `${head}<ul class="list gh-list">${g.artifacts.map((a) => artifactRow(g, a)).join('')}</ul>`;
}

const PAGES = { actions: actionsPage, secrets: secretsPage, artifacts: artifactsPage };

// The section a project last showed (kept in the browser, like the panel sizes).
const sectionKey = (p) => `work.gh.section:${p.path}`;
function sectionOf(p) {
  const g = (p.gh ??= {});
  if (!g.section) {
    let saved = null;
    try {
      saved = localStorage.getItem(sectionKey(p));
    } catch {
      // storage unavailable: the default
    }
    g.section = SECTIONS.some(([id]) => id === saved) ? saved : 'actions';
  }
  return g.section;
}

const navHtml = () => `<div class="segmented gh-seg" role="tablist" style="--n:${SECTIONS.length}"><i class="gh-pill"></i>${
  SECTIONS.map(([id, label]) => `<button role="tab" data-seg="${id}">${label}</button>`).join('')}</div>`;

// The selection is applied on the nodes already there: the pill slides to it.
function applyNav(p) {
  const nav = $('#gh-nav');
  const sel = sectionOf(p);
  nav.querySelector('.gh-seg')?.style.setProperty('--i', SECTIONS.findIndex(([id]) => id === sel));
  for (const b of nav.querySelectorAll('[data-seg]')) {
    b.classList.toggle('active', b.dataset.seg === sel);
    b.setAttribute('aria-selected', String(b.dataset.seg === sel));
  }
}

function render() {
  const p = activeProject();
  if (!p) return;
  const g = p.gh;
  const ready = g?.status && !g.error && !emptyState(g.status);
  if (setHtml($('#gh-nav'), ready ? navHtml() : '') || ready) applyNav(p);
  if (g?.error) setHtml($('#gh-content'), card('Couldn’t reach GitHub', g.error, 'retry', 'Retry'));
  else if (!g?.status) setHtml($('#gh-content'), '<p class="empty">Loading…</p>');
  else {
    const e = emptyState(g.status);
    setHtml($('#gh-content'), e ? card(e.title, e.text, e.id, e.action) : PAGES[sectionOf(p)](g));
  }
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
  if (!p || p.remote) return;
  load(p, opts);
  if (opts?.status !== false && shown()) LOADERS[sectionOf(p)]?.(p);
}

async function loadSecrets(p) {
  const g = p.gh;
  try {
    g.secrets = await work.github.secrets(p.path);
    g.secretsError = null;
  } catch (e) {
    g.secretsError = message(e);
  }
  if (p === activeProject()) render();
}

async function loadArtifacts(p) {
  const g = p.gh;
  try {
    g.artifacts = await work.github.artifacts(p.path);
    g.artifactsError = null;
  } catch (e) {
    g.artifactsError = message(e);
  }
  if (p === activeProject()) render();
}

// What each section reads when it is shown (Actions has its own poll).
const LOADERS = { secrets: loadSecrets, artifacts: loadArtifacts };

function setSection(p, id) {
  const g = p.gh;
  if (sectionOf(p) === id) return;
  g.section = id;
  g.open = null;
  try {
    localStorage.setItem(sectionKey(p), id);
  } catch {
    // storage unavailable: the choice lasts until the app closes
  }
  applyNav(p);
  render();
  LOADERS[id]?.(p);
}

// ── Secrets ──────────────────────────────────────────────────

// The same rule as the backend, so a wrong name is told while typing.
export function secretNameError(name) {
  if (!name) return '';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return 'Only letters, digits and _; it can’t start with a digit.';
  if (/^github_/i.test(name)) return 'Names starting with GITHUB_ are reserved by GitHub.';
  return '';
}

let sheet = null;

function closeSheet() {
  if (!sheet) return;
  const el = sheet;
  sheet = null;
  el.querySelector('#gh-secret-value').value = ''; // the value lives only while the sheet is open
  leave(el, () => el.remove());
}

// A translucent sheet from the sidebar's edge. It does not dim the rest: nothing else is blocked.
function openSecretSheet(p, existing) {
  closeSheet();
  const el = document.createElement('div');
  el.className = 'gh-sheet';
  el.innerHTML = `<form class="gh-sheet-card" autocomplete="off">
    <h3>${existing ? 'Update value' : 'New secret'}</h3>
    <label class="gh-field">Name
      <input id="gh-secret-name" class="gh-mono" spellcheck="false" ${existing ? 'readonly' : 'placeholder="SECRET_NAME"'}>
    </label>
    <p class="gh-field-error" id="gh-secret-error"></p>
    <label class="gh-field">Value
      <span class="gh-value">
        <textarea id="gh-secret-value" class="gh-mono" rows="6" spellcheck="false" placeholder="Multi-line values such as certificates are fine"></textarea>
        <button type="button" class="icon-btn gh-eye" id="gh-secret-eye" title="Show value" aria-pressed="false">◉</button>
      </span>
    </label>
    <div class="gh-sheet-btns">
      <button type="button" class="btn" id="gh-secret-cancel">Cancel</button>
      <button type="submit" class="btn btn-accent" id="gh-secret-save" disabled>Save</button>
    </div>
  </form>`;
  const [name, value, error, eye, save] = ['name', 'value', 'error', 'eye', 'save'].map((x) => el.querySelector(`#gh-secret-${x}`));
  const check = () => {
    const err = existing ? '' : secretNameError(name.value);
    error.textContent = err;
    save.disabled = !name.value || !!err || !value.value;
  };
  if (existing) name.value = existing;
  value.classList.add('masked');
  check();
  name.oninput = check;
  value.oninput = check;
  eye.onclick = () => {
    const hidden = value.classList.toggle('masked');
    eye.setAttribute('aria-pressed', String(!hidden));
    eye.title = hidden ? 'Show value' : 'Hide value';
  };
  el.querySelector('#gh-secret-cancel').onclick = closeSheet;
  el.onkeydown = (e) => e.key === 'Escape' && closeSheet();
  el.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    if (save.disabled) return;
    const label = save.textContent;
    save.textContent = '…';
    save.disabled = true;
    try {
      await work.github.secretSet(p.path, name.value, value.value);
      toast(`Secret “${name.value}” saved`);
      closeSheet();
      loadSecrets(p);
    } catch (err) {
      toastError(err);
      save.textContent = label;
      check();
    }
  };
  $('.sidebar').appendChild(el);
  sheet = el;
  (existing ? value : name).focus();
}

async function downloadArtifact(p, btn, a) {
  const dir = await work.app.pickFolder();
  if (!dir) return;
  let path = null;
  const ok = await act(p, btn, async () => {
    path = await work.github.artifactDownload(p.path, a.run, a.name, dir);
  });
  if (!ok) return;
  const label = document.body.classList.contains('mac') ? 'Show in Finder' : 'Show in folder';
  toast('Downloaded', { action: { label, run: () => work.github.artifactReveal(path).catch(toastError) } });
}

async function deleteArtifact(p, btn, a) {
  const ok = await ask({ text: `Delete artifact “${a.name}”? This can’t be undone.`, input: false, danger: true, okLabel: 'Delete' });
  if (ok && await act(p, btn, () => work.github.artifactDelete(p.path, a.id), `Artifact “${a.name}” deleted`)) {
    p.gh.open = null;
    loadArtifacts(p);
  }
}

async function deleteSecret(p, btn, name) {
  const ok = await ask({ text: `Delete secret “${name}”? Workflows that use it will no longer find it.`, input: false, danger: true, okLabel: 'Delete' });
  if (ok && await act(p, btn, () => work.github.secretDelete(p.path, name), `Secret “${name}” deleted`)) {
    p.gh.open = null;
    loadSecrets(p);
  }
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
  if (p === activeProject() && g.open === String(id)) render();
}

function syncOpenRun(p) {
  const g = p.gh;
  const run = g.runs.find((r) => String(r.id) === g.open);
  if (!run) {
    if (sectionOf(p) === 'actions') g.open = null;
  } else if (g.jobs?.[run.id]?.runState !== run.state || live([run])) loadJobs(p, run.id);
}

// A row is a run (Actions) or a secret: its id is the run's number or the secret's name.
function toggleRow(p, id) {
  const g = p.gh;
  g.open = g.open === id ? null : id;
  setOpenRow($('#gh-content'), g.open);
  if (g.open && sectionOf(p) === 'actions') loadJobs(p, Number(id));
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
    const ok = await ask({ text: `Cancel run “${run.title || run.workflow}”?`, input: false, danger: true, okLabel: 'Cancel run' });
    if (!ok) return;
  }
  if (await act(p, btn, () => work.github.runAction(p.path, run.id, action), DONE[action])) refreshSoon();
}

async function workflowMenu(p, btn) {
  const branch = p.gitStatus?.branch?.name;
  let list;
  const ok = await act(p, btn, async () => {
    if (!branch) throw new Error('No current branch: you are in detached HEAD.');
    list = await work.github.workflows(p.path);
  });
  if (!ok) return;
  if (!list.length) return toast('No workflows to run in this repository.');
  contextMenu(0, 0, list.map((w) => ({
    label: w.name,
    detail: `on ${branch}`,
    run: async () => {
      try {
        await work.github.runWorkflow(p.path, w.id, branch);
        toast(`“${w.name}” started on ${branch}`);
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
  if (li && p) toggleRow(p, li.dataset.id);
}

function onClick(e) {
  const p = activeProject();
  if (!p) return;
  const li = rowOf(e);
  if (li) {
    if (e.detail === 0) toggleRow(p, li.dataset.id);
    return;
  }
  const seg = e.target.closest('[data-seg]');
  if (seg) return setSection(p, seg.dataset.seg);
  const btn = e.target.closest('[data-gh]');
  const act = btn?.dataset.gh;
  if (!act) return;
  const id = e.target.closest('li[data-id]')?.dataset.id;
  const run = id && p.gh.runs?.find((r) => String(r.id) === id);
  if (act === 'install') work.app.openExternal(CLI_URL);
  else if (act === 'login') hooks.login(p);
  else if (act === 'open') work.app.openExternal(p.gh.status.url);
  else if (act === 'retry') refresh();
  else if (act === 'workflow') workflowMenu(p, btn);
  else if (act === 'newSecret') openSecretSheet(p, null);
  else if (act === 'updateSecret' && id) openSecretSheet(p, id);
  else if (act === 'deleteSecret' && id) deleteSecret(p, btn, id);
  else if (act === 'retrySecrets') loadSecrets(p);
  else if (act === 'retryArtifacts') loadArtifacts(p);
  else if (['downloadArtifact', 'deleteArtifact'].includes(act) && id) {
    const a = p.gh.artifacts?.find((x) => String(x.id) === id);
    if (a) (act === 'downloadArtifact' ? downloadArtifact : deleteArtifact)(p, btn, a);
  }
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

// Another project became the active one: its dot needs data even with the section collapsed.
export function showGithub() {
  const p = activeProject();
  if (p?.remote) {
    $('#gh-tab-dot').className = 'dot hidden';
    setHtml($('#gh-nav'), '');
    setHtml($('#gh-content'), '<p class="empty">GitHub Actions for remote projects are managed from the SSH terminal.</p>');
    return;
  }
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

// GitHub tab: the active project's repository, through the gh CLI the user is signed in with.
import { $, esc, ago, setHtml, setOpenRow, contextMenu, ask, leave, toast, toastError } from './ui.js';

const { work } = window;

const CLI_URL = 'https://cli.github.com';

let hooks = {}; // { activeProject(), login(project) }
let visible = false; // the GitHub tab is the one showing
let timer = 0;
// Before initGithub (the panel state is restored first) there is no project yet.
const activeProject = () => hooks.activeProject?.();

const SECTIONS = [['actions', 'Actions'], ['secrets', 'Secrets']];
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

const actionsPage = (g) => `<div class="gh-head"><b>${esc(g.status.repo)}</b>
  <button class="btn btn-small" data-gh="workflow">Esegui workflow <span class="btn-chev">⌄</span></button>
  <button class="btn btn-small" data-gh="open">Apri su GitHub</button></div>${actionsHtml(g)}`;

// GitHub never gives a secret's value back: a row has a name and an age.
const since = (iso) => {
  const a = ago(Date.parse(iso));
  if (a === 'ora') return 'aggiornato ora';
  return /^\d+(s| min| h| g)$/.test(a) ? `aggiornato ${a} fa` : `aggiornato il ${a}`;
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
        <button class="btn btn-small" data-gh="updateSecret">Aggiorna valore</button>
        <button class="btn btn-small btn-danger-text" data-gh="deleteSecret">Elimina</button>
      </div>
    </div></div>
  </li>`;
}

function secretsPage(g) {
  const head = '<div class="gh-head"><b>Secret del repository</b><button class="btn btn-small" data-gh="newSecret">＋ Nuovo secret</button></div>';
  if (g.secretsError) return head + card('Impossibile leggere i secret', g.secretsError, 'retrySecrets', 'Riprova');
  if (!g.secrets) return `${head}<p class="empty">Carico i secret…</p>`;
  if (!g.secrets.length) return `${head}<p class="empty">Nessun secret in questo repository.</p>`;
  return `${head}<ul class="list gh-list">${g.secrets.map((x) => secretRow(g, x)).join('')}</ul>`;
}

const PAGES = { actions: actionsPage, secrets: secretsPage };

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
  if (g?.error) setHtml($('#gh-content'), card('Impossibile leggere GitHub', g.error, 'retry', 'Riprova'));
  else if (!g?.status) setHtml($('#gh-content'), '<p class="empty">Carico…</p>');
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
  if (!p) return;
  load(p, opts);
  if (opts?.status !== false && shown() && sectionOf(p) === 'secrets') loadSecrets(p);
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
  if (id === 'secrets') loadSecrets(p);
}

// ── Secrets ──────────────────────────────────────────────────

// The same rule as the backend, so a wrong name is told while typing.
export function secretNameError(name) {
  if (!name) return '';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return 'Solo lettere, cifre e _; non può iniziare con una cifra.';
  if (/^github_/i.test(name)) return 'I nomi che iniziano con GITHUB_ sono riservati da GitHub.';
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

// A translucent sheet from the panel's edge. It does not dim the rest: nothing else is blocked.
function openSecretSheet(p, existing) {
  closeSheet();
  const el = document.createElement('div');
  el.className = 'gh-sheet';
  el.innerHTML = `<form class="gh-sheet-card" autocomplete="off">
    <h3>${existing ? 'Aggiorna valore' : 'Nuovo secret'}</h3>
    <label class="gh-field">Nome
      <input id="gh-secret-name" class="gh-mono" spellcheck="false" ${existing ? 'readonly' : 'placeholder="NOME_DEL_SECRET"'}>
    </label>
    <p class="gh-field-error" id="gh-secret-error"></p>
    <label class="gh-field">Valore
      <span class="gh-value">
        <textarea id="gh-secret-value" class="gh-mono" rows="6" spellcheck="false" placeholder="Anche un certificato su più righe"></textarea>
        <button type="button" class="icon-btn gh-eye" id="gh-secret-eye" title="Mostra il valore" aria-pressed="false">◉</button>
      </span>
    </label>
    <div class="gh-sheet-btns">
      <button type="button" class="btn" id="gh-secret-cancel">Annulla</button>
      <button type="submit" class="btn btn-accent" id="gh-secret-save" disabled>Salva</button>
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
    eye.title = hidden ? 'Mostra il valore' : 'Nascondi il valore';
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
      toast(`Secret «${name.value}» salvato`);
      closeSheet();
      loadSecrets(p);
    } catch (err) {
      toastError(err);
      save.textContent = label;
      check();
    }
  };
  $('.panel').appendChild(el);
  sheet = el;
  (existing ? value : name).focus();
}

async function deleteSecret(p, btn, name) {
  const ok = await ask({ text: `Eliminare il secret «${name}»? I workflow che lo usano non lo troveranno più.`, input: false, danger: true, okLabel: 'Elimina' });
  if (ok && await act(p, btn, () => work.github.secretDelete(p.path, name), `Secret «${name}» eliminato`)) {
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

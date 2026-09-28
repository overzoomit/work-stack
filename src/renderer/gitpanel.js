// Git side of the right panel: changes, commit box, branch actions, graph.
import { $, $$, esc, ago, toast, toastError, ask, contextMenu } from './ui.js';
import { layout, renderSvg, refBadges } from './graph.js';
import { openCommit, openWorking } from './review.js';

const { work } = window;

let active = null;
let onStatus = () => {};

const ACTION_LABELS = {
  fetch: 'Fetch completato', pull: 'Pull completato', push: 'Push completato', stash: 'Modifiche messe in stash',
  stashPop: 'Stash ripristinato', commit: 'Commit creato', checkout: 'Branch cambiato', createBranch: 'Branch creato',
  discard: 'Modifiche scartate', cherryPick: 'Cherry-pick applicato', revert: 'Revert creato', merge: 'Merge completato',
  init: 'Repository inizializzato',
};

export function initGit({ statusChanged }) {
  onStatus = statusChanged;

  $$('[data-git]').forEach((b) => {
    b.onclick = async () => {
      const name = b.dataset.git;
      if (name === 'newBranch') {
        const branch = await ask({ text: 'Nome del nuovo branch', placeholder: 'feature/…', okLabel: 'Crea' });
        if (branch) await runGit('createBranch', { name: branch });
        return;
      }
      await runGit(name, {}, { button: b });
    };
  });
  $('#stage-all').onclick = () => runGit('stageAll', {}, { quiet: true });
  $('#commit-btn').onclick = commit;
  $('#commit-msg').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commit();
  });
  $('#commit-msg').addEventListener('input', (e) => {
    if (active) active.draft = e.target.value;
  });
  $('#branch-select').onchange = async (e) => {
    const branch = e.target.value;
    if (branch !== active?.gitStatus?.branch.name) await runGit('checkout', { branch });
  };
  $('#staged').addEventListener('click', onFileClick);
  $('#unstaged').addEventListener('click', onFileClick);
  $('#staged').addEventListener('contextmenu', onFileMenu);
  $('#unstaged').addEventListener('contextmenu', onFileMenu);
  $('#git-init').onclick = () => runGit('init', {}, { repo: active.path });
}

export async function showGit(project) {
  active = project;
  $('#commit-msg').value = project?.draft || '';
  const isRepo = !!project?.root;
  $('#git-body').hidden = !isRepo;
  $('#graph').hidden = !isRepo;
  $('#git-none').hidden = isRepo || !project;
  $('#graph-none').hidden = isRepo || !project;
  renderChanges(project);
  await refreshGit(project, true);
}

// One refresh per project at a time: requests arriving while one runs are
// merged into a single follow-up run (full if any of them asked for it).
export async function refreshGit(project, full = false) {
  if (!project) return;
  if (project.gitBusy) {
    project.gitAgain = project.gitAgain === 'full' || full ? 'full' : 'quick';
    return;
  }
  project.gitBusy = true;
  try {
    await refreshGitNow(project, full);
  } finally {
    project.gitBusy = false;
  }
  const again = project.gitAgain;
  project.gitAgain = null;
  if (again) await refreshGit(project, again === 'full');
}

async function refreshGitNow(project, full) {
  if (!project.root) {
    // A folder may have become a repository (git init from a terminal).
    project.root = await work.git.root(project.path);
    if (!project.root) return onStatus(project);
    work.git.watch(project.root);
    if (project === active) return showGit(project);
  }
  try {
    const prev = project.gitStatus;
    // The ignored-files scan walks the whole tree: only on full refreshes.
    const st = await work.git.status(project.root, { ignored: full || !prev });
    if (st.ignored === null) st.ignored = prev?.ignored || [];
    const headChanged = !prev || prev.branch.name !== st.branch.name
      || prev.branch.ahead !== st.branch.ahead || prev.branch.behind !== st.branch.behind;
    const changed = !prev || JSON.stringify(prev) !== JSON.stringify(st);
    project.gitStatus = st;
    // Nothing changed: skip re-rendering the tree, the tabs and the lists.
    if (changed) onStatus(project);
    if (project !== active) return;
    if (changed) renderChanges(project);
    if (full || headChanged) await Promise.all([refreshBranches(project), refreshGraph(project)]);
  } catch (e) {
    if (full) toastError(e);
  }
}

function renderChanges(project) {
  const st = project?.gitStatus;
  $('#ahead').textContent = st?.branch.ahead || '';
  $('#behind').textContent = st?.branch.behind || '';
  $('#staged-count').textContent = st?.staged.length || 0;
  $('#unstaged-count').textContent = st?.unstaged.length || 0;
  $('#changes-count').textContent = st ? st.staged.length + st.unstaged.length : 0;

  const row = (f, staged) => {
    const dir = f.file.includes('/') ? f.file.slice(0, f.file.lastIndexOf('/') + 1) : '';
    const name = f.file.slice(dir.length);
    const acts = staged
      ? `<button class="icon-btn" data-act="unstage" title="Togli dallo stage">−</button>`
      : `<button class="icon-btn" data-act="discard" title="Scarta modifiche">↺</button>
         <button class="icon-btn" data-act="stage" title="Metti in stage">＋</button>`;
    return `<li data-file="${esc(f.file)}" data-staged="${staged ? 1 : ''}" data-code="${f.code}">
      <span class="code ${f.code}">${f.code}</span>
      <span class="fname s-${f.code}"><bdi>${esc(dir)}<b>${esc(name)}</b></bdi></span>
      <span class="acts">${acts}</span></li>`;
  };
  $('#staged').innerHTML = st ? st.staged.map((f) => row(f, true)).join('') : '';
  $('#unstaged').innerHTML = st
    ? st.unstaged.map((f) => row(f, false)).join('') || '<p class="empty">Nessuna modifica.</p>'
    : '';
}

async function onFileClick(e) {
  const li = e.target.closest('li[data-file]');
  if (!li || !active?.gitStatus) return;
  const file = li.dataset.file;
  const staged = !!li.dataset.staged;
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'discard') {
    if (li.dataset.code === 'U') return toast('File non tracciato: eliminalo dal tab Project se vuoi scartarlo.', { error: true });
    const ok = await ask({ text: `Scartare le modifiche a ${file}? Non si può annullare.`, okLabel: 'Scarta', danger: true, input: false });
    if (ok) await runGit('discard', { files: [file] });
  } else if (act) {
    await runGit(act, { files: [file] }, { quiet: true });
  } else {
    showWorkingDiff(active, file, staged);
  }
}

let hooks = {};
export function setGitHooks(h) {
  hooks = h; // { preview(abs), reveal(abs) }
}

function onFileMenu(e) {
  const li = e.target.closest('li[data-file]');
  if (!li || !active?.gitStatus) return;
  e.preventDefault();
  const file = li.dataset.file;
  const staged = !!li.dataset.staged;
  const untracked = li.dataset.code === 'U';
  const deleted = li.dataset.code === 'D';
  const abs = `${active.root}/${file}`;
  contextMenu(e.clientX, e.clientY, [
    { label: 'Mostra differenze', run: () => showWorkingDiff(active, file, staged) },
    staged
      ? { label: 'Togli dallo stage', run: () => runGit('unstage', { files: [file] }, { quiet: true }) }
      : { label: 'Metti in stage', run: () => runGit('stage', { files: [file] }, { quiet: true }) },
    '-',
    { label: 'Anteprima file', disabled: deleted, run: () => hooks.preview?.(abs) },
    { label: "Mostra nell'albero", disabled: deleted, run: () => hooks.reveal?.(abs) },
    { label: 'Copia percorso relativo', run: () => work.app.copy(file) },
    ...(!staged && !untracked ? ['-', {
      label: 'Scarta modifiche…',
      danger: true,
      run: async () => {
        const ok = await ask({ text: `Scartare le modifiche a ${file}? Non si può annullare.`, okLabel: 'Scarta', danger: true, input: false });
        if (ok) await runGit('discard', { files: [file] });
      },
    }] : []),
  ]);
}

export function showWorkingDiff(project, file, staged) {
  const st = project.gitStatus;
  if (!st) return;
  const inStaged = st.staged.some((f) => f.file === file);
  const inUnstaged = st.unstaged.some((f) => f.file === file);
  if (!inStaged && !inUnstaged) return toast('Nessuna modifica per questo file.');
  // Explicit group from the Changes list; otherwise prefer the unstaged version.
  const group = staged === true ? 's' : staged === false ? 'u' : inUnstaged ? 'u' : 's';
  openWorking(project.root, st, { group, file }, {
    onToggleStage: (f, isStaged) => runGit(isStaged ? 'unstage' : 'stage', { files: [f] }, { quiet: true }),
  });
}

export async function runGit(name, params = {}, { quiet = false, button = null, repo = null } = {}) {
  const project = active;
  const target = repo || project?.root;
  if (!target) return toast('Nessun repository.', { error: true });
  button?.classList.add('busy');
  try {
    const out = await work.git.action(target, name, params);
    if (!quiet) toast(ACTION_LABELS[name] || 'Fatto');
    if (name === 'init') {
      project.root = null;
      await showGit(project);
    } else await refreshGit(project, true);
    return out ?? true;
  } catch (e) {
    toastError(e);
    return null;
  } finally {
    button?.classList.remove('busy');
  }
}

async function commit() {
  const message = $('#commit-msg').value.trim();
  const amend = $('#amend').checked;
  if (!message) return toast('Scrivi un messaggio di commit.', { error: true });
  if (!amend && !active?.gitStatus?.staged.length) return toast('Niente in stage: aggiungi dei file prima.', { error: true });
  if (await runGit('commit', { message, amend }, { button: $('#commit-btn') })) {
    $('#commit-msg').value = '';
    active.draft = '';
    $('#amend').checked = false;
  }
}

async function refreshBranches(project) {
  const sel = $('#branch-select');
  const list = await work.git.branches(project.root);
  if (project !== active) return;
  const local = list.filter((b) => !b.remote);
  const remote = list.filter((b) => b.remote);
  sel.innerHTML = `
    <optgroup label="Locali">${local.map((b) => `<option ${b.current ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</optgroup>
    ${remote.length ? `<optgroup label="Remoti">${remote.map((b) => `<option>${esc(b.name)}</option>`).join('')}</optgroup>` : ''}`;
}

async function refreshGraph(project) {
  const commits = await work.git.log(project.root);
  if (project !== active) return;
  const box = $('#graph');
  if (!commits.length) {
    box.innerHTML = '<p class="empty">Nessun commit.</p>';
    return;
  }
  const g = layout(commits);
  box.innerHTML = renderSvg(g) + g.rows.map((r, i) => {
    const c = r.commit;
    const refs = refBadges(c.refs).map((b) => `<span class="ref ${b.cls}">${esc(b.label)}</span>`).join('');
    return `<div class="g-row" data-i="${i}" style="padding-left:${r.indent}px" title="${esc(c.subject)}\n${esc(c.author)} · ${c.hash.slice(0, 8)}">
      ${refs}<span class="subj">${esc(c.subject)}</span>
      <span class="meta">${esc(c.author.split(' ')[0])} · ${ago(c.time)}</span></div>`;
  }).join('');
  box.oncontextmenu = (e) => {
    const row = e.target.closest('.g-row');
    if (!row) return;
    e.preventDefault();
    const c = g.rows[Number(row.dataset.i)].commit;
    const branchRef = refBadges(c.refs).find((b) => b.cls === 'local' || b.cls === 'head');
    contextMenu(e.clientX, e.clientY, [
      { label: 'Mostra dettagli', run: () => row.click() },
      '-',
      { label: branchRef ? `Checkout ${branchRef.label}` : 'Checkout (detached)', run: () => runGit('checkout', { branch: branchRef?.label || c.hash }) },
      {
        label: 'Nuovo branch qui…',
        run: async () => {
          const name = await ask({ text: `Nuovo branch da ${c.hash.slice(0, 8)}`, placeholder: 'feature/…', okLabel: 'Crea' });
          if (name) await runGit('createBranch', { name, from: c.hash });
        },
      },
      { label: 'Cherry-pick', run: () => runGit('cherryPick', { hash: c.hash }) },
      { label: 'Revert', run: () => runGit('revert', { hash: c.hash }) },
      '-',
      { label: 'Copia hash', run: () => work.app.copy(c.hash) },
      { label: 'Copia messaggio', run: () => work.app.copy(c.subject) },
    ]);
  };
  box.onclick = (e) => {
    const row = e.target.closest('.g-row');
    if (!row) return;
    $$('#graph .g-row.active').forEach((x) => x.classList.remove('active'));
    row.classList.add('active');
    const c = g.rows[Number(row.dataset.i)].commit;
    const branchRef = refBadges(c.refs).find((b) => b.cls === 'local' || b.cls === 'head');
    openCommit(project.root, c.hash, [
      { label: branchRef ? `Checkout ${branchRef.label}` : 'Checkout', run: () => runGit('checkout', { branch: branchRef?.label || c.hash }) },
      {
        label: 'Nuovo branch qui',
        run: async () => {
          const name = await ask({ text: `Nuovo branch da ${c.hash.slice(0, 8)}`, placeholder: 'feature/…', okLabel: 'Crea' });
          if (name) await runGit('createBranch', { name, from: c.hash });
        },
      },
      { label: 'Cherry-pick', run: () => runGit('cherryPick', { hash: c.hash }) },
      { label: 'Revert', run: () => runGit('revert', { hash: c.hash }) },
    ]);
  };
}

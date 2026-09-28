// WebStorm-style review sheet: commit details + changed-files tree on the
// left, side-by-side diff of the selected file on the right.
import { $, $$, esc, basename, fullDate, leave, toast, toastError } from './ui.js';
import { parseDiff, renderDiff } from './diff.js';
import { refBadges } from './graph.js';

const { work } = window;

let session = null; // { repo, mode, hash, parent, groups, current, nav, token }

function getMode() {
  try {
    return localStorage.getItem('work.diffMode') || 'side';
  } catch {
    return 'side';
  }
}
function setMode(m) {
  try {
    localStorage.setItem('work.diffMode', m);
  } catch {
    // storage unavailable: keep the choice for this session only
  }
}

// ── Changed-files tree (single-child folders are compacted) ──
function buildTree(files) {
  const root = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.file.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    }
    node.files.push(f);
  }
  const compact = (name, node) => {
    while (node.files.length === 0 && node.dirs.size === 1) {
      const [[child, sub]] = node.dirs;
      name = `${name}/${child}`;
      node = sub;
    }
    return [name, node];
  };
  return { root, compact };
}

function statLabel(f) {
  if (f.add === undefined) return ''; // working copy: no numstat
  if (f.add === null) return '<span class="bin">bin</span>';
  return `${f.add ? `<span class="plus">+${f.add}</span>` : ''}${f.del ? `<span class="minus">−${f.del}</span>` : ''}`;
}

function renderTree(files, groupKey) {
  const { root, compact } = buildTree(files);
  const walk = (node, depth) => {
    let html = '';
    for (const [n, sub] of [...node.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      const [name, inner] = compact(n, sub);
      html += `<div class="ft-dir" style="--depth:${depth}"><span class="chev">›</span><span class="ft-folder"></span>${esc(name)}</div>
        <div class="ft-children">${walk(inner, depth + 1)}</div>`;
    }
    for (const f of node.files.sort((a, b) => a.file.localeCompare(b.file))) {
      const title = f.oldFile && f.oldFile !== f.file ? `${f.oldFile} → ${f.file}` : f.file;
      html += `<div class="ft-file" tabindex="-1" style="--depth:${depth}" data-group="${groupKey}" data-file="${esc(f.file)}" title="${esc(title)}">
        <span class="code ${f.code}">${f.code}</span><span class="ft-name s-${f.code}">${esc(basename(f.file))}</span>
        <span class="ft-stat">${statLabel(f)}</span></div>`;
    }
    return html;
  };
  return walk(root, 0);
}

// ── Sheet lifecycle ──────────────────────────────────────────
export function closeReview() {
  const el = $('#review');
  if (el.hidden || !session) return;
  session = null;
  leave(el, () => {
    el.hidden = true;
  });
}

function open() {
  const el = $('#review');
  el.hidden = false;
  $('#review-diff').innerHTML = '<div class="d-empty">Seleziona un file.</div>';
}

// Commit review. `actions`: [{ label, run }] shown in the header.
export async function openCommit(repo, hash, actions = []) {
  const token = Symbol('review');
  session = { repo, mode: 'commit', hash, token };
  open();
  $('#review-title').textContent = 'Caricamento…';
  $('#review-info').innerHTML = '';
  $('#review-files').innerHTML = '';
  renderActions(actions);

  let c;
  try {
    c = await work.git.commit(repo, hash);
  } catch (e) {
    toastError(e);
    return closeReview();
  }
  if (session?.token !== token) return;
  session.groups = [{ key: 'c', files: c.files }];
  session.parent = c.parents[0] || null;

  const [subject, ...rest] = c.message.split('\n');
  const body = rest.join('\n').trim();
  $('#review-title').textContent = subject;
  const refs = refBadges(c.refs).map((b) => `<span class="ref ${b.cls}">${esc(b.label)}</span>`).join('');
  const add = c.files.reduce((s, f) => s + (f.add || 0), 0);
  const del = c.files.reduce((s, f) => s + (f.del || 0), 0);
  $('#review-info').innerHTML = `
    <div class="ci-subject">${esc(subject)}</div>
    ${body ? `<div class="ci-body">${esc(body)}</div>` : ''}
    ${refs ? `<div class="ci-refs">${refs}</div>` : ''}
    <dl class="ci-meta">
      <dt>Autore</dt><dd>${esc(c.author)} <span class="muted">&lt;${esc(c.email)}&gt;</span></dd>
      <dt>Data</dt><dd>${fullDate(c.time)}</dd>
      ${c.committer !== c.author ? `<dt>Commit di</dt><dd>${esc(c.committer)}</dd>` : ''}
      <dt>Hash</dt><dd><button class="hash" data-copy="${c.hash}" title="Copia">${c.hash.slice(0, 12)}</button></dd>
      <dt>Parent</dt><dd>${c.parents.map((p) => `<button class="hash" data-copy="${p}" title="Copia">${p.slice(0, 8)}</button>`).join(' ') || '<span class="muted">nessuno (commit iniziale)</span>'}</dd>
      <dt>Branch</dt><dd id="ci-contains" class="muted">…</dd>
    </dl>`;
  $('#review-files').innerHTML = `
    <div class="ft-head">${c.files.length} ${c.files.length === 1 ? 'file modificato' : 'file modificati'}
      <span class="plus">+${add}</span><span class="minus">−${del}</span>
      ${c.parents.length > 1 ? '<span class="muted">· rispetto al primo parent</span>' : ''}</div>
    ${renderTree(c.files, 'c')}`;
  bindTree();
  if (c.files.length) selectFile('c', c.files[0].file);

  work.git.containing(repo, hash).then((list) => {
    if (session?.token !== token) return;
    const box = $('#ci-contains');
    box.classList.remove('muted');
    box.innerHTML = list.length
      ? list.slice(0, 12).map((b) => `<span class="ref ${b.includes('/') ? 'remote' : 'local'}">${esc(b)}</span>`).join(' ')
        + (list.length > 12 ? ` <span class="muted">+${list.length - 12}</span>` : '')
      : '<span class="muted">nessuno</span>';
  });
}

// Working-copy review: staged + unstaged groups. `onToggleStage(file, staged)`.
export async function openWorking(repo, status, select, { onToggleStage } = {}) {
  const token = Symbol('review');
  session = { repo, mode: 'working', token, onToggleStage };
  open();
  renderActions([]);
  $('#review-title').textContent = 'Modifiche locali';
  $('#review-info').innerHTML = `<div class="ci-subject">Modifiche locali</div>
    <div class="ci-body muted">Branch ${esc(status.branch.name)} · ${status.staged.length} in stage · ${status.unstaged.length} non in stage</div>`;
  session.groups = [
    { key: 's', label: 'In stage', files: status.staged },
    { key: 'u', label: 'Modifiche', files: status.unstaged },
  ];
  $('#review-files').innerHTML = session.groups.filter((g) => g.files.length).map((g) => `
    <div class="ft-head">${g.label} <span class="count">${g.files.length}</span></div>
    ${renderTree(g.files, g.key)}`).join('');
  bindTree();
  const first = select || { group: status.unstaged.length ? 'u' : 's', file: (status.unstaged[0] || status.staged[0])?.file };
  if (first.file) selectFile(first.group, first.file);
}

function renderActions(actions) {
  const box = $('#review-actions');
  box.innerHTML = '';
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = a.label;
    b.onclick = () => {
      closeReview();
      a.run();
    };
    box.appendChild(b);
  }
}

function bindTree() {
  const box = $('#review-files');
  box.onclick = (e) => {
    const dir = e.target.closest('.ft-dir');
    if (dir) {
      dir.classList.toggle('collapsed');
      return;
    }
    const f = e.target.closest('.ft-file');
    if (f) selectFile(f.dataset.group, f.dataset.file);
  };
}

async function selectFile(groupKey, file) {
  if (!session) return;
  const group = session.groups.find((g) => g.key === groupKey);
  const f = group?.files.find((x) => x.file === file);
  if (!f) return;
  session.current = { groupKey, file };
  $$('#review-files .ft-file').forEach((el) => el.classList.toggle('active', el.dataset.group === groupKey && el.dataset.file === file));
  $('#review-files .ft-file.active')?.scrollIntoView({ block: 'nearest' });

  const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '';
  const renamed = f.oldFile && f.oldFile !== f.file ? `<span class="muted">rinominato da ${esc(f.oldFile)}</span>` : '';
  const stageBtn = session.mode === 'working' && session.onToggleStage
    ? `<button class="btn btn-small" id="d-stage">${groupKey === 's' ? 'Togli dallo stage' : 'Metti in stage'}</button>` : '';
  $('#review-path').innerHTML = `<span class="code ${f.code}">${f.code}</span>
    <span class="d-path"><span class="muted">${esc(dir)}</span>${esc(basename(file))}</span> ${renamed}`;
  $('#review-tools-extra').innerHTML = stageBtn;
  $('#d-stage')?.addEventListener('click', async () => {
    await session.onToggleStage(file, groupKey === 's');
    closeReview();
  });

  const [left, right] = session.mode === 'commit'
    ? [session.parent ? `${session.parent.slice(0, 8)} (parent)` : 'vuoto', session.hash.slice(0, 8)]
    : groupKey === 's' ? ['HEAD', 'Stage'] : [f.code === 'U' ? 'vuoto' : 'Stage / HEAD', 'Copia di lavoro'];
  $('#review-labels').innerHTML = `<span>${esc(left)}</span><span>${esc(right)}</span>`;

  const box = $('#review-diff');
  box.classList.add('loading');
  const token = session.token;
  const spec = session.mode === 'commit'
    ? { hash: session.hash, file, oldFile: f.oldFile }
    : { file, staged: groupKey === 's', untracked: f.code === 'U' };
  let text;
  try {
    text = await work.git.fileDiff(session.repo, spec);
  } catch (e) {
    text = '';
    toastError(e);
  }
  if (session?.token !== token || session.current.file !== file || session.current.groupKey !== groupKey) return;
  box.classList.remove('loading');
  box.scrollTop = 0;
  session.parsed = parseDiff(text);
  drawDiff();
}

function drawDiff() {
  const mode = getMode();
  $('#review-labels').hidden = mode !== 'side';
  $$('#review-mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  session.nav = renderDiff($('#review-diff'), session.parsed, mode);
  $('#review-count').textContent = session.nav.count
    ? `${session.nav.count} ${session.nav.count === 1 ? 'modifica' : 'modifiche'}` : '';
}

function stepFile(d) {
  const files = $$('#review-files .ft-file');
  const i = files.findIndex((el) => el.classList.contains('active'));
  const next = files[Math.min(files.length - 1, Math.max(0, i + d))];
  if (next && next !== files[i]) selectFile(next.dataset.group, next.dataset.file);
}

// ── Wiring ───────────────────────────────────────────────────
$('#review-close').onclick = closeReview;
$('#review').addEventListener('pointerdown', (e) => e.target.id === 'review' && closeReview());
$('#review-prev').onclick = () => session?.nav?.prev();
$('#review-next').onclick = () => session?.nav?.next();
$$('#review-mode button').forEach((b) => {
  b.onpointerdown = () => {
    setMode(b.dataset.mode);
    if (session?.parsed) drawDiff();
  };
});
$('#review-info').addEventListener('click', (e) => {
  const h = e.target.closest('[data-copy]');
  if (!h) return;
  work.app.copy(h.dataset.copy);
  toast('Hash copiato');
});

addEventListener('keydown', (e) => {
  if (!session || $('#review').hidden) return;
  if (e.key === 'Escape') closeReview();
  else if (e.key === 'F7') {
    e.preventDefault();
    if (e.shiftKey) session.nav?.prev();
    else session.nav?.next();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (e.target.closest('input, textarea')) return;
    e.preventDefault();
    stepFile(e.key === 'ArrowDown' ? 1 : -1);
  }
});

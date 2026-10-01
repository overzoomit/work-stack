// Search palette, two modes. File: the active project's files by name (fuzzy,
// in the page, no backend call per key); the file list comes from fs_files at
// every opening, the previous list of the same project shows meanwhile.
// Testo: the text in the files (fs_grep), 120 ms after the last key.
import { $, esc, leave } from './ui.js';
import { previewFile } from './preview.js';

const { work } = window;
const MAX_ROWS = 200;
const GREP_DELAY = 120;
const MAX_RECENT = 8;

// ⌘/Ctrl+↵ shows the file in the tree: app.js knows the panels.
let hooks = { reveal() {} };
export const setSearchHooks = (h) => { hooks = h; };

// The last files opened from the palette, per project, newest first.
const recentKey = (project) => `work.search.recent:${project.path}`;
export function recentFiles(project) {
  try {
    const list = JSON.parse(localStorage.getItem(recentKey(project)) || '[]');
    return Array.isArray(list) ? list.filter((p) => typeof p === 'string') : [];
  } catch {
    return [];
  }
}
function remember(project, path) {
  try {
    const list = [path, ...recentFiles(project).filter((p) => p !== path)].slice(0, MAX_RECENT);
    localStorage.setItem(recentKey(project), JSON.stringify(list));
  } catch {
    // no storage: no recent files
  }
}
const SEGMENT = '/._- ';

// In order, rewarding segment starts, runs and the file name; a long path
// costs a little. The file name is tried first, then the whole path.
// ponytail: greedy leftmost match, it can miss a later segment start that
// would score higher; a DP over all alignments if rankings feel off.
export function fuzzy(query, path) {
  const q = query.toLowerCase().replaceAll(' ', '');
  const p = path.toLowerCase();
  const nameAt = path.lastIndexOf('/') + 1;
  if (!q) return null;
  const match = (from) => {
    const at = [];
    let i = from;
    for (const c of q) {
      i = p.indexOf(c, i);
      if (i < 0) return null;
      at.push(i++);
    }
    return at;
  };
  const positions = match(nameAt) || match(0);
  if (!positions) return null;
  let score = -path.length * 0.05;
  positions.forEach((i, k) => {
    score += 1;
    if (i === 0 || SEGMENT.includes(p[i - 1])) score += 8;
    if (k > 0 && positions[k - 1] === i - 1) score += 5;
    else if (k > 0) score -= (i - positions[k - 1] - 1) * 0.2;
    if (i >= nameAt) score += 2;
  });
  return { score, positions };
}

// `text` with the characters at `positions` (offsets from `from`) in <b>.
export function highlight(text, positions, from = 0) {
  const on = new Set(positions.map((i) => i - from));
  return [...text].map((c, i) => (on.has(i) ? `<b>${esc(c)}</b>` : esc(c))).join('');
}

// Best first, at most MAX_ROWS.
export function rank(query, files) {
  const out = [];
  for (const f of files) {
    const m = fuzzy(query, f.path);
    if (m) out.push({ ...f, ...m });
  }
  return out.sort((a, b) => b.score - a.score || a.path.length - b.path.length).slice(0, MAX_ROWS);
}

// Where `query` is in `text`, by the same smart case as fs_grep.
function textAt(text, query) {
  const smart = query === query.toLowerCase();
  return (smart ? text.toLowerCase() : text).indexOf(smart ? query.toLowerCase() : query);
}

// ── Palette ─────────────────────────────────────────────────

const lists = new Map(); // project path -> { files, truncated } of the last opening
// The open palette: { project, mode, el, input, list, foot, rows, sel, back, error, grep }.
// In Testo `rows` are the hits of `grep`, the last answer, kept on screen while
// the next one is `searching`.
let s = null;
let grepSeq = 0; // answers to an older query are dropped
let loadSeq = 0; // same for the file lists
let grepTimer = null;

const nameOf = (path) => path.slice(path.lastIndexOf('/') + 1);
const dirOf = (path) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const extOf = (name) => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '');

function hitRow(h, i, query) {
  const at = textAt(h.text, query);
  const text = at < 0 ? esc(h.text) : `${esc(h.text.slice(0, at))}<b>${esc(h.text.slice(at, at + query.length))}</b>${esc(h.text.slice(at + query.length))}`;
  return `<li class="sr sr-hit${i === s.sel ? ' sel' : ''}" role="option" id="sr-${i}" data-i="${i}" aria-selected="${i === s.sel}">
    <span class="sr-line">${h.line}</span><span class="sr-text">${text}</span>
  </li>`;
}

function groupHead(g) {
  return `<li class="sr-group${g.ignored ? ' ignored' : ''}" role="presentation">
    <span class="ico file" data-ext="${esc(extOf(nameOf(g.path)))}"></span>
    <span class="sr-name">${esc(nameOf(g.path))}</span><span class="sr-dir">${esc(dirOf(g.path))}</span>
    ${g.ignored ? '<span class="sr-tag">ignorato</span>' : ''}<span class="sr-count">${g.hits.length}</span>
  </li>`;
}

function renderText() {
  const query = s.input.value;
  const r = s.grep;
  s.rows = r ? r.groups.flatMap((g) => g.hits.map((h) => ({ ...h, path: g.path }))) : [];
  s.sel = Math.min(s.sel, Math.max(0, s.rows.length - 1));
  let i = 0;
  if (s.error) s.list.innerHTML = `<li class="sr-empty">${esc(s.error)}</li>`;
  else if (query && r && !s.rows.length) s.list.innerHTML = `<li class="sr-empty">Nessun risultato per “${esc(query)}”.</li>`;
  else s.list.innerHTML = (r?.groups || []).map((g) => groupHead(g) + g.hits.map((h) => hitRow(h, i++, query)).join('')).join('');
  s.foot.textContent = !query ? 'Scrivi il testo da cercare'
    : s.searching || !r ? 'Cerco…'
      : r.truncated ? 'Più di 2000 risultati: restringi la ricerca'
        : `${s.rows.length} ${s.rows.length === 1 ? 'risultato' : 'risultati'} in ${r.groups.length} file`;
}

// One request per pause in typing; only the answer to the latest one counts.
function grepSoon() {
  clearTimeout(grepTimer);
  const query = s.input.value;
  const n = ++grepSeq;
  s.searching = !!query;
  if (!query) {
    s.grep = null;
    s.error = null;
    return;
  }
  const { project } = s;
  grepTimer = setTimeout(async () => {
    let r = null;
    let error = null;
    try {
      r = await work.fs.grep(project.path, query);
    } catch (e) {
      error = e?.message || String(e);
    }
    if (n !== grepSeq || s?.project !== project || s.mode !== 'text') return;
    s.grep = r;
    s.error = error;
    s.searching = false;
    s.sel = 0;
    render();
  }, GREP_DELAY);
}

function row(f, i) {
  const nameAt = f.path.lastIndexOf('/') + 1;
  const name = f.path.slice(nameAt);
  const dir = f.path.slice(0, Math.max(0, nameAt - 1));
  const pos = f.positions || [];
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return `<li class="sr${i === s.sel ? ' sel' : ''}${f.ignored ? ' ignored' : ''}" role="option" id="sr-${i}" data-i="${i}" aria-selected="${i === s.sel}">
    <span class="ico file" data-ext="${esc(ext)}"></span>
    <span class="sr-name">${highlight(name, pos.filter((p) => p >= nameAt), nameAt)}</span>
    <span class="sr-dir">${highlight(dir, pos.filter((p) => p < nameAt))}</span>
    ${f.ignored ? '<span class="sr-tag">ignorato</span>' : ''}
  </li>`;
}

function render() {
  s.el.querySelectorAll('.search-modes button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === s.mode)));
  s.el.dataset.mode = s.mode;
  s.input.placeholder = s.mode === 'text' ? `Cerca un testo in ${s.project.name}` : `Cerca un file in ${s.project.name}`;
  if (s.mode === 'text') renderText();
  else renderFiles();
  s.input.setAttribute('aria-activedescendant', s.rows.length ? `sr-${s.sel}` : '');
}

function renderFiles() {
  const query = s.input.value;
  const cached = lists.get(s.project.path);
  if (query) s.rows = cached ? rank(query, cached.files) : [];
  else {
    // Empty field: the recent files (those still there, once the list is known).
    const known = cached && new Map(cached.files.map((f) => [f.path, f]));
    s.rows = recentFiles(s.project).filter((p) => !known || known.has(p)).map((p) => known?.get(p) || { path: p, ignored: false });
  }
  s.sel = Math.min(s.sel, Math.max(0, s.rows.length - 1));
  if (s.error) s.list.innerHTML = `<li class="sr-empty">${esc(s.error)}</li>`;
  else if (query && cached && !s.rows.length) s.list.innerHTML = `<li class="sr-empty">Nessun file con “${esc(query)}”. ⇥ per cercarlo nel testo.</li>`;
  else s.list.innerHTML = (!query && s.rows.length ? '<li class="sr-label" role="presentation">Aperti di recente</li>' : '') + s.rows.map(row).join('');
  s.foot.textContent = !cached ? 'Carico i file…'
    : cached.truncated ? `Elenco parziale: oltre ${cached.files.length.toLocaleString('it')} file`
      : query ? `${s.rows.length}${s.rows.length === MAX_ROWS ? '+' : ''} file` : `${cached.files.length.toLocaleString('it')} file`;
}

function select(i) {
  if (!s.rows.length) return;
  s.sel = (i + s.rows.length) % s.rows.length;
  s.list.querySelectorAll('.sr').forEach((li) => {
    const on = Number(li.dataset.i) === s.sel;
    li.classList.toggle('sel', on);
    li.setAttribute('aria-selected', String(on));
  });
  s.input.setAttribute('aria-activedescendant', `sr-${s.sel}`);
  s.list.querySelector(`#sr-${s.sel}`)?.scrollIntoView({ block: 'nearest' });
}

// ↵ opens the preview; ⌘/Ctrl+↵ shows the file in the tree instead.
function open(i = s.sel, { inTree = false } = {}) {
  const f = s.rows[i];
  if (!f) return;
  const path = `${s.project.path}/${f.path}`;
  remember(s.project, f.path);
  closeSearch({ restoreFocus: false });
  if (inTree) hooks.reveal(path);
  else previewFile(path, { line: f.line });
}

function setMode(mode) {
  if (s.mode === mode) return;
  s.mode = mode;
  s.sel = 0;
  s.error = null;
  if (mode === 'text') grepSoon();
  render();
  s.input.focus();
}

async function load(project) {
  const n = ++loadSeq;
  try {
    const fresh = await work.fs.files(project.path);
    if (n !== loadSeq) return;
    lists.set(project.path, fresh);
    if (s?.project !== project || s.mode !== 'files') return;
    s.error = null;
    // The new list keeps the highlighted file if it is still there.
    const keep = s.rows[s.sel]?.path;
    render();
    const i = s.rows.findIndex((f) => f.path === keep);
    if (i >= 0) select(i);
  } catch (e) {
    if (n !== loadSeq || s?.project !== project || s.mode !== 'files') return;
    s.error = e?.message || String(e);
    render();
  }
}

export const searchOpen = () => !!s;

export function openSearch(project, { mode = 'files' } = {}) {
  if (!project) return;
  if (s) return setMode(mode);
  const veil = document.createElement('div');
  veil.className = 'search-veil';
  const el = document.createElement('div');
  el.className = 'search';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Cerca nel progetto');
  el.innerHTML = `
    <div class="search-head">
      <div class="search-modes" role="tablist" aria-label="Cerca per">
        <span class="search-thumb"></span>
        <button role="tab" data-mode="files" tabindex="-1">File</button><button role="tab" data-mode="text" tabindex="-1">Testo</button>
      </div>
      <span class="search-hint">⇥ cambia</span>
    </div>
    <input class="search-input" role="combobox" aria-expanded="true" aria-controls="search-list" aria-autocomplete="list"
      spellcheck="false" autocomplete="off" placeholder="Cerca un file in ${esc(project.name)}">
    <ul class="search-list" id="search-list" role="listbox"></ul>
    <footer class="search-foot"></footer>`;
  document.body.appendChild(veil);
  document.body.appendChild(el);
  // It grows out of the field in the top bar, and goes back into it.
  const field = document.querySelector('#search-field')?.getBoundingClientRect();
  if (field?.width) {
    const box = el.getBoundingClientRect();
    el.style.transformOrigin = `${field.left + field.width / 2 - box.left}px ${field.top + field.height / 2 - box.top}px`;
  }
  s = {
    project, mode, el, veil, sel: 0, rows: [], error: null, grep: null, back: document.activeElement,
    input: el.querySelector('.search-input'), list: el.querySelector('.search-list'), foot: el.querySelector('.search-foot'),
  };
  veil.onpointerdown = () => closeSearch();
  s.input.oninput = () => {
    s.sel = 0;
    if (s.mode === 'text') grepSoon();
    render();
  };
  el.querySelector('.search-modes').onpointerdown = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    e.preventDefault(); // the focus stays in the field
    setMode(b.dataset.mode);
  };
  // On the whole palette: a click on its header or footer moves the focus off the field.
  el.onkeydown = onKey;
  s.list.onpointermove = (e) => {
    const li = e.target.closest('.sr');
    if (li && Number(li.dataset.i) !== s.sel) select(Number(li.dataset.i));
  };
  s.list.onclick = (e) => {
    const li = e.target.closest('.sr');
    if (li) open(Number(li.dataset.i));
  };
  render();
  s.input.focus();
  if (mode === 'text') grepSoon();
  load(project);
}

function onKey(e) {
  const act = {
    ArrowDown: () => select(s.sel + 1),
    ArrowUp: () => select(s.sel - 1),
    Enter: () => open(s.sel, { inTree: e.metaKey || e.ctrlKey }),
    Escape: () => closeSearch(),
    Tab: () => setMode(s.mode === 'files' ? 'text' : 'files'),
  }[e.key];
  if (!act) return;
  e.preventDefault();
  e.stopPropagation();
  act();
}

export function closeSearch({ restoreFocus = true } = {}) {
  if (!s) return;
  const { el, veil, back } = s;
  s = null;
  clearTimeout(grepTimer);
  leave(el, () => el.remove());
  leave(veil, () => veil.remove());
  if (restoreFocus) back?.focus?.();
}

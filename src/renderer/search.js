// Search palette: files of the active project by name (fuzzy, in the page,
// no backend call per key). The file list comes from fs_files at every
// opening; the previous list of the same project shows meanwhile.
import { $, esc, leave } from './ui.js';
import { previewFile } from './preview.js';

const { work } = window;
const MAX_ROWS = 200;
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

// ── Palette ─────────────────────────────────────────────────

const lists = new Map(); // project path -> { files, truncated } of the last opening
let s = null; // the open palette: { project, el, input, list, foot, rows, sel, back, error }

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
  const query = s.input.value;
  const cached = lists.get(s.project.path);
  s.rows = query && cached ? rank(query, cached.files) : [];
  s.sel = Math.min(s.sel, Math.max(0, s.rows.length - 1));
  if (s.error) s.list.innerHTML = `<li class="sr-empty">${esc(s.error)}</li>`;
  else if (query && cached && !s.rows.length) s.list.innerHTML = `<li class="sr-empty">Nessun file con “${esc(query)}”.</li>`;
  else s.list.innerHTML = s.rows.map(row).join('');
  s.input.setAttribute('aria-activedescendant', s.rows.length ? `sr-${s.sel}` : '');
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

function open(i = s.sel) {
  const f = s.rows[i];
  if (!f) return;
  const path = `${s.project.path}/${f.path}`;
  closeSearch({ restoreFocus: false });
  previewFile(path);
}

async function load(project) {
  try {
    const fresh = await work.fs.files(project.path);
    lists.set(project.path, fresh);
    if (s?.project !== project) return;
    s.error = null;
    // The new list keeps the highlighted file if it is still there.
    const keep = s.rows[s.sel]?.path;
    render();
    const i = s.rows.findIndex((f) => f.path === keep);
    if (i >= 0) select(i);
  } catch (e) {
    if (s?.project !== project) return;
    s.error = e?.message || String(e);
    render();
  }
}

export const searchOpen = () => !!s;

export function openSearch(project) {
  if (!project) return;
  if (s) return s.input.focus();
  const veil = document.createElement('div');
  veil.className = 'search-veil';
  const el = document.createElement('div');
  el.className = 'search';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Cerca nel progetto');
  el.innerHTML = `
    <input class="search-input" role="combobox" aria-expanded="true" aria-controls="search-list" aria-autocomplete="list"
      spellcheck="false" autocomplete="off" placeholder="Cerca un file in ${esc(project.name)}">
    <ul class="search-list" id="search-list" role="listbox"></ul>
    <footer class="search-foot"></footer>`;
  document.body.append(veil, el);
  s = {
    project, el, veil, sel: 0, rows: [], error: null, back: document.activeElement,
    input: el.querySelector('.search-input'), list: el.querySelector('.search-list'), foot: el.querySelector('.search-foot'),
  };
  veil.onpointerdown = () => closeSearch();
  s.input.oninput = () => { s.sel = 0; render(); };
  s.input.onkeydown = onKey;
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
  load(project);
}

function onKey(e) {
  const act = {
    ArrowDown: () => select(s.sel + 1),
    ArrowUp: () => select(s.sel - 1),
    Enter: () => open(),
    Escape: () => closeSearch(),
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
  leave(el, () => el.remove());
  leave(veil, () => veil.remove());
  if (restoreFocus) back?.focus?.();
}

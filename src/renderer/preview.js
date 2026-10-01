// File preview sheet: source with line numbers, plus rendered view for
// Markdown (sanitized), HTML (sandboxed iframe loading the real file, no scripts,
// so relative CSS and images resolve) and images.
import { marked } from './vendor/marked.esm.js';
import DOMPurify from './vendor/purify.es.mjs';
import { $, $$, esc, basename, dirname, leave, toast, toastError } from './ui.js';
import { insertChunked, resetChunks } from './chunks.js';

const { work } = window;

// { path, kind, text (null for binary images), onDiff, line, mtime, editable,
//   edit: { crlf, orig, dirty } while the file is being edited }
let current = null;
let zoom = null; // controls of the image on screen, if any

const fileUrl = (p) => `file://${p.split('/').map(encodeURIComponent).join('/')}`;
// What the page loads a local file from: Tauri serves them through its asset
// protocol (file: URLs don't load there). The leading "/" is encoded so that
// relative paths, "../" included, resolve like in a folder.
const srcUrl = (p) => (globalThis.__TAURI__ ? `asset://localhost/%2F${p.slice(1).split('/').map(encodeURIComponent).join('/')}` : fileUrl(p));

function kindOf(path) {
  const e = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (['md', 'markdown', 'mdx'].includes(e)) return 'md';
  if (['html', 'htm'].includes(e)) return 'html';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg'].includes(e)) return 'image';
  return 'text';
}

function getView(kind) {
  if (kind === 'text') return 'source';
  try {
    return localStorage.getItem(`work.preview.${kind}`) || 'rendered';
  } catch {
    return 'rendered';
  }
}
function setView(kind, v) {
  try {
    localStorage.setItem(`work.preview.${kind}`, v);
  } catch {
    // no storage: remember for this session only
  }
}

// Image zoom: fits the sheet by default. Click toggles actual size, Ctrl/⌘ +
// wheel or a trackpad pinch zooms around the pointer, drag pans, + − 0 keys.
function zoomable(box, img, label) {
  let z = null; // null: fit the sheet
  const fit = () => Math.min(1, (box.clientWidth - 48) / img.naturalWidth, (box.clientHeight - 48) / img.naturalHeight);
  const scale = () => z ?? fit();
  const show = () => { label.textContent = img.naturalWidth ? `${Math.round(scale() * 100)}%` : ''; };
  // Zooms to `next` (at most 16×; at or below "fit" it fits again), keeping the
  // image point under (x, y) still, so the image grows out of the pointer.
  const set = (next, x, y) => {
    if (!img.naturalWidth) return;
    const b = box.getBoundingClientRect();
    const r = img.getBoundingClientRect();
    x ??= b.left + box.clientWidth / 2;
    y ??= b.top + box.clientHeight / 2;
    const fx = (x - r.left) / r.width;
    const fy = (y - r.top) / r.height;
    z = next <= fit() * 1.001 ? null : Math.min(next, 16);
    box.classList.toggle('zoomed', z != null);
    img.style.width = z == null ? '' : `${img.naturalWidth * z}px`;
    box.scrollLeft = img.offsetLeft + fx * img.offsetWidth - (x - b.left);
    box.scrollTop = img.offsetTop + fy * img.offsetHeight - (y - b.top);
    show();
  };
  // Fit ↔ actual size (2× when the image already fits at 100%).
  const toggle = (x, y) => set(z == null ? (fit() < 1 ? 1 : 2) : 0, x, y);

  img.onload = show;
  box.onwheel = (e) => {
    if (!e.ctrlKey && !e.metaKey) return; // a plain wheel scrolls
    e.preventDefault();
    set(scale() * Math.exp(-Math.max(-50, Math.min(50, e.deltaY)) * 0.005), e.clientX, e.clientY);
  };
  // ponytail: pan stops dead on release, add momentum if it feels stiff.
  img.onpointerdown = (e) => {
    if (e.button !== 0) return;
    const start = { x: e.clientX, y: e.clientY, left: box.scrollLeft, top: box.scrollTop };
    let panned = false;
    img.setPointerCapture(e.pointerId);
    img.onpointermove = (m) => {
      panned ||= Math.hypot(m.clientX - start.x, m.clientY - start.y) > 4;
      if (!panned) return;
      box.classList.add('panning');
      box.scrollLeft = start.left - (m.clientX - start.x);
      box.scrollTop = start.top - (m.clientY - start.y);
    };
    img.onpointerup = img.onpointercancel = (u) => {
      img.onpointermove = img.onpointerup = img.onpointercancel = null;
      box.classList.remove('panning');
      if (!panned && u.type === 'pointerup') toggle(u.clientX, u.clientY);
    };
  };
  return { by: (k) => set(scale() * k), fit: () => set(0), toggle: () => toggle() };
}

// ── .env files ──────────────────────────────────────────────
// Values are shown when the file opens; the eye on a line or "Nascondi
// valori" covers them, for this opening only.
export const isEnvFile = (path) => basename(path).startsWith('.env');
const ENV_LINE = /^(\s*(?:export\s+)?[A-Za-z_][\w.-]*)(\s*=\s*)(.*)$/;

// { comment } for a comment, { key, eq, value } for NAME=value, null otherwise.
export function envLine(line) {
  line = line.replace(/\r$/, ''); // "." doesn't match \r: a CRLF .env would show no value to hide
  if (/^\s*#/.test(line)) return { comment: line };
  const m = ENV_LINE.exec(line);
  return m && { key: m[1], eq: m[2], value: m[3] };
}

const EYE = '<svg width="14" height="10" viewBox="0 0 14 10" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M1 5C2.6 2.2 4.6.8 7 .8s4.4 1.4 6 4.2c-1.6 2.8-3.6 4.2-6 4.2S2.6 7.8 1 5Z"/><circle cx="7" cy="5" r="1.8"/></svg>';

function envHtml(l, i) {
  const e = envLine(l);
  if (!e) return esc(l);
  if (e.comment != null) return `<span class="env-comment">${esc(e.comment)}</span>`;
  const hidden = current.hideAll || current.hidden.has(i);
  const value = hidden && e.value ? '<span class="env-masked">••••••••••</span>' : esc(e.value);
  const eye = e.value ? `<button class="env-eye${hidden ? ' off' : ''}" data-l="${i}" title="${hidden ? 'Mostra' : 'Nascondi'} il valore" aria-label="${hidden ? 'Mostra' : 'Nascondi'} il valore">${EYE}</button>` : '';
  return `<span class="env-key">${esc(e.key)}</span>${esc(e.eq)}<span class="env-val">${value}</span>${eye}`;
}

// Up to 1 MB of text: inserted in blocks so large files open without freezing.
function drawSource(body, text) {
  const env = isEnvFile(current.path);
  const lines = text.split('\n').map((l, i) => `<span class="ln">${i + 1}</span><span class="code">${(env ? envHtml(l, i) : esc(l)) || '&nbsp;'}</span>`);
  body.innerHTML = '<div class="pv-source"></div>';
  const host = body.firstChild;
  return insertChunked(body, lines, { size: 500, className: 'pv', place: (el) => host.append(el) });
}

// A line found by the search: centred, and marked by the flash. Off-screen
// blocks have an estimated height, so the scroll is redone once laid out.
async function jumpTo(line) {
  const ln = $('#viewer-body').querySelectorAll('.pv .ln')[line - 1];
  if (!ln) return;
  for (let i = 0; i < 2; i++) {
    ln.scrollIntoView({ block: 'center' });
    await new Promise(requestAnimationFrame);
  }
  for (const el of [ln, ln.nextElementSibling]) {
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }
}

function markdownHtml(text, path) {
  const html = DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: false }));
  const box = document.createElement('article');
  box.className = 'md-body';
  box.innerHTML = html;
  // Resolve relative images/links against the file's folder.
  const base = `${fileUrl(dirname(path))}/`;
  const srcBase = `${srcUrl(dirname(path))}/`;
  for (const img of box.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src');
    if (!/^(https?:|data:|file:)/.test(src)) img.src = new URL(src, srcBase).href;
  }
  for (const a of box.querySelectorAll('a[href]')) {
    const target = linkTarget(a.getAttribute('href'), base);
    if (target.anchor) continue;
    if (target.external) a.dataset.external = target.external;
    else a.dataset.local = target.local;
    a.removeAttribute('href');
    a.tabIndex = 0;
  }
  return box.outerHTML;
}

// Where a Markdown link goes: web and mail links open outside Work, relative
// (or file:) links open that file in the preview, anchors stay in the page.
export function linkTarget(href, base) {
  if (href.startsWith('#')) return { anchor: true };
  if (/^[a-z][a-z\d+.-]*:/i.test(href) && !/^file:/i.test(href)) return { external: href };
  return { local: decodeURIComponent(new URL(href, base).pathname) };
}

// Lines, bytes, encoding, and what Esc does now.
function drawFoot() {
  const { text, size, utf8, edit: editing } = current;
  const facts = [];
  if (text != null && size != null) facts.push(`${text.split('\n').length.toLocaleString('it')} righe`);
  if (size != null) facts.push(`${size.toLocaleString('it')} byte`);
  if (text != null && utf8 != null) facts.push(utf8 ? 'UTF-8' : 'non UTF-8');
  $('#viewer-foot').innerHTML = `<span>${facts.join(' · ')}</span><span><kbd>esc</kbd> ${editing ? 'Annulla' : 'Chiudi'}</span>`;
}

function draw() {
  drawFoot();
  const { path, kind, text } = current;
  // Raster images have no source to show; SVG keeps the toggle. A line to
  // show (from the search) is in the source.
  const view = text == null ? 'rendered' : current.line ? 'source' : getView(kind);
  const body = $('#viewer-body');
  $('#viewer-mode').hidden = kind === 'text' || text == null;
  $$('#viewer-mode button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  body.scrollTop = 0;
  body.classList.toggle('rendered', view === 'rendered');

  resetChunks(body);
  zoom = null;
  const zoomLabel = $('#pv-zoom');
  if (zoomLabel) zoomLabel.hidden = view !== 'rendered';
  if (view === 'source') return drawSource(body, text);
  else if (kind === 'md') body.innerHTML = markdownHtml(text, path);
  else if (kind === 'image') {
    // Timestamp so an image edited since the last preview isn't served from cache.
    body.innerHTML = `<div class="pv-image"><img src="${esc(srcUrl(path))}?${Date.now()}" alt="${esc(path)}" draggable="false"></div>`;
    const box = body.querySelector('.pv-image');
    zoom = zoomable(box, box.querySelector('img'), zoomLabel);
  } else {
    // Scripts only when asked for, for this file: one could read the other
    // files of the open projects. Never allow-same-origin (Work's page and
    // API) nor allow-modals (a page's alert() would block the whole window).
    const sandbox = current.scripts ? 'allow-scripts allow-forms' : 'allow-forms';
    body.innerHTML = `<iframe class="html-frame" sandbox="${sandbox}" src="${esc(srcUrl(path))}"></iframe>`;
  }
}

// ── Editing ─────────────────────────────────────────────────
// The text is edited with \n line ends; a file written with \r\n gets them back.
export const toLF = (text) => text.replaceAll('\r\n', '\n');
export const fromLF = (text, crlf) => (crlf ? text.replaceAll('\n', '\r\n') : text);
export const mixedEol = (text) => text.includes('\r\n') && /(^|[^\r])\n/.test(text);

const editor = () => $('#viewer-body').querySelector('.pv-edit-text');

function lineNumbers(ta) {
  const n = ta.value.split('\n').length;
  const box = $('#viewer-body').querySelector('.pv-edit-lines');
  if (box.dataset.n !== String(n)) {
    box.dataset.n = String(n);
    box.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n');
  }
}

// The backend asks before closing or quitting while this is on.
const unsaved = (on) => work.app?.setUnsaved?.(on);

function setDirty(dirty) {
  if (dirty !== current.edit.dirty) unsaved(dirty);
  current.edit.dirty = dirty;
  $('#viewer-dirty').hidden = !dirty;
  current.edit.saveBtn.disabled = !dirty;
}

function startEdit() {
  const text = toLF(current.text);
  current.edit = { crlf: current.text.includes('\r\n'), orig: text, dirty: false };
  $('#viewer-mode').hidden = true;
  const body = $('#viewer-body');
  resetChunks(body);
  body.classList.remove('rendered');
  drawFoot();
  body.innerHTML = '<div class="pv-edit"><pre class="pv-edit-lines" aria-hidden="true"></pre><textarea class="pv-edit-text" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="Testo del file"></textarea></div>';
  const ta = editor();
  ta.value = text;
  lineNumbers(ta);
  ta.oninput = () => {
    lineNumbers(ta);
    setDirty(ta.value !== current.edit.orig);
  };
  ta.onscroll = () => { body.querySelector('.pv-edit-lines').scrollTop = ta.scrollTop; };
  drawActions();
  ta.focus();
  ta.setSelectionRange(0, 0);
}

function stopEdit() {
  if (current.edit?.dirty) unsaved(false);
  current.edit = null;
  hideBar();
  hideConflict();
  $('#viewer-dirty').hidden = true;
  draw();
  drawActions();
}

// The text area is read-only while the write runs: a key typed meanwhile
// would be lost when the preview comes back, and a second ⌘S would race it.
async function save(force = false) {
  if (!current?.edit?.dirty || current.edit.saving) return;
  const { path, edit } = current;
  const ta = editor();
  const text = fromLF(ta.value, edit.crlf);
  edit.saving = true;
  ta.readOnly = true;
  try {
    const r = await work.fs.write(path, text, current.mtime, force, current.size);
    if (current?.path !== path) return;
    current.mtime = r.mtime;
    current.text = text;
    current.size = r.size ?? new TextEncoder().encode(text).length;
    current.hidden.clear(); // hidden by line number: lines may have moved
    stopEdit();
    toast(`${basename(path)} salvato`);
  } catch (e) {
    if (String(e?.message ?? e) === 'CHANGED') showConflict();
    else toastError(e); // the edits stay
  } finally {
    edit.saving = false;
    ta.readOnly = false;
  }
}

// Saved by someone else meanwhile (a terminal, git): the user picks which
// version wins. The edits stay until then.
function showConflict() {
  if (!current?.edit) return;
  const strip = $('#viewer-conflict');
  strip.innerHTML = `<span class="pv-bar-text"><b>${esc(basename(current.path))}</b> è cambiato su disco da quando l'hai aperto.</span>
    <button class="btn btn-small pv-reload">Ricarica dal disco</button><button class="btn btn-small pv-overwrite">Sovrascrivi</button>`;
  strip.hidden = false;
  strip.querySelector('.pv-reload').onclick = reload;
  strip.querySelector('.pv-overwrite').onclick = () => {
    hideConflict();
    save(true);
  };
}

function hideConflict() {
  $('#viewer-conflict').hidden = true;
}

// The disk's version replaces the edits, still in the editor.
async function reload() {
  const { path } = current;
  let r;
  try {
    r = await work.fs.read(path);
  } catch (e) {
    return toastError(e);
  }
  if (current?.path !== path || !current.edit || r.text == null) return;
  hideConflict();
  current.text = r.text;
  current.mtime = r.mtime;
  current.size = r.size;
  current.edit.crlf = r.text.includes('\r\n');
  current.edit.orig = toLF(r.text);
  const ta = editor();
  ta.value = current.edit.orig;
  lineNumbers(ta);
  setDirty(false);
  ta.focus();
}

// Unsaved edits are never dropped silently: a bar asks first. `then` runs
// once they are discarded.
export function guardEdits(then) {
  if (!current?.edit?.dirty) return then();
  const bar = $('#viewer-bar');
  bar.innerHTML = `<span class="pv-bar-text">Hai modifiche non salvate in <b>${esc(basename(current.path))}</b>.</span>
    <button class="btn btn-small pv-discard">Scarta</button><button class="btn btn-small btn-accent pv-keep">Continua a modificare</button>`;
  bar.hidden = false;
  bar.querySelector('.pv-discard').onclick = () => {
    current.edit.dirty = false;
    unsaved(false);
    hideBar();
    then();
  };
  const keep = bar.querySelector('.pv-keep');
  keep.onclick = () => {
    hideBar();
    editor()?.focus();
  };
  keep.focus();
}

function hideBar() {
  $('#viewer-bar').hidden = true;
}

const cancelEdit = () => guardEdits(stopEdit);

function drawActions() {
  const { path, kind, text, onDiff } = current;
  const actions = $('#viewer-actions');
  actions.innerHTML = '';
  const add = (label, run) => {
    const b = document.createElement('button');
    b.className = 'btn btn-small';
    b.textContent = label;
    b.onclick = run;
    actions.appendChild(b);
    return b;
  };
  if (current.edit) {
    add('Annulla', cancelEdit);
    const b = add(`Salva ${document.body.classList.contains('mac') ? '⌘S' : 'Ctrl+S'}`, () => save());
    b.classList.add('btn-accent');
    b.disabled = !current.edit.dirty;
    current.edit.saveBtn = b;
    return;
  }
  if (kind === 'image') {
    const b = add('', () => zoom?.toggle());
    b.id = 'pv-zoom';
    b.classList.add('pv-zoom');
    b.title = 'Adatta ↔ 100% · Ctrl/⌘ + rotella o pinch per lo zoom · + − 0';
  }
  if (kind === 'html' && text != null) {
    const b = add('Esegui script', () => {
      current.scripts = !current.scripts;
      b.classList.toggle('active', current.scripts);
      draw();
    });
    b.classList.toggle('active', !!current.scripts);
    b.title = 'Esegue il JavaScript della pagina (può leggere gli altri file dei progetti aperti)';
  }
  if (current.editable) add('Modifica', startEdit);
  if (isEnvFile(path) && text) {
    add(current.hideAll ? 'Mostra valori' : 'Nascondi valori', () => {
      current.hideAll = !current.hideAll;
      current.hidden.clear();
      drawActions();
      draw();
    });
  }
  if (onDiff) add('Mostra differenze', () => requestClose(onDiff));
  add('Apri con app di sistema', () => work.fs.openPath(path));
}

export async function previewFile(path, opts = {}) {
  if (current?.edit?.dirty) return guardEdits(() => { current.edit = null; previewFile(path, opts); });
  const { onDiff, line } = opts;
  let r;
  try {
    r = await work.fs.read(path);
  } catch (e) {
    return toastError(e);
  }
  const kind = kindOf(path);
  const image = kind === 'image';
  current = {
    path, kind: r.text != null || image ? kind : 'text', text: r.text ?? (image ? null : ''), onDiff, line,
    // Mixed line ends (\r\n and \n) can't round-trip through a text area,
    // which reads them all as \n: such a file is not editable here.
    mtime: r.mtime, editable: r.utf8 === true && r.text != null && !image && !mixedEol(r.text), edit: null,
    size: r.size, utf8: r.utf8, hideAll: false, hidden: new Set(),
  };
  $('#viewer-title').innerHTML = `<bdi>${esc(path)}</bdi>`;
  $('#viewer-dirty').hidden = true;
  hideBar();
  hideConflict();
  drawActions();

  drawFoot();
  if (!image && (r.binary || r.tooBig)) {
    $('#viewer-mode').hidden = true;
    $('#viewer-body').innerHTML = r.binary ? '<div class="d-empty">File binario.</div>'
      : `<div class="d-empty">File troppo grande per l'anteprima (${Math.round(r.size / 1024)} KB).</div>`;
  } else {
    const drawn = draw();
    if (line) {
      $('#viewer').hidden = false;
      await drawn;
      if (current?.path !== path) return; // closed or replaced meanwhile
      current.line = null; // the view toggle shows the chosen view again
      return jumpTo(line);
    }
  }
  $('#viewer').hidden = false;
}

// ✕, Esc and a click outside: unsaved edits are asked about first.
export function requestClose(then) {
  guardEdits(() => closeViewer(then));
}

export function closeViewer(then) {
  const v = $('#viewer');
  if (v.hidden) return;
  hideBar();
  hideConflict();
  leave(v, () => {
    v.hidden = true;
    $('#viewer-body').innerHTML = ''; // unload iframes
    current = null;
    zoom = null;
    if (typeof then === 'function') then();
  });
}

$$('#viewer-mode button').forEach((b) => {
  b.onpointerdown = () => {
    if (!current) return;
    setView(current.kind, b.dataset.view);
    draw();
  };
});
$('#viewer-close').onclick = () => requestClose();
// ⌘Q or the window's close button with unsaved edits: the same question first.
work.app?.onQuitRequested?.(() => guardEdits(() => work.app.quit()));
$('#viewer').addEventListener('pointerdown', (e) => e.target.id === 'viewer' && requestClose());
$('#viewer-body').addEventListener('click', (e) => {
  const eye = e.target.closest('.env-eye');
  if (eye) {
    // One line: shown again if it was covered by "Nascondi valori" too.
    const i = Number(eye.dataset.l);
    const hidden = current.hideAll || current.hidden.has(i);
    if (current.hideAll) {
      current.hideAll = false;
      current.text.split('\n').forEach((l, j) => envLine(l)?.value && current.hidden.add(j));
      drawActions();
    }
    if (hidden) current.hidden.delete(i);
    else current.hidden.add(i);
    const top = $('#viewer-body').scrollTop;
    draw();
    $('#viewer-body').scrollTop = top;
    return;
  }
  const a = e.target.closest('a[data-external], a[data-local]');
  if (!a) return;
  if (a.dataset.external) work.app.openExternal(a.dataset.external);
  else previewFile(a.dataset.local.split('#')[0]);
});
addEventListener('keydown', (e) => {
  if ($('#viewer').hidden) return;
  if (current?.edit && (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
    e.preventDefault();
    return save();
  }
  if (e.key === 'Escape') {
    if (!$('#viewer-bar').hidden) return $('#viewer-bar').querySelector('.pv-keep').onclick();
    return current?.edit ? cancelEdit() : requestClose();
  }
  if (current?.edit) return;
  const act = zoom && { '+': () => zoom.by(1.25), '=': () => zoom.by(1.25), '-': () => zoom.by(0.8), 0: () => zoom.fit() }[e.key];
  if (act) {
    e.preventDefault();
    act();
  }
});

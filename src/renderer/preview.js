// File preview sheet: source with line numbers, plus rendered view for
// Markdown (sanitized), HTML (sandboxed iframe loading the real file,
// so relative CSS/images/scripts resolve) and images.
import { marked } from '../../node_modules/marked/lib/marked.esm.js';
import DOMPurify from '../../node_modules/dompurify/dist/purify.es.mjs';
import { $, $$, esc, dirname, leave, toastError } from './ui.js';
import { insertChunked, resetChunks } from './chunks.js';

const { work } = window;

let current = null; // { path, kind, text (null for binary images), onDiff }

const fileUrl = (p) => `file://${p.split('/').map(encodeURIComponent).join('/')}`;

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

// Up to 1 MB of text: inserted in blocks so large files open without freezing.
function drawSource(body, text) {
  const lines = text.split('\n').map((l, i) => `<span class="ln">${i + 1}</span><span class="code">${esc(l) || '&nbsp;'}</span>`);
  body.innerHTML = '<div class="pv-source"></div>';
  const host = body.firstChild;
  insertChunked(body, lines, { size: 500, className: 'pv', place: (el) => host.append(el) });
}

function markdownHtml(text, path) {
  const html = DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: false }));
  const box = document.createElement('article');
  box.className = 'md-body';
  box.innerHTML = html;
  // Resolve relative images/links against the file's folder.
  const base = `${fileUrl(dirname(path))}/`;
  for (const img of box.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src');
    if (!/^(https?:|data:|file:)/.test(src)) img.src = new URL(src, base).href;
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

function draw() {
  const { path, kind, text } = current;
  // Raster images have no source to show; SVG keeps the toggle.
  const view = text == null ? 'rendered' : getView(kind);
  const body = $('#viewer-body');
  $('#viewer-mode').hidden = kind === 'text' || text == null;
  $$('#viewer-mode button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  body.scrollTop = 0;
  body.classList.toggle('rendered', view === 'rendered');

  resetChunks(body);
  if (view === 'source') drawSource(body, text);
  else if (kind === 'md') body.innerHTML = markdownHtml(text, path);
  else if (kind === 'image') {
    // Timestamp so an image edited since the last preview isn't served from cache.
    body.innerHTML = `<div class="pv-image"><img src="${esc(fileUrl(path))}?${Date.now()}" alt="${esc(path)}"></div>`;
  } else {
    // No allow-same-origin: the page's scripts can't reach Work or the file system API.
    // No allow-modals: a page's alert() would block Work's whole window.
    body.innerHTML = `<iframe class="html-frame" sandbox="allow-scripts allow-forms" src="${esc(fileUrl(path))}"></iframe>`;
  }
}

export async function previewFile(path, { onDiff } = {}) {
  let r;
  try {
    r = await work.fs.read(path);
  } catch (e) {
    return toastError(e);
  }
  const kind = kindOf(path);
  const image = kind === 'image';
  current = { path, kind: r.text != null || image ? kind : 'text', text: r.text ?? (image ? null : ''), onDiff };
  $('#viewer-title').innerHTML = `<bdi>${esc(path)}</bdi>`;

  const actions = $('#viewer-actions');
  actions.innerHTML = '';
  const add = (label, run) => {
    const b = document.createElement('button');
    b.className = 'btn btn-small';
    b.textContent = label;
    b.onclick = run;
    actions.appendChild(b);
  };
  if (onDiff) add('Mostra differenze', () => closeViewer(onDiff));
  add('Apri con app di sistema', () => work.fs.openPath(path));

  if (!image && (r.binary || r.tooBig)) {
    $('#viewer-mode').hidden = true;
    $('#viewer-body').innerHTML = r.binary ? '<div class="d-empty">File binario.</div>'
      : `<div class="d-empty">File troppo grande per l'anteprima (${Math.round(r.size / 1024)} KB).</div>`;
  } else draw();
  $('#viewer').hidden = false;
}

export function closeViewer(then) {
  const v = $('#viewer');
  if (v.hidden) return;
  leave(v, () => {
    v.hidden = true;
    $('#viewer-body').innerHTML = ''; // unload iframes
    current = null;
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
$('#viewer-close').onclick = () => closeViewer();
$('#viewer').addEventListener('pointerdown', (e) => e.target.id === 'viewer' && closeViewer());
$('#viewer-body').addEventListener('click', (e) => {
  const a = e.target.closest('a[data-external], a[data-local]');
  if (!a) return;
  if (a.dataset.external) work.app.openExternal(a.dataset.external);
  else previewFile(a.dataset.local.split('#')[0]);
});
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#viewer').hidden) closeViewer();
});

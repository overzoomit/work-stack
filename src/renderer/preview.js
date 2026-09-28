// File preview sheet: source with line numbers, plus rendered view for
// Markdown (sanitized) and HTML (sandboxed iframe loading the real file,
// so relative CSS/images/scripts resolve).
import { marked } from '../../node_modules/marked/lib/marked.esm.js';
import DOMPurify from '../../node_modules/dompurify/dist/purify.es.mjs';
import { $, $$, esc, dirname, leave, toastError } from './ui.js';

const { work } = window;

let current = null; // { path, kind, text, onDiff }

const fileUrl = (p) => `file://${p.split('/').map(encodeURIComponent).join('/')}`;

function kindOf(path) {
  const e = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (['md', 'markdown', 'mdx'].includes(e)) return 'md';
  if (['html', 'htm'].includes(e)) return 'html';
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

function sourceHtml(text) {
  return `<div class="pv">${text.split('\n').map((l, i) => `<span class="ln">${i + 1}</span><span class="code">${esc(l) || '&nbsp;'}</span>`).join('')}</div>`;
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
    const href = a.getAttribute('href');
    if (href.startsWith('#')) continue;
    if (/^https?:/.test(href)) a.dataset.external = href;
    else a.dataset.local = decodeURIComponent(new URL(href, base).pathname);
    a.removeAttribute('href');
    a.tabIndex = 0;
  }
  return box.outerHTML;
}

function draw() {
  const { path, kind, text } = current;
  const view = getView(kind);
  const body = $('#viewer-body');
  $('#viewer-mode').hidden = kind === 'text';
  $$('#viewer-mode button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  body.scrollTop = 0;
  body.classList.toggle('rendered', view === 'rendered');

  if (view === 'source') body.innerHTML = sourceHtml(text);
  else if (kind === 'md') body.innerHTML = markdownHtml(text, path);
  else {
    // No allow-same-origin: the page's scripts can't reach Work or the file system API.
    body.innerHTML = `<iframe class="html-frame" sandbox="allow-scripts allow-forms allow-modals" src="${esc(fileUrl(path))}"></iframe>`;
  }
}

export async function previewFile(path, { onDiff } = {}) {
  let r;
  try {
    r = await work.fs.read(path);
  } catch (e) {
    return toastError(e);
  }
  current = { path, kind: r.text != null ? kindOf(path) : 'text', text: r.text ?? '', onDiff };
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

  if (r.binary || r.tooBig) {
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

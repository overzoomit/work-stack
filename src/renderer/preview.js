// File preview sheet: source with line numbers, plus rendered view for
// Markdown (sanitized), HTML (sandboxed iframe loading the real file, no scripts,
// so relative CSS and images resolve) and images.
import { marked } from './vendor/marked.esm.js';
import DOMPurify from './vendor/purify.es.mjs';
import { $, $$, esc, dirname, leave, toastError } from './ui.js';
import { insertChunked, resetChunks } from './chunks.js';

const { work } = window;

let current = null; // { path, kind, text (null for binary images), onDiff }
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

// Up to 1 MB of text: inserted in blocks so large files open without freezing.
function drawSource(body, text) {
  const lines = text.split('\n').map((l, i) => `<span class="ln">${i + 1}</span><span class="code">${esc(l) || '&nbsp;'}</span>`);
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

function draw() {
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

export async function previewFile(path, { onDiff, line } = {}) {
  let r;
  try {
    r = await work.fs.read(path);
  } catch (e) {
    return toastError(e);
  }
  const kind = kindOf(path);
  const image = kind === 'image';
  current = { path, kind: r.text != null || image ? kind : 'text', text: r.text ?? (image ? null : ''), onDiff, line };
  $('#viewer-title').innerHTML = `<bdi>${esc(path)}</bdi>`;

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
  if (image) {
    const b = add('', () => zoom?.toggle());
    b.id = 'pv-zoom';
    b.classList.add('pv-zoom');
    b.title = 'Adatta ↔ 100% · Ctrl/⌘ + rotella o pinch per lo zoom · + − 0';
  }
  if (kind === 'html' && r.text != null) {
    const b = add('Esegui script', () => {
      current.scripts = !current.scripts;
      b.classList.toggle('active', current.scripts);
      draw();
    });
    b.title = 'Esegue il JavaScript della pagina (può leggere gli altri file dei progetti aperti)';
  }
  if (onDiff) add('Mostra differenze', () => closeViewer(onDiff));
  add('Apri con app di sistema', () => work.fs.openPath(path));

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

export function closeViewer(then) {
  const v = $('#viewer');
  if (v.hidden) return;
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
$('#viewer-close').onclick = () => closeViewer();
$('#viewer').addEventListener('pointerdown', (e) => e.target.id === 'viewer' && closeViewer());
$('#viewer-body').addEventListener('click', (e) => {
  const a = e.target.closest('a[data-external], a[data-local]');
  if (!a) return;
  if (a.dataset.external) work.app.openExternal(a.dataset.external);
  else previewFile(a.dataset.local.split('#')[0]);
});
addEventListener('keydown', (e) => {
  if ($('#viewer').hidden) return;
  if (e.key === 'Escape') return closeViewer();
  const act = zoom && { '+': () => zoom.by(1.25), '=': () => zoom.by(1.25), '-': () => zoom.by(0.8), 0: () => zoom.fit() }[e.key];
  if (act) {
    e.preventDefault();
    act();
  }
});

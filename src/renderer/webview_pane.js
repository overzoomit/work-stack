// Docked browser preview: an iframe pane with its own address bar, history and
// viewport switch, opened next to the terminals (terminals.js owns the split
// tree). Snapshot asks the backend for a PNG of the screen for QA checks.
import { toast, toastError } from './ui.js';
import { findLocalUrl } from './runurl.js';

const { work } = window;

let counter = 0;

// Only web pages: a mistyped scheme must not turn the pane into a file reader.
// "localhost:5173" becomes "http://localhost:5173", the way a browser does.
export function normalizePreviewUrl(input) {
  let text = String(input ?? '').trim();
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.href;
}

export const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return url || '';
  }
};

// Watches terminal output for a dev server address. Only complete lines are
// searched, so an address split across two chunks is read once its line ends.
// Each pane announces a given address once; another port (a restart) is new.
export function createPortWatcher(onFound, { limit = 4096 } = {}) {
  const buffers = new Map(); // pane id -> tail of the unfinished line
  const seen = new Map(); // pane id -> addresses already announced
  return function consume(pane, data) {
    if (!pane || typeof pane.id === 'undefined') return null;
    const text = (buffers.get(pane.id) || '') + String(data ?? '');
    const end = text.lastIndexOf('\n') + 1;
    buffers.set(pane.id, text.slice(end).slice(-limit));
    const url = findLocalUrl(text.slice(0, end));
    if (!url) return null;
    const announced = seen.get(pane.id) || new Set();
    if (announced.has(url)) return null;
    announced.add(url);
    seen.set(pane.id, announced);
    pane.previewUrl = url;
    onFound?.(pane, url);
    return url;
  };
}

function paintTitle(pane) {
  pane.el.querySelector('.pane-title').textContent = pane.url ? hostOf(pane.url) : pane.title;
  pane.el.querySelector('.pane-cwd').textContent = pane.url || '';
}

// `project` is the owning project; the pane object matches what terminals.js
// keeps in its layout tree, so it can share the same split geometry.
export function createWebviewPane(project, { url = null, title = 'Browser preview' } = {}) {
  const id = -1 - counter++;
  const start = normalizePreviewUrl(url);
  const el = document.createElement('div');
  el.className = 'pane tiled webview-pane';
  el.innerHTML = `
    <div class="pane-head">
      <span class="dot web"></span>
      <span class="pane-title"></span>
      <span class="pane-badge webview-badge" title="Docked web preview">WEB</span>
      <span class="pane-cwd"></span>
      <div class="spacer"></div>
      <button class="icon-btn" data-act="viewport" title="Toggle mobile viewport">▯</button>
      <button class="icon-btn" data-act="snapshot" title="Snapshot for QA">◉</button>
      <button class="icon-btn" data-act="max" title="Maximize (Ctrl+Shift+M)">⤢</button>
      <button class="icon-btn" data-act="close" title="Close (Ctrl+Shift+W)">✕</button>
    </div>
    <div class="webview-toolbar">
      <button class="icon-btn" data-act="back" title="Back">←</button>
      <button class="icon-btn" data-act="forward" title="Forward">→</button>
      <button class="icon-btn" data-act="reload" title="Reload">↻</button>
      <input class="webview-url" autocomplete="off" spellcheck="false" placeholder="http://localhost:5173">
      <button class="icon-btn" data-act="open" title="Open in the default browser">↗</button>
      <select class="webview-viewport" title="Viewport">
        <option value="desktop">Desktop</option>
        <option value="mobile">Mobile</option>
      </select>
    </div>
    <div class="webview-body">
      <div class="webview-stage">
        <iframe class="webview-frame" title="Docked preview" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals" referrerpolicy="no-referrer"></iframe>
      </div>
    </div>`;
  const q = (sel) => el.querySelector(sel);
  const frame = q('.webview-frame');
  const address = q('.webview-url');
  const viewportSelect = q('.webview-viewport');
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals');

  const pane = {
    id,
    project,
    kind: 'webview',
    title,
    url: start,
    viewport: 'desktop',
    history: [],
    index: -1,
    reloads: 0,
    snapshotPath: null,
    cwd: project?.path || '',
    el,
    frame,
    address,
  };
  el._t = pane;

  const notify = () => {
    paintTitle(pane);
    pane.onChange?.(pane);
  };

  const show = (next) => {
    pane.url = next;
    frame.src = next;
    address.value = next;
    notify();
  };

  function commit(input, { push = true } = {}) {
    const next = normalizePreviewUrl(input);
    if (!next) {
      toast('Enter an http:// or https:// address');
      address.value = pane.url || '';
      return null;
    }
    if (push) {
      pane.history = pane.history.slice(0, pane.index + 1);
      pane.history.push(next);
      pane.index = pane.history.length - 1;
    }
    show(next);
    return next;
  }

  function go(delta) {
    const next = pane.index + delta;
    if (next < 0 || next >= pane.history.length) return null;
    pane.index = next;
    show(pane.history[next]);
    return pane.history[next];
  }

  function reload() {
    if (!pane.url) return null;
    pane.reloads += 1;
    frame.src = pane.url;
    notify();
    return pane.url;
  }

  function setViewport(value) {
    pane.viewport = value === 'mobile' ? 'mobile' : 'desktop';
    el.classList.toggle('mobile', pane.viewport === 'mobile');
    viewportSelect.value = pane.viewport;
    return pane.viewport;
  }

  async function snapshot() {
    if (!pane.url) {
      toast('Open an address before taking a snapshot');
      return null;
    }
    if (!work?.webview?.capture) {
      toastError('Screenshots are available in the Work app');
      return null;
    }
    try {
      const path = await work.webview.capture(pane.url);
      pane.snapshotPath = path;
      toast(`Snapshot saved: ${path}`, {
        action: work.webview.reveal
          ? { label: 'Show', run: () => work.webview.reveal(path).catch(toastError) }
          : { label: 'Copy path', run: () => work.app.copy(path) },
      });
      pane.onSnapshot?.(path);
      return path;
    } catch (e) {
      toastError(e);
      return null;
    }
  }

  q('[data-act="back"]').onclick = () => go(-1);
  q('[data-act="forward"]').onclick = () => go(1);
  q('[data-act="reload"]').onclick = () => reload();
  q('[data-act="open"]').onclick = () => pane.url && work.app.openExternal(pane.url);
  q('[data-act="snapshot"]').onclick = () => snapshot();
  q('[data-act="viewport"]').onclick = () => setViewport(pane.viewport === 'mobile' ? 'desktop' : 'mobile');
  q('[data-act="close"]').onclick = () => pane.onClose?.();
  q('[data-act="max"]').onclick = () => pane.onMaximize?.();
  q('.pane-head').addEventListener('dblclick', (e) => {
    if (!e.target.closest('button')) pane.onMaximize?.();
  });
  address.onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    commit(address.value);
  };
  viewportSelect.onchange = (e) => setViewport(e?.target?.value ?? viewportSelect.value);

  if (start) commit(start);
  else {
    address.value = '';
    paintTitle(pane);
  }
  setViewport('desktop');

  Object.assign(pane, {
    goto: (input) => commit(input),
    back: () => go(-1),
    forward: () => go(1),
    reload,
    setViewport,
    snapshot,
    focus: () => address.focus(),
    dispose: () => {
      frame.src = 'about:blank';
    },
  });
  return pane;
}

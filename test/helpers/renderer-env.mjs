// Shared test environment for renderer modules that open terminals: xterm is
// replaced by a stub (via a module resolve hook), the DOM by a minimal fake,
// and window.work by a bridge the tests can drive (pty output and exits).
// Panes count as visible and animated, so a closing pane stays in the DOM
// until its exit animation ends, as in the app.
import { register } from 'node:module';

class ClassList {
  constructor() { this.set = new Set(); }
  add(...c) { c.forEach((x) => this.set.add(x)); }
  remove(...c) { c.forEach((x) => this.set.delete(x)); }
  toggle(c, on = !this.set.has(c)) { if (on) this.set.add(c); else this.set.delete(c); return on; }
  contains(c) { return this.set.has(c); }
}

export class El {
  constructor() {
    this.children = []; this.parent = null; this.classList = new ClassList(); this.dataset = {};
    this.style = { setProperty() {} }; this.listeners = {}; this.parts = new Map(); this.html = '';
    this.hidden = false; this.textContent = ''; this.disabled = false;
  }
  set innerHTML(v) { this.html = v; this.parts.clear(); this.first = null; }
  get firstChild() { return (this.first ??= new El()); }
  get innerHTML() { return this.html; }
  set className(v) { this.cls = v; this.classList = new ClassList(); v.split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c)); }
  get className() { return this.cls; }
  querySelector(s) { if (!this.parts.has(s)) this.parts.set(s, new El()); return this.parts.get(s); }
  querySelectorAll() { return []; }
  appendChild(c) { c.remove(); c.parent = this; this.children.push(c); return c; }
  insertBefore(c, ref) {
    if (!ref) return this.appendChild(c);
    c.remove();
    c.parent = this;
    this.children.splice(this.children.indexOf(ref), 0, c);
    return c;
  }
  get parentNode() { return this.parent; }
  get nextSibling() { return this.parent ? this.parent.children[this.parent.children.indexOf(this) + 1] || null : null; }
  setPointerCapture() {}
  animate() {}
  remove() { if (!this.parent) return; const a = this.parent.children; a.splice(a.indexOf(this), 1); this.parent = null; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener() {}
  get isConnected() { return !!this.parent; }
  get offsetParent() { return this.parent; }
  get offsetWidth() { return 100; }
  getClientRects() { return this.parent ? [{}] : []; }
  getBoundingClientRect() { return this.rect || { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }; }
  setAttribute() {}
  insertAdjacentHTML(_where, html) { const el = new El(); el.innerHTML = html; this.appendChild(el); }
  focus() {}
  setSelectionRange(a, b) { this.selection = [a, b]; }
  scrollIntoView() {}
  contains() { return false; }
}

const nodes = new Map();
globalThis.document = {
  createElement: () => new El(),
  querySelector: (s) => { if (!nodes.has(s)) nodes.set(s, new El()); return nodes.get(s); },
  querySelectorAll: () => [],
  documentElement: new El(),
  body: new El(),
};
globalThis.getComputedStyle = () => ({ animationName: 'pane-out', getPropertyValue: () => 'monospace' });
// Window listeners are kept so tests can press keys (env.key).
const winListeners = {};
globalThis.addEventListener = (type, fn) => { (winListeners[type] ??= []).push(fn); };
globalThis.removeEventListener = (type, fn) => {
  const list = winListeners[type] || [];
  if (list.includes(fn)) list.splice(list.indexOf(fn), 1);
};
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.ResizeObserver = class { observe() {} };
globalThis.innerWidth = 1200;
globalThis.innerHeight = 800;
globalThis.matchMedia = () => ({ matches: true }); // reduced motion: no FLIP animations to wait for

export class FakeTerminal {
  constructor(options) { this.options = options; this.cols = 80; this.rows = 24; this.textarea = new El(); this.written = ''; }
  loadAddon() {}
  open() {}
  onData() {}
  onResize() {}
  onTitleChange() {}
  write(d, cb) { this.written += d; cb?.(); }
  getSelection() { return this.selection || ''; }
  paste(text) { this.pasted = text; }
  clear() { this.written = ''; }
  focus() { FakeTerminal.focused = this; }
  dispose() { this.disposed = true; }
}
globalThis.__xterm = { Terminal: FakeTerminal, FitAddon: class { fit() {} }, WebLinksAddon: class {} };
const stub = (name) => `data:text/javascript,export const ${name} = globalThis.__xterm.${name};`;
register(`data:text/javascript,${encodeURIComponent(`
  const stubs = { 'xterm.mjs': ${JSON.stringify(stub('Terminal'))}, 'addon-fit.mjs': ${JSON.stringify(stub('FitAddon'))}, 'addon-web-links.mjs': ${JSON.stringify(stub('WebLinksAddon'))} };
  export async function resolve(spec, ctx, next) {
    const hit = Object.keys(stubs).find((k) => spec.endsWith('/' + k));
    return hit ? { url: stubs[hit], shortCircuit: true } : next(spec, ctx);
  }`)}`);

// What the tests observe and drive.
export const env = {
  created: [], // pty.create options, in order
  killed: [], // pty ids killed
  input: [], // [id, data] written to ptys
  opened: [], // URLs opened in the browser
  copied: [], // text put on the clipboard
  clipboard: '',
  cwds: new Map(), // pty id -> folder reported by pty.cwd
  agentsReply: Promise.resolve(['claude']),
  onData: null,
  onExit: null,
  output(id, data) { env.onData(id, data); },
  // Pointer events on the window (drag gestures listen there).
  pointer(type, x, y) {
    const e = { type, clientX: x, clientY: y, pointerId: 1, button: 0 };
    for (const fn of [...(winListeners[type] || [])]) fn(e);
  },
  key(key, mods = {}) {
    const e = { key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, target: document.body, ...mods, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} };
    for (const fn of winListeners.keydown || []) fn(e);
  },
  exit(id, code) { env.onExit(id, code); },
};
let nextId = 1;
globalThis.window = {
  work: {
    pty: {
      create: async (opts) => { env.created.push(opts); env.lastId = nextId++; return env.lastId; },
      write: (id, data) => env.input.push([id, data]),
      resize() {},
      cwd: async (id) => env.cwds.get(id) || null,
      ack() {},
      kill: (id) => env.killed.push(id),
      onData: (fn) => { env.onData = fn; },
      onExit: (fn) => { env.onExit = fn; },
    },
    app: {
      openExternal: (url) => env.opened.push(url),
      copy: (text) => env.copied.push(text),
      paste: async () => env.clipboard,
    },
    agents: { available: () => env.agentsReply },
    run: { detect: async () => env.detected || [] },
  },
};

export const $ = (s) => document.querySelector(s);
export const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

// The context menu currently open, as { label -> button }.
export function openMenuItems() {
  const menu = document.body.children.filter((c) => c.className === 'menu').at(-1);
  if (!menu) return null;
  return Object.fromEntries(menu.children.filter((c) => c.onclick).map((b) => [b.querySelector('span').textContent, b]));
}

// Answer the prompt modal like a person: type a value and press OK.
export async function answer(value) {
  await tick(0);
  $('#modal-input').value = value;
  $('#modal-form').onsubmit({ preventDefault() {} });
}

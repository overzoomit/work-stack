// Terminal panes with xterm replaced by a stub (via a module resolve hook)
// and a minimal fake DOM. Panes count as visible and animated, so a closing
// pane stays in the grid until its exit animation ends, as in the app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

class ClassList {
  constructor() { this.set = new Set(); }
  add(...c) { c.forEach((x) => this.set.add(x)); }
  remove(...c) { c.forEach((x) => this.set.delete(x)); }
  toggle(c, on = !this.set.has(c)) { if (on) this.set.add(c); else this.set.delete(c); return on; }
  contains(c) { return this.set.has(c); }
}
class El {
  constructor() {
    this.children = []; this.parent = null; this.classList = new ClassList(); this.dataset = {};
    this.style = { setProperty() {} }; this.listeners = {}; this.parts = new Map(); this.html = '';
    this.hidden = false; this.textContent = '';
  }
  set innerHTML(v) { this.html = v; this.parts.clear(); }
  get innerHTML() { return this.html; }
  set className(v) { this.classList = new ClassList(); v.split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c)); }
  querySelector(s) { if (!this.parts.has(s)) this.parts.set(s, new El()); return this.parts.get(s); }
  querySelectorAll() { return []; }
  appendChild(c) { c.remove(); c.parent = this; this.children.push(c); return c; }
  remove() { if (!this.parent) return; const a = this.parent.children; a.splice(a.indexOf(this), 1); this.parent = null; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener() {}
  get isConnected() { return !!this.parent; }
  get offsetParent() { return this.parent; }
  get offsetWidth() { return 100; }
  getClientRects() { return this.parent ? [{}] : []; }
}

const nodes = new Map();
globalThis.document = {
  createElement: () => new El(),
  querySelector: (s) => { if (!nodes.has(s)) nodes.set(s, new El()); return nodes.get(s); },
  querySelectorAll: () => [],
  documentElement: new El(),
};
globalThis.getComputedStyle = () => ({ animationName: 'pane-out', getPropertyValue: () => 'monospace' });
globalThis.addEventListener = () => {};
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.ResizeObserver = class { observe() {} };

class FakeTerminal {
  constructor(options) { this.options = options; this.cols = 80; this.rows = 24; this.textarea = new El(); }
  loadAddon() {}
  open() {}
  onData() {}
  onResize() {}
  onTitleChange() {}
  write(_d, cb) { cb?.(); }
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

let nextId = 1;
const killed = [];
globalThis.window = {
  work: {
    pty: {
      create: async () => nextId++, write() {}, resize() {}, ack() {}, kill: (id) => killed.push(id),
      onData() {}, onExit() {},
    },
    app: { openExternal() {} },
  },
};

const T = await import('../src/renderer/terminals.js');
T.initTerminals({ homeDir: '/home/u', changed() {} });

test('chiudendo il terminale con il focus, il focus passa a un altro terminale rimasto (regressione)', async () => {
  const p = { path: '/p', focusedId: null, maximizedId: null };
  T.showProject(p);
  const a = await T.openTerminal(p);
  const b = await T.openTerminal(p);
  assert.equal(p.focusedId, b.id, 'the newest pane takes the focus');

  T.closeTerminal(b.id);
  assert.deepEqual(killed, [b.id]);
  assert.equal(p.focusedId, a.id, 'focus moves to the pane that is still open');
  assert.equal(FakeTerminal.focused, a.term);
  assert.deepEqual(T.terminalsOf(p).map((t) => t.id), [a.id], 'a closing pane no longer counts as open');

  await new Promise((r) => setTimeout(r, 700)); // exit animation fallback
  assert.equal(b.term.disposed, true);
  T.closeTerminal(a.id);
  await new Promise((r) => setTimeout(r, 700));
});

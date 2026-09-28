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
  set className(v) { this.cls = v; this.classList = new ClassList(); v.split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c)); }
  get className() { return this.cls; }
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
  getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }; }
  setAttribute() {}
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
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
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
const created = [];
globalThis.window = {
  work: {
    pty: {
      create: async (opts) => { created.push(opts); return nextId++; }, write() {}, resize() {}, ack() {}, kill: (id) => killed.push(id),
      onData() {}, onExit() {},
    },
    app: { openExternal() {} },
    agents: { available: () => agentsReply },
  },
};
let agentsReply = Promise.resolve(['claude']);
globalThis.innerWidth = 1200;

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

test('spostando il terminale con il focus in un altro progetto, il focus resta visibile in entrambi (regressione)', async () => {
  const p = { path: '/p', focusedId: null, maximizedId: null };
  const q = { path: '/q', focusedId: null, maximizedId: null };
  T.showProject(p);
  const a = await T.openTerminal(p);
  const b = await T.openTerminal(p);
  assert.equal(p.focusedId, b.id);

  T.moveToProject(b, q);
  assert.equal(p.focusedId, a.id);
  assert.ok(a.el.classList.contains('focused'), 'the pane that takes the focus is highlighted');
  assert.equal(q.focusedId, b.id, 'an empty destination focuses the pane it receives');
  assert.deepEqual(T.terminalsOf(q).map((t) => t.id), [b.id]);
  assert.ok(b.el.classList.contains('off'), 'q is not the active project: its pane is hidden');

  T.closeTerminal(a.id);
  T.closeTerminal(b.id);
  await new Promise((r) => setTimeout(r, 700));
});

test('"cerca di nuovo gli agenti" non riapre il menu se nel frattempo è stato chiuso (regressione)', async () => {
  const L = await import('../src/renderer/launcher.js');
  const p = { path: '/p', name: 'p', focusedId: null, maximizedId: null };
  L.initLauncher({ activeProject: () => p });
  const button = document.querySelector('#new-agent');
  const press = () => button.onpointerdown({ button: 0, stopPropagation() {} });
  press(); // open
  await new Promise((r) => setTimeout(r, 10));
  const pops = () => document.body.children.filter((c) => c.className === 'agent-pop' && !c.classList.contains('closing'));
  assert.equal(pops().length, 1);

  let finish;
  agentsReply = new Promise((r) => { finish = r; });
  const rescan = { closest: (sel) => (sel === '.ap-rescan' ? {} : null) };
  pops()[0].listeners.click[0]({ target: rescan });
  press(); // closed by hand while the search runs
  finish(['claude']);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(pops().length, 0, 'the menu stays closed');
});

test('Claude Code parte sempre in bypass permessi: dal menu, con Continua e con Riprendi', async () => {
  const L = await import('../src/renderer/launcher.js');
  const p = { path: '/p', name: 'p', focusedId: null, maximizedId: null };
  T.showProject(p);
  L.initLauncher({ activeProject: () => p });
  const press = () => document.querySelector('#new-agent').onpointerdown({ button: 0, stopPropagation() {} });
  const menu = () => document.body.children.filter((c) => c.className === 'agent-pop' && !c.classList.contains('closing')).at(-1);
  const clickRow = async (id, extra = null) => {
    agentsReply = Promise.resolve(['claude', 'codex']);
    press();
    await new Promise((r) => setTimeout(r, 10));
    const row = { dataset: { id }, classList: { contains: () => false } };
    menu().listeners.click[0]({ target: { closest: (sel) => (sel === '.ap-row' ? row : sel === extra ? {} : null) } });
    await new Promise((r) => setTimeout(r, 10));
    return created.at(-1);
  };

  const claude = await clickRow('claude');
  assert.equal(claude.command, 'claude --dangerously-skip-permissions');
  assert.equal((await clickRow('claude', '[data-continue]')).command, 'claude --continue --dangerously-skip-permissions');
  assert.equal((await clickRow('codex')).command, 'codex', 'other agents start as they are');

  const uuid = '12345678-1234-1234-1234-123456789abc';
  const t = await L.resumeClaude(p, '/p', uuid, 'sessione');
  assert.equal(created.at(-1).command, `claude --resume ${uuid} --dangerously-skip-permissions`);
  assert.match(t.el.innerHTML, /bypass permessi/, 'the pane shows the bypass badge');
  assert.throws(() => L.resumeClaude(p, '/p', 'x; rm -rf ~', 't'), /ID di sessione non valido/);
  await new Promise((r) => setTimeout(r, 700));
});

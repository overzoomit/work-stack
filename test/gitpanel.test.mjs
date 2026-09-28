// Git panel wiring, with a minimal fake DOM and a fake `window.work` bridge.
import { test } from 'node:test';
import assert from 'node:assert/strict';

function el() {
  return {
    value: '', innerHTML: '', textContent: '', hidden: false, checked: false, dataset: {},
    style: {}, firstChild: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; }, removeEventListener() {}, appendChild() {}, remove() {},
    querySelector: () => null, querySelectorAll: () => [], getAnimations: () => [],
  };
}
const byId = new Map();
globalThis.document = {
  querySelector: (s) => {
    if (!byId.has(s)) byId.set(s, el());
    return byId.get(s);
  },
  querySelectorAll: () => [],
  createElement: el,
};
globalThis.addEventListener = () => {};

const calls = [];
const statusCalls = [];
let logCalls = 0;
let statusGate = null;
let statusReply = { branch: { name: 'main', ahead: 0, behind: 0 }, staged: [], unstaged: [], ignored: [] };
let failCheckout = false;
globalThis.window = {
  work: {
    git: {
      action: async (repo, name, params) => {
        calls.push([name, params]);
        if (name === 'checkout' && failCheckout) throw new Error('local changes would be overwritten');
      },
      status: async (repo, opts) => {
        statusCalls.push(opts);
        await statusGate;
        return structuredClone(statusReply);
      },
      branches: async () => [{ name: 'main', current: true, remote: false }, { name: 'dev', current: false, remote: false }],
      log: async () => {
        logCalls++;
        return [{ hash: 'c1', parents: [], refs: ['HEAD -> refs/heads/main'], author: 'Anna Rossi', time: Date.now(), subject: 'primo <commit>' }];
      },
      root: async (p) => p,
      watch() {},
    },
  },
};

const { initGit, showGit, refreshGit, setGraphVisible } = await import('../src/renderer/gitpanel.js');
const $ = (sel) => document.querySelector(sel);

test('se il checkout dal selettore fallisce, il selettore torna al ramo corrente (regressione)', async () => {
  initGit({ statusChanged() {} });
  const project = { path: '/r', root: '/r' };
  await showGit(project);
  const sel = document.querySelector('#branch-select');

  failCheckout = true;
  sel.value = 'dev';
  await sel.onchange({ target: sel });
  assert.deepEqual(calls.at(-1), ['checkout', { branch: 'dev' }]);
  assert.equal(sel.value, 'main', 'the selector must not claim a branch that was not checked out');

  failCheckout = false;
  sel.value = 'dev';
  await sel.onchange({ target: sel });
  assert.equal(sel.value, 'dev', 'a successful checkout keeps the choice');
});

test('la lista delle modifiche mostra conteggi, cartella e nome, con i caratteri HTML escapati', async () => {
  statusReply = {
    branch: { name: 'main', ahead: 2, behind: 1 },
    staged: [{ file: 'src/<a>.js', code: 'M' }],
    unstaged: [{ file: 'README.md', code: 'M' }, { file: 'nuovo.txt', code: 'U' }],
    ignored: [],
  };
  const project = { path: '/r', root: '/r' };
  await showGit(project);
  assert.equal($('#ahead').textContent, 2);
  assert.equal($('#behind').textContent, 1);
  assert.equal($('#staged-count').textContent, 1);
  assert.equal($('#unstaged-count').textContent, 2);
  assert.equal($('#changes-count').textContent, 3);
  assert.match($('#staged').innerHTML, /<bdi>src\/<b>&lt;a&gt;\.js<\/b><\/bdi>/);
  assert.match($('#staged').innerHTML, /data-act="unstage"/);
  assert.match($('#unstaged').innerHTML, /data-code="U"[\s\S]*data-act="discard"[\s\S]*data-act="stage"/);
});

test('refresh contemporanei si accorpano in uno solo di seguito, completo se uno lo chiedeva', async () => {
  const project = { path: '/r', root: '/r' };
  await showGit(project);
  statusCalls.length = 0;
  let open;
  statusGate = new Promise((r) => { open = r; });
  const first = refreshGit(project);
  refreshGit(project);
  refreshGit(project, true);
  refreshGit(project);
  open();
  statusGate = null;
  await first;
  assert.equal(statusCalls.length, 2, 'one running refresh plus one follow-up, not four');
  assert.deepEqual(statusCalls.map((o) => o.ignored), [false, true], 'the follow-up is full: it scans ignored files');
});

test('il graph si costruisce solo quando il suo tab è visibile', async () => {
  const project = { path: '/r', root: '/r' };
  setGraphVisible(false);
  logCalls = 0;
  await refreshGit(project, true);
  await showGit(project);
  assert.equal(logCalls, 0, 'hidden graph: no git log');
  setGraphVisible(true);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(logCalls, 1);
  assert.match($('#graph').innerHTML, /<svg[\s\S]*primo &lt;commit&gt;[\s\S]*Anna ·/);
  setGraphVisible(false);
});

test('scartare un file non tracciato non chiama git e rimanda al tab Project', async () => {
  const project = { path: '/r', root: '/r' };
  await showGit(project);
  const before = calls.length;
  const li = { dataset: { file: 'nuovo.txt', staged: '', code: 'U' } };
  const target = { closest: (sel) => (sel === 'li[data-file]' ? li : sel === '[data-act]' ? { dataset: { act: 'discard' } } : null) };
  const onClick = $('#unstaged').listeners?.click;
  assert.ok(onClick, 'the list handles clicks');
  await onClick({ target });
  assert.equal(calls.length, before);
});

// Git panel wiring, with a minimal fake DOM and a fake `window.work` bridge.
import { test } from 'node:test';
import assert from 'node:assert/strict';

function el() {
  return {
    value: '', innerHTML: '', textContent: '', hidden: false, checked: false, dataset: {},
    style: {}, firstChild: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, remove() {},
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
let failCheckout = false;
globalThis.window = {
  work: {
    git: {
      action: async (repo, name, params) => {
        calls.push([name, params]);
        if (name === 'checkout' && failCheckout) throw new Error('local changes would be overwritten');
      },
      status: async () => ({ branch: { name: 'main', ahead: 0, behind: 0 }, staged: [], unstaged: [], ignored: [] }),
      branches: async () => [{ name: 'main', current: true, remote: false }, { name: 'dev', current: false, remote: false }],
      log: async () => [],
      root: async (p) => p,
      watch() {},
    },
  },
};

const { initGit, showGit } = await import('../src/renderer/gitpanel.js');

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

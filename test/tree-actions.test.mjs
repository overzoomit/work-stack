// Project tree actions (new, rename, move with undo, trash) through the real
// prompt modal and toasts, on a minimal fake DOM and a stubbed file system.
import { test } from 'node:test';
import assert from 'node:assert/strict';

class El {
  constructor() {
    this.children = []; this.hidden = true; this.value = ''; this.textContent = ''; this.innerHTML = '';
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
    this.firstChild = { textContent: '' }; this.style = {};
  }
  appendChild(c) { this.children.push(c); c.parent = this; }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); }
  addEventListener() {}
  focus() {}
  setSelectionRange(a, b) { this.selection = [a, b]; }
  get isConnected() { return false; } // no exit animation to wait for
}
const nodes = new Map();
const $ = (s) => { if (!nodes.has(s)) nodes.set(s, new El()); return nodes.get(s); };
globalThis.document = { querySelector: $, querySelectorAll: () => [], createElement: () => new El() };
globalThis.addEventListener = () => {};

const calls = [];
const disk = new Map();
let failNext = null;
const op = (name, result) => async (...args) => {
  calls.push([name, ...args]);
  if (failNext) { const e = failNext; failNext = null; throw e; }
  return result(...args);
};
globalThis.window = {
  work: {
    fs: {
      list: async (dir) => disk.get(dir) || [],
      create: op('create', (parent, name) => `${parent}/${name}`),
      rename: op('rename', (p, name) => `${p.slice(0, p.lastIndexOf('/'))}/${name}`),
      move: op('move', (p, toDir) => `${toDir}/${p.split('/').pop()}`),
      trash: op('trash', () => undefined),
    },
  },
};
const { ProjectTree } = await import('../src/renderer/tree.js');

// Answer the modal the way a person would: type (or keep) a value and press OK.
async function answer(value) {
  await new Promise((r) => setTimeout(r));
  const prompt = { text: $('#modal-text').textContent, value: $('#modal-input').value, selection: $('#modal-input').selection };
  if (value === null) $('#modal-cancel').onclick();
  else {
    $('#modal-input').value = value;
    $('#modal-form').onsubmit({ preventDefault() {} });
  }
  return prompt;
}
const lastToast = () => $('#toasts').children.at(-1);
const file = (path) => ({ name: path.split('/').pop(), path, dir: false });
const dir = (path) => ({ name: path.split('/').pop(), path, dir: true });

function makeTree() {
  disk.set('/p', [dir('/p/src'), file('/p/readme.md')]);
  disk.set('/p/src', [file('/p/src/app.test.js')]);
  const refreshed = [];
  const tree = new ProjectTree({ path: '/p', name: 'p' }, { refreshGit: () => refreshed.push(1) });
  return { tree, refreshed };
}

test('rinomina: propone il nome con l\'estensione esclusa dalla selezione e seleziona il file rinominato', async () => {
  const { tree, refreshed } = makeTree();
  calls.length = 0;
  const done = tree.rename('/p/src/app.test.js');
  const prompt = await answer('main.test.js');
  await done;
  assert.equal(prompt.value, 'app.test.js');
  assert.deepEqual(prompt.selection, [0, 'app.test'.length], 'only the name before the last dot is selected');
  assert.deepEqual(calls, [['rename', '/p/src/app.test.js', 'main.test.js']]);
  assert.equal(tree.selected, '/p/src/main.test.js');
  assert.equal(refreshed.length, 1, 'git status refreshed after the change');
});

test('rinomina: lo stesso nome o Annulla non toccano il disco; la cartella del progetto non si rinomina', async () => {
  const { tree } = makeTree();
  calls.length = 0;
  let done = tree.rename('/p/readme.md');
  await answer('readme.md');
  await done;
  done = tree.rename('/p/readme.md');
  await answer(null);
  await done;
  await tree.rename('/p');
  assert.deepEqual(calls, []);
});

test('nuovo file: su un file viene creato nella sua cartella, che si apre, e il nuovo file è selezionato', async () => {
  const { tree } = makeTree();
  calls.length = 0;
  const done = tree.create('/p/src/app.test.js', false);
  const prompt = await answer('util.js');
  await done;
  assert.equal(prompt.text, 'Nome del nuovo file');
  assert.deepEqual(calls, [['create', '/p/src', 'util.js', false]]);
  assert.ok(tree.expanded.has('/p/src'));
  assert.equal(tree.selected, '/p/src/util.js');
});

test('spostamento: il toast offre Annulla, che riporta il file dov\'era', async () => {
  const { tree } = makeTree();
  calls.length = 0;
  await tree.move('/p/readme.md', '/p/src');
  assert.equal(tree.selected, '/p/src/readme.md');
  const t = lastToast();
  assert.equal(t.firstChild.textContent, 'readme.md spostato in src');
  const undo = t.children.find((c) => c.className === 'toast-action');
  assert.equal(undo.textContent, 'Annulla');
  undo.onclick();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(calls, [['move', '/p/readme.md', '/p/src'], ['move', '/p/src/readme.md', '/p']]);
  assert.equal(tree.selected, '/p/readme.md');
  await tree.move('/p/readme.md', '/p');
  assert.equal(calls.length, 2, 'moving into the same folder does nothing');
});

test('cestino: il file selezionato non resta selezionato e un errore del disco diventa un avviso', async () => {
  const { tree } = makeTree();
  calls.length = 0;
  tree.selected = '/p/readme.md';
  await tree.trash('/p/readme.md');
  assert.equal(tree.selected, null);
  assert.equal(lastToast().firstChild.textContent, 'readme.md spostato nel cestino');

  failNext = new Error('Permesso negato');
  await tree.trash('/p/src');
  assert.equal(lastToast().firstChild.textContent, 'Permesso negato');
  assert.match(lastToast().className, /error/);
  await tree.trash('/p');
  assert.equal(calls.filter((c) => c[1] === '/p').length, 0, 'the project folder is never trashed');
});

test('cestinando una cartella aperta si dimenticano anche le sottocartelle e il loro contenuto (regressione)', async () => {
  disk.set('/q', [dir('/q/build')]);
  disk.set('/q/build', [dir('/q/build/assets')]);
  disk.set('/q/build/assets', [file('/q/build/assets/old.js')]);
  const tree = new ProjectTree({ path: '/q', name: 'q' }, { refreshGit() {} });
  await tree.load('/q');
  for (const d of ['/q/build', '/q/build/assets']) {
    tree.expanded.add(d);
    await tree.load(d);
  }
  tree.selected = '/q/build/assets/old.js';
  disk.set('/q', []);
  await tree.trash('/q/build');
  assert.deepEqual([...tree.expanded].filter((d) => d.startsWith('/q/build')), [], 'no folder of the trashed tree stays open');
  assert.ok(!tree.children.has('/q/build/assets'), 'its old content is not kept');
  assert.equal(tree.selected, null, 'a selection inside the trashed folder is cleared');
});

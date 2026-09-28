// Project tree keyboard navigation and context menu, on the shared fake
// renderer environment. The tree's rows are read back from its HTML.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { El, openMenuItems, tick } from './helpers/renderer-env.mjs';

globalThis.CSS = { escape: (s) => s };
const disk = new Map([
  ['/p', [{ name: 'src', path: '/p/src', dir: true }, { name: 'readme.md', path: '/p/readme.md', dir: false }]],
  ['/p/src', [{ name: 'a.js', path: '/p/src/a.js', dir: false }]],
]);
const calls = [];
Object.assign(globalThis.window.work, {
  fs: {
    list: async (dir) => disk.get(dir) || [],
    trash: async (p) => calls.push(['trash', p]),
    rename: async (p, name) => { calls.push(['rename', p, name]); return p; },
    openPath: (p) => calls.push(['openPath', p]),
    reveal: (p) => calls.push(['reveal', p]),
  },
});
const { ProjectTree } = await import('../src/renderer/tree.js');

// A tree box whose rows come from the markup the tree renders.
class TreeBox extends El {
  rows() {
    return [...this.innerHTML.matchAll(/<div class="([^"]*)" draggable="true" data-path="([^"]*)"/g)].map(([, cls, path]) => {
      const row = new El();
      row.className = cls;
      row.dataset.path = path;
      return row;
    });
  }
  querySelectorAll(sel) { return sel === '.tn[data-path]' ? this.rows() : []; }
  querySelector(sel) {
    const m = sel.match(/data-path="([^"]*)"/);
    return m ? this.rows().find((r) => r.dataset.path === m[1]) || null : null;
  }
}

async function mounted() {
  const previews = [];
  const tree = new ProjectTree({ path: '/p', name: 'p' }, { preview: (p) => previews.push(p), refreshGit() {}, openTerminal() {}, showDiff() {} });
  const box = new TreeBox();
  document.body.appendChild(box);
  tree.mount(box);
  await tick();
  return { tree, box, previews };
}
const press = (tree, key) => tree.onKey({ key, preventDefault() {} });

test('tastiera: frecce per muoversi e aprire/chiudere cartelle, Invio per l\'anteprima', async () => {
  const { tree, previews } = await mounted();
  tree.select('/p');
  press(tree, 'ArrowDown');
  assert.equal(tree.selected, '/p/src');
  press(tree, 'ArrowRight'); // open src
  await tick();
  assert.ok(tree.expanded.has('/p/src'));
  press(tree, 'ArrowDown');
  assert.equal(tree.selected, '/p/src/a.js', 'into the folder just opened');
  press(tree, 'Enter');
  assert.deepEqual(previews, ['/p/src/a.js']);
  press(tree, 'ArrowLeft');
  assert.equal(tree.selected, '/p/src', 'from a file, left goes to its folder');
  press(tree, 'ArrowLeft');
  await tick();
  assert.ok(!tree.expanded.has('/p/src'), 'and from an open folder, left closes it');
  press(tree, 'ArrowUp');
  press(tree, 'ArrowUp');
  assert.equal(tree.selected, '/p', 'the first row stays the first row');
});

test('tastiera: F2 e Canc non agiscono sulla cartella del progetto; Canc cestina il file', async () => {
  const { tree } = await mounted();
  calls.length = 0;
  tree.select('/p');
  press(tree, 'Delete');
  press(tree, 'F2');
  await tick();
  assert.deepEqual(calls, []);
  tree.select('/p/readme.md');
  press(tree, 'Delete');
  await tick();
  assert.deepEqual(calls, [['trash', '/p/readme.md']]);
});

test('tasto destro: azioni del file o della cartella, rinomina e cestino disattivati sulla radice', async () => {
  const { tree } = await mounted();
  const menuOn = (path) => {
    tree.onContextMenu({ preventDefault() {}, clientX: 1, clientY: 1, target: { closest: () => (path ? { dataset: { path } } : null) } });
    return openMenuItems();
  };
  let items = menuOn('/p/readme.md');
  assert.ok(items.Anteprima && items['Apri con app di sistema'] && items['Copia percorso relativo']);
  assert.equal(items['Rinomina…'].disabled, false);
  items['Mostra nel file manager'].onclick();
  assert.deepEqual(calls.at(-1), ['reveal', '/p/readme.md']);

  items = menuOn('/p/src');
  assert.ok(!items.Anteprima, 'folders have no preview');
  assert.ok(items['Nuovo file…'] && items['Apri terminale qui']);

  items = menuOn(null); // empty area: the project folder itself
  assert.equal(items['Rinomina…'].disabled, true);
  assert.equal(items['Sposta nel cestino'].disabled, true);
});

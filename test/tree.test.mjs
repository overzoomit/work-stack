// ProjectTree's bookkeeping, with the file-system API stubbed and no DOM
// (render() is a no-op while the tree isn't mounted).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const disk = new Map(); // dir -> entries
const work = {
  fs: {
    list: async (dir) => disk.get(dir) || [],
    move: async (p, toDir) => `${toDir}/${p.split('/').pop()}`,
  },
};
globalThis.window = { work };
globalThis.addEventListener = () => {};
const { ProjectTree } = await import('../src/renderer/tree.js');

const dir = (path) => ({ name: path.split('/').pop(), path, dir: true });

test('spostando una cartella aperta, i suoi contenuti si caricano nella nuova posizione (regressione)', async () => {
  disk.set('/p', [dir('/p/src'), dir('/p/lib')]);
  disk.set('/p/src', [dir('/p/src/ui')]);
  disk.set('/p/lib', []);
  const tree = new ProjectTree({ path: '/p', name: 'p' }, { refreshGit() {} });
  await tree.load('/p');
  tree.expanded.add('/p/src');
  await tree.load('/p/src');
  // After the move the folder lives in /p/lib/src, still open.
  disk.set('/p', [dir('/p/lib')]);
  disk.set('/p/lib', [dir('/p/lib/src')]);
  disk.set('/p/lib/src', [dir('/p/lib/src/ui')]);
  await tree.move('/p/src', '/p/lib', { undo: false });
  assert.ok(tree.expanded.has('/p/lib/src'), 'still open at the new place');
  assert.deepEqual(tree.children.get('/p/lib/src')?.map((e) => e.name), ['ui'], 'its content is loaded, not "…"');
});

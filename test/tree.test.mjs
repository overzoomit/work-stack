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

const file = (path) => ({ name: path.split('/').pop(), path, dir: false });

test('i colori git marcano i file per tipo di modifica e le cartelle che li contengono', () => {
  const tree = new ProjectTree({ path: '/p', name: 'p' }, {});
  tree.setGitStatus({
    staged: [{ file: 'src/new.js', code: 'A' }, { file: 'old.js', code: 'D' }],
    unstaged: [{ file: 'src/ui/a.js', code: 'M' }, { file: 'notes.txt', code: 'U' }, { file: 'src/conflict.js', code: 'X' }],
    ignored: ['node_modules', 'dist'],
  }, '/p');
  assert.equal(tree.vcs.get('/p/src/new.js'), 'add');
  assert.equal(tree.vcs.get('/p/old.js'), 'del');
  assert.equal(tree.vcs.get('/p/src/ui/a.js'), 'mod');
  assert.equal(tree.vcs.get('/p/notes.txt'), 'new');
  assert.equal(tree.vcs.get('/p/src/conflict.js'), 'conflict');
  assert.equal(tree.vcs.get('/p/src/ui'), 'mod', 'folders take the colour of changes inside');
  assert.equal(tree.vcs.get('/p/src'), 'mod');
  assert.ok(tree.isIgnored('/p/node_modules/x/y.js'));
  assert.ok(tree.isIgnored('/p/dist'));
  assert.ok(!tree.isIgnored('/p/distro'), 'not a prefix match');
  tree.setGitStatus(null, null);
  assert.equal(tree.vcs.size, 0, 'no repository: no colours');
});

test('reveal apre e carica le cartelle fino al file e lo seleziona', async () => {
  disk.set('/r', [dir('/r/a')]);
  disk.set('/r/a', [dir('/r/a/b')]);
  disk.set('/r/a/b', [file('/r/a/b/x.txt')]);
  const tree = new ProjectTree({ path: '/r', name: 'r' }, {});
  await tree.reveal('/r/a/b/x.txt');
  assert.ok(tree.expanded.has('/r/a') && tree.expanded.has('/r/a/b'));
  assert.deepEqual(tree.children.get('/r/a/b').map((e) => e.name), ['x.txt']);
  assert.equal(tree.selected, '/r/a/b/x.txt');
  await tree.reveal('/altrove/y.txt');
  assert.equal(tree.selected, '/r/a/b/x.txt', 'paths outside the project are ignored');
});

test('targetDir: una cartella è sé stessa, un file la sua cartella', async () => {
  disk.set('/t', [dir('/t/src'), file('/t/README.md')]);
  const tree = new ProjectTree({ path: '/t', name: 't' }, {});
  await tree.load('/t');
  assert.equal(tree.targetDir('/t/src'), '/t/src');
  assert.equal(tree.targetDir('/t/README.md'), '/t');
  assert.equal(tree.targetDir('/t'), '/t');
});

test('reload dimentica le cartelle aperte che non esistono più', async () => {
  disk.set('/q', [dir('/q/a'), dir('/q/b')]);
  disk.set('/q/a', []);
  disk.set('/q/b', []);
  const tree = new ProjectTree({ path: '/q', name: 'q' }, {});
  await tree.load('/q');
  for (const d of ['/q/a', '/q/b']) { tree.expanded.add(d); await tree.load(d); }
  disk.set('/q', [dir('/q/a')]); // b deleted outside Work
  await tree.reload();
  assert.ok(tree.expanded.has('/q/a'));
  assert.ok(!tree.expanded.has('/q/b'));
});

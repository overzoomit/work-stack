// Integration: the Project tree's file operations on a real temp folder.
// Only Electron's `shell` is replaced (trash/open/reveal have OS side effects).
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const shellCalls = [];
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') {
    return {
      shell: {
        openPath: async (p) => { shellCalls.push(['open', p]); return ''; },
        showItemInFolder: (p) => shellCalls.push(['reveal', p]),
        trashItem: async (p) => { shellCalls.push(['trash', p]); fs.rmSync(p, { recursive: true }); },
      },
    };
  }
  return load.call(this, request, ...rest);
};
const fsops = require('../src/main/fsops');

let project;
let outside;

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'work-fs-'));
  project = path.join(base, 'project');
  outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(project, 'src', 'a.txt'), 'dentro\n');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'segreto\n');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(project, 'link-file'));
  fs.symlinkSync(outside, path.join(project, 'link-dir'));
  shellCalls.length = 0;
  fsops.setRoots([project]);
});

test('elenca le cartelle prima dei file, in ordine naturale, senza .git', async () => {
  fs.mkdirSync(path.join(project, '.git'));
  fs.writeFileSync(path.join(project, 'file10.txt'), '');
  fs.writeFileSync(path.join(project, 'file2.txt'), '');
  const names = (await fsops.list(project)).map((e) => e.name);
  assert.deepEqual(names, ['link-dir', 'src', 'file2.txt', 'file10.txt', 'link-file']);
});

test('legge un file del progetto', async () => {
  assert.equal((await fsops.read(path.join(project, 'src', 'a.txt'))).text, 'dentro\n');
});

test('non legge un file fuori dal progetto', async () => {
  await assert.rejects(fsops.read(path.join(outside, 'secret.txt')), /fuori dai progetti/);
});

test('non legge un file esterno tramite un symlink nel progetto (regressione)', async () => {
  await assert.rejects(fsops.read(path.join(project, 'link-file')), /fuori dai progetti/);
});

test('non elenca una cartella esterna tramite un symlink (regressione)', async () => {
  await assert.rejects(fsops.list(path.join(project, 'link-dir')), /fuori dai progetti/);
});

test('non crea file dentro una cartella esterna raggiunta da un symlink (regressione)', async () => {
  await assert.rejects(fsops.create(path.join(project, 'link-dir'), 'x.txt', false), /fuori dai progetti/);
  assert.equal(fs.existsSync(path.join(outside, 'x.txt')), false);
});

test('non sposta file in una cartella esterna raggiunta da un symlink (regressione)', async () => {
  await assert.rejects(fsops.move(path.join(project, 'src', 'a.txt'), path.join(project, 'link-dir')), /fuori dai progetti/);
  assert.ok(fs.existsSync(path.join(project, 'src', 'a.txt')));
});

test('non apre file fuori dal progetto (regressione)', async () => {
  await assert.rejects(fsops.openPath('/etc/passwd'), /fuori dai progetti/);
  await assert.rejects(fsops.openPath(path.join(project, 'link-file')), /fuori dai progetti/);
  assert.deepEqual(shellCalls, []);
});

test('un symlink si può rinominare e cestinare (agisce sul link, non sul bersaglio)', async () => {
  const renamed = await fsops.rename(path.join(project, 'link-file'), 'link-renamed');
  assert.equal(path.basename(renamed), 'link-renamed');
  await fsops.trash(path.join(project, 'link-dir'));
  assert.ok(fs.existsSync(path.join(outside, 'secret.txt')), 'the outside target is untouched');
});

test('rifiuta nomi con separatori o ".."', async () => {
  await assert.rejects(fsops.create(project, '../evil', false), /Nome non valido/);
  await assert.rejects(fsops.rename(path.join(project, 'src', 'a.txt'), 'x/y'), /Nome non valido/);
});

test('non crea un file che esiste già', async () => {
  await assert.rejects(fsops.create(path.join(project, 'src'), 'a.txt', false), /Esiste già/);
});

test('non sposta una cartella dentro sé stessa', async () => {
  fs.mkdirSync(path.join(project, 'src', 'sub'));
  await assert.rejects(fsops.move(path.join(project, 'src'), path.join(project, 'src', 'sub')), /dentro sé stessa/);
});

test('non cestina la cartella del progetto', async () => {
  await assert.rejects(fsops.trash(project), /cartella del progetto/);
});

test('riconosce file binari e file troppo grandi per l\'anteprima', async () => {
  fs.writeFileSync(path.join(project, 'img.bin'), Buffer.from([0x89, 0x50, 0, 0x47]));
  fs.writeFileSync(path.join(project, 'big.txt'), Buffer.alloc(1024 * 1024 + 1, 'a'));
  assert.equal((await fsops.read(path.join(project, 'img.bin'))).binary, true);
  assert.equal((await fsops.read(path.join(project, 'big.txt'))).tooBig, true);
});

test('un symlink rotto compare come file e non blocca l\'elenco', async () => {
  fs.symlinkSync(path.join(project, 'non-esiste'), path.join(project, 'rotto'));
  const entry = (await fsops.list(project)).find((e) => e.name === 'rotto');
  assert.deepEqual(entry, { name: 'rotto', path: path.join(project, 'rotto'), dir: false });
});

test('crea una cartella che poi compare come cartella', async () => {
  const created = await fsops.create(path.join(project, 'src'), 'nuova', true);
  assert.equal(created, path.join(project, 'src', 'nuova'));
  assert.equal((await fsops.list(path.join(project, 'src'))).find((e) => e.name === 'nuova').dir, true);
});

test('non sposta un file dove esiste già un file con lo stesso nome, e lascia intatto l\'originale', async () => {
  fs.mkdirSync(path.join(project, 'dest'));
  fs.writeFileSync(path.join(project, 'dest', 'a.txt'), 'altro\n');
  await assert.rejects(fsops.move(path.join(project, 'src', 'a.txt'), path.join(project, 'dest')), /esiste già/);
  assert.equal(fs.readFileSync(path.join(project, 'src', 'a.txt'), 'utf8'), 'dentro\n');
  assert.equal(fs.readFileSync(path.join(project, 'dest', 'a.txt'), 'utf8'), 'altro\n');
});

test('rinominare con lo stesso nome non cambia nulla', async () => {
  const p = path.join(project, 'src', 'a.txt');
  assert.equal(await fsops.rename(p, 'a.txt'), p);
  assert.ok(fs.existsSync(p));
});

test('mostra nel file manager solo elementi del progetto', async () => {
  await fsops.reveal(path.join(project, 'src', 'a.txt'));
  assert.deepEqual(shellCalls, [['reveal', path.join(project, 'src', 'a.txt')]]);
  await assert.rejects(fsops.reveal(path.join(outside, 'secret.txt')), /fuori dai progetti/);
  assert.equal(shellCalls.length, 1);
});

test('la cartella del progetto non si può rinominare né spostare, da nessuna via (regressione)', async () => {
  await assert.rejects(fsops.rename(project, 'altro-nome'), /cartella del progetto/);
  fs.mkdirSync(path.join(project, 'dentro'));
  await assert.rejects(fsops.move(project, path.join(project, 'dentro')), /cartella del progetto|dentro sé stessa/);
  assert.ok(fs.existsSync(path.join(project, 'src', 'a.txt')), 'the project is where it was');
});

// Integration: real git repositories in a temp folder.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const git = require('../src/main/git');

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-git-'));
  const run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString();
  run('init', '-q');
  run('symbolic-ref', 'HEAD', 'refs/heads/main');
  run('config', 'user.email', 't@example.com');
  run('config', 'user.name', 'Test');
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  const commit = (msg) => {
    run('add', '-A');
    run('commit', '-qm', msg);
    return run('rev-parse', 'HEAD').trim();
  };
  return { dir, run, write, commit };
}

test('status separa file in stage, modificati e non tracciati', async () => {
  const r = repo();
  r.write('a.txt', '1\n');
  r.commit('init');
  r.write('a.txt', '2\n');
  r.write('new.txt', 'x\n');
  r.write('staged.txt', 's\n');
  r.run('add', 'staged.txt');
  const st = await git.status(r.dir);
  assert.deepEqual(st.staged, [{ file: 'staged.txt', code: 'A' }]);
  assert.deepEqual(st.unstaged.sort((a, b) => a.file.localeCompare(b.file)), [
    { file: 'a.txt', code: 'M' },
    { file: 'new.txt', code: 'U' },
  ]);
});

test('status riporta le cartelle ignorate come una sola voce', async () => {
  const r = repo();
  r.write('.gitignore', 'node_modules/\n');
  r.write('node_modules/x/a.js', '');
  r.commit('init');
  assert.deepEqual((await git.status(r.dir)).ignored, ['node_modules']);
});

test('status senza scansione degli ignorati restituisce ignored null', async () => {
  const r = repo();
  r.write('.gitignore', 'dist/\n');
  r.write('dist/out.js', 'x');
  r.write('a.txt', '1\n');
  const st = await git.status(r.dir, { ignored: false });
  assert.equal(st.ignored, null);
  assert.ok(st.unstaged.some((f) => f.file === 'a.txt'));
});

test('status legge un ramo con punti nel nome da un repository reale', async () => {
  const r = repo();
  r.write('a.txt', '1\n');
  r.commit('init');
  r.run('checkout', '-q', '-b', 'release/1.2');
  assert.equal((await git.status(r.dir)).branch.name, 'release/1.2');
});

test('i file di un commit riportano stato, rinomine e righe aggiunte/tolte', async () => {
  const r = repo();
  r.write('a.txt', 'uno\ndue\n');
  r.write('b.txt', 'b\n');
  r.commit('init');
  r.write('a.txt', 'uno\nDUE\ntre\n');
  r.run('mv', 'b.txt', 'c.txt');
  const hash = r.commit('change');
  const c = await git.commit(r.dir, hash);
  const byFile = Object.fromEntries(c.files.map((f) => [f.file, f]));
  assert.equal(c.message, 'change');
  assert.deepEqual([byFile['a.txt'].code, byFile['a.txt'].add, byFile['a.txt'].del], ['M', 2, 1]);
  assert.deepEqual([byFile['c.txt'].code, byFile['c.txt'].oldFile], ['R', 'b.txt']);
});

test('il primo commit viene confrontato con un albero vuoto', async () => {
  const r = repo();
  r.write('a.txt', 'x\n');
  const hash = r.commit('root');
  const c = await git.commit(r.dir, hash);
  assert.deepEqual(c.files.map((f) => [f.file, f.code, f.add]), [['a.txt', 'A', 1]]);
});

test('il diff di un file non tracciato lo mostra tutto come aggiunto', async () => {
  const r = repo();
  r.write('a.txt', 'x\n');
  r.commit('init');
  r.write('nuovo.txt', 'uno\ndue\n');
  const diff = await git.fileDiff(r.dir, { file: 'nuovo.txt', untracked: true });
  assert.match(diff, /^\+uno$/m);
  assert.match(diff, /^\+due$/m);
});

test('il diff include tutto il file come contesto', async () => {
  const r = repo();
  const lines = Array.from({ length: 50 }, (_, i) => `riga ${i + 1}`);
  r.write('a.txt', `${lines.join('\n')}\n`);
  r.commit('init');
  lines[25] = 'cambiata';
  r.write('a.txt', `${lines.join('\n')}\n`);
  const diff = await git.fileDiff(r.dir, { file: 'a.txt' });
  assert.match(diff, /^ riga 1$/m);
  assert.match(diff, /^ riga 50$/m);
});

test('il log distingue rami locali con slash dai remoti (decorazioni complete)', async () => {
  const r = repo();
  r.write('a.txt', 'x\n');
  r.commit('init');
  r.run('branch', 'feature/x');
  const [c] = await git.log(r.dir);
  assert.ok(c.refs.includes('refs/heads/feature/x'), `refs were: ${c.refs.join(', ')}`);
});

test('commit tramite action usa il messaggio da stdin e cambia lo stato', async () => {
  const r = repo();
  r.write('a.txt', 'x\n');
  r.commit('init');
  r.write('a.txt', 'y\n');
  await git.action(r.dir, 'stageAll');
  await git.action(r.dir, 'commit', { message: 'messaggio con "virgolette" e $simboli' });
  const [last] = await git.log(r.dir);
  assert.equal(last.subject, 'messaggio con "virgolette" e $simboli');
  assert.equal((await git.status(r.dir)).staged.length, 0);
});

test('un\'azione sconosciuta viene rifiutata', async () => {
  const r = repo();
  await assert.rejects(git.action(r.dir, 'rm -rf'), /sconosciuta/);
});

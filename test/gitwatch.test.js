// Integration: the .git watcher on a real repository.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { GitWatcher } = require('../src/main/gitwatch');
const { tempDir } = require('./helpers/tmp');

function repo() {
  const dir = tempDir('work-watch-');
  const run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  run('init', '-q');
  run('config', 'user.email', 't@example.com');
  run('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'a.txt'), '1\n');
  run('add', '-A');
  run('commit', '-qm', 'init');
  return { dir, run };
}

// Resolves with the kinds reported within `ms` after `action` runs.
async function eventsAfter(dir, action, ms = 900) {
  const kinds = [];
  const w = new GitWatcher((_repo, kind) => kinds.push(kind));
  w.watch(dir);
  await new Promise((r) => setTimeout(r, 100));
  action();
  await new Promise((r) => setTimeout(r, ms));
  w.stop();
  return kinds;
}

test('uno stage cambia solo l\'index e viene segnalato come "index"', async () => {
  const r = repo();
  fs.writeFileSync(path.join(r.dir, 'a.txt'), '2\n');
  assert.deepEqual(await eventsAfter(r.dir, () => r.run('add', 'a.txt')), ['index']);
});

test('un commit sposta il ramo e viene segnalato come "full"', async () => {
  const r = repo();
  fs.writeFileSync(path.join(r.dir, 'a.txt'), '2\n');
  r.run('add', 'a.txt');
  assert.deepEqual(await eventsAfter(r.dir, () => r.run('commit', '-qm', 'second')), ['full']);
});

test('un nuovo ramo viene segnalato come "full"', async () => {
  const r = repo();
  assert.deepEqual(await eventsAfter(r.dir, () => r.run('branch', 'feature/x')), ['full']);
});

test('anche in un git worktree (dove .git è un file) uno stage e un commit vengono segnalati (regressione)', async () => {
  const r = repo();
  const wt = tempDir('work-wt-');
  fs.rmdirSync(wt);
  r.run('worktree', 'add', '-q', '-b', 'agente', wt);
  const run = (...args) => execFileSync('git', args, { cwd: wt, stdio: 'pipe' });
  fs.writeFileSync(path.join(wt, 'a.txt'), '2\n');
  assert.deepEqual(await eventsAfter(wt, () => run('add', 'a.txt')), ['index']);
  assert.deepEqual(await eventsAfter(wt, () => run('commit', '-qm', 'dal worktree')), ['full']);
});

test('un file .git illeggibile o anomalo non fa fallire il watcher', async () => {
  const dir = tempDir('work-badgit-');
  fs.writeFileSync(path.join(dir, '.git'), 'non è un puntatore gitdir\n');
  const kinds = [];
  const w = new GitWatcher((_repo, kind) => kinds.push(kind));
  assert.doesNotThrow(() => w.watch(dir));
  assert.doesNotThrow(() => w.watch(tempDir('work-nogit-')));
  w.stop();
  assert.deepEqual(kinds, []);
});

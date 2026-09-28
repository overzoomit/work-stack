// Integration: the .git watcher on a real repository.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { GitWatcher } = require('../src/main/gitwatch');

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-watch-'));
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

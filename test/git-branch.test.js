const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseBranchHeader } = require('../src/main/git');

test('legge ramo e upstream semplici', () => {
  assert.deepEqual(parseBranchHeader('## main...origin/main'), { name: 'main', upstream: 'origin/main', ahead: 0, behind: 0 });
});

test('i nomi di ramo con punti non vengono troncati (regressione)', () => {
  assert.deepEqual(parseBranchHeader('## release/1.2...origin/release/1.2 [ahead 1]'), {
    name: 'release/1.2', upstream: 'origin/release/1.2', ahead: 1, behind: 0,
  });
});

test('legge insieme commit avanti e indietro', () => {
  const b = parseBranchHeader('## v2.0.1-fix...upstream/v2.0.1-fix [ahead 3, behind 12]');
  assert.equal(b.ahead, 3);
  assert.equal(b.behind, 12);
});

test('un upstream cancellato ([gone]) non produce conteggi', () => {
  assert.deepEqual(parseBranchHeader('## feat/x...origin/feat/x [gone]'), { name: 'feat/x', upstream: 'origin/feat/x', ahead: 0, behind: 0 });
});

test('un ramo senza upstream ha upstream null', () => {
  assert.equal(parseBranchHeader('## main').upstream, null);
});

test('un repository senza commit riporta il nome del ramo', () => {
  assert.equal(parseBranchHeader('## No commits yet on main').name, 'main');
});

test('HEAD staccato viene riportato come HEAD', () => {
  assert.equal(parseBranchHeader('## HEAD (no branch)').name, 'HEAD');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDiff } from '../src/renderer/diff.js';

const hunk = (body, header = '@@ -1,3 +1,3 @@') => `diff --git a/f b/f\n--- a/f\n+++ b/f\n${header}\n${body}\n`;

test('le righe di contesto hanno lo stesso testo e numeri di riga su entrambi i lati', () => {
  const { rows } = parseDiff(hunk(' uno\n due\n tre'));
  assert.deepEqual(rows.map((r) => [r.type, r.l.n, r.r.n, r.l.t]), [
    ['ctx', 1, 1, 'uno'],
    ['ctx', 2, 2, 'due'],
    ['ctx', 3, 3, 'tre'],
  ]);
});

test('una riga modificata viene affiancata alla sua versione precedente', () => {
  const { rows } = parseDiff(hunk(' a\n-  return 1;\n+  return 2;\n b'));
  const mod = rows.find((r) => r.type === 'mod');
  assert.equal(mod.l.t, '  return 1;');
  assert.equal(mod.r.t, '  return 2;');
  assert.equal(mod.whole, false);
});

test('le righe vengono accoppiate per somiglianza, non per posizione', () => {
  // git lists "-return 1" before both additions; the matching pair is return ↔ return.
  const { rows } = parseDiff(hunk(
    ' export function App() {\n-  return 1;\n+  const [count] = useState(0);\n+  return count + 1;\n }',
    '@@ -1,3 +1,4 @@',
  ));
  const changed = rows.filter((r) => r.type !== 'ctx');
  assert.deepEqual(changed.map((r) => [r.type, r.l?.t ?? null, r.r?.t ?? null]), [
    ['add', null, '  const [count] = useState(0);'],
    ['mod', '  return 1;', '  return count + 1;'],
  ]);
});

test('un blocco riscritto da zero resta affiancato ma senza evidenziare le parole', () => {
  const { rows } = parseDiff(hunk(' x\n-old A\n-old B\n+totally new 1\n y', '@@ -1,4 +1,3 @@'));
  const changed = rows.filter((r) => r.type !== 'ctx');
  assert.deepEqual(changed.map((r) => [r.type, r.whole]), [['mod', true], ['del', true]]);
});

test('un file nuovo (hunk -0,0) numera solo il lato destro partendo da 1', () => {
  const { rows } = parseDiff(hunk('+prima\n+seconda', '@@ -0,0 +1,2 @@'));
  assert.deepEqual(rows.map((r) => [r.type, r.l, r.r.n]), [['add', null, 1], ['add', null, 2]]);
});

test('tra due hunk distanti compare un segnaposto con le righe omesse', () => {
  const text = `${hunk(' a\n-b\n+B', '@@ -1,2 +1,2 @@')}@@ -40,2 +40,2 @@\n ctx\n-x\n+y\n`;
  const gap = parseDiff(text).rows.find((r) => r.type === 'gap');
  assert.equal(gap.count, 37); // lines 3..39 were not sent
});

test('i file binari vengono riconosciuti e non producono righe', () => {
  const parsed = parseDiff('diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ\n');
  assert.equal(parsed.binary, true);
  assert.equal(parsed.rows.length, 0);
});

test('la riga "\\ No newline at end of file" viene ignorata', () => {
  const { rows } = parseDiff(hunk('-a\n\\ No newline at end of file\n+a\n', '@@ -1 +1 @@'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'mod');
});

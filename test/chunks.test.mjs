// insertChunked with a minimal stand-in for the DOM: blocks are plain objects
// kept in document order in `doc`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insertChunked, resetChunks } from '../src/renderer/chunks.js';

function fakeDom() {
  const doc = [];
  globalThis.document = {
    createElement: () => {
      const el = { className: '', innerHTML: '', after: (next) => doc.splice(doc.indexOf(el) + 1, 0, next) };
      return el;
    },
  };
  return doc;
}

const rows = (n) => Array.from({ length: n }, (_, i) => `<r${i}>`);

test('inserisce le righe in blocchi ordinati della dimensione richiesta', async () => {
  const doc = fakeDom();
  const owner = {};
  resetChunks(owner);
  await insertChunked(owner, rows(10), { size: 4, className: 'b', place: (el) => doc.push(el) });
  assert.deepEqual(doc.map((b) => b.innerHTML), ['<r0><r1><r2><r3>', '<r4><r5><r6><r7>', '<r8><r9>']);
  assert.ok(doc.every((b) => b.className === 'b'));
});

test('il primo blocco è inserito subito, prima di cedere il controllo', () => {
  const doc = fakeDom();
  const owner = {};
  resetChunks(owner);
  insertChunked(owner, rows(10), { size: 4, className: 'b', place: (el) => doc.push(el) }); // not awaited
  assert.equal(doc.length, 1);
  assert.equal(doc[0].innerHTML, '<r0><r1><r2><r3>');
});

test('un nuovo render cancella i blocchi ancora da inserire del precedente', async () => {
  const doc = fakeDom();
  const owner = {};
  resetChunks(owner);
  const first = insertChunked(owner, rows(12), { size: 4, className: 'old', place: (el) => doc.push(el) });
  resetChunks(owner); // the owner re-renders before the rest arrives
  await first;
  assert.deepEqual(doc.map((b) => b.className), ['old']);
});

test('i blocchi successivi seguono il primo anche se inserito in mezzo', async () => {
  const doc = fakeDom();
  doc.push({ innerHTML: 'prima' }, { innerHTML: 'dopo' });
  const owner = {};
  resetChunks(owner);
  await insertChunked(owner, rows(6), { size: 2, className: 'b', place: (el) => doc.splice(1, 0, el) });
  assert.deepEqual(doc.map((b) => b.innerHTML), ['prima', '<r0><r1>', '<r2><r3>', '<r4><r5>', 'dopo']);
});

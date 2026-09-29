// Pure helpers of ui.js (the module also wires DOM listeners, stubbed here).
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.addEventListener = () => {};
const { ago, basename, dirname, setHtml, esc } = await import('../src/renderer/ui.js');

test('ago descrive il tempo trascorso in forma breve', () => {
  const now = Date.now();
  assert.equal(ago(now - 3_000), 'ora');
  assert.equal(ago(now + 60_000), 'ora', 'a clock slightly ahead is not "in the future"');
  assert.equal(ago(now - 42_000), '42s');
  assert.equal(ago(now - 5 * 60_000), '5 min');
  assert.equal(ago(now - 3 * 3600_000), '3 h');
  assert.equal(ago(now - 2 * 86400_000), '2 g');
  assert.match(ago(now - 60 * 86400_000), /\d{2} \w+/, 'older: a date');
});

test('basename e dirname sui percorsi del progetto', () => {
  assert.equal(basename('/p/src/a.js'), 'a.js');
  assert.equal(basename('/p/src/'), 'src');
  assert.equal(dirname('/p/src/a.js'), '/p/src');
  assert.equal(dirname('/a.js'), '/');
});

test('setHtml riscrive il contenuto solo quando cambia', () => {
  const el = { innerHTML: '' };
  assert.equal(setHtml(el, '<li>a</li>'), true);
  assert.equal(setHtml(el, '<li>a</li>'), false, 'same markup: no re-layout');
  assert.equal(el.innerHTML, '<li>a</li>');
  assert.equal(setHtml(el, '<li>b</li>'), true);
  assert.equal(el.innerHTML, '<li>b</li>');
});

test('esc neutralizza i caratteri HTML', () => {
  assert.equal(esc(`<img src=x onerror="a('b')">&`), '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;');
  assert.equal(esc(null), '');
});

test('clip accorcia senza spezzare un\'emoji a metà (regressione: titolo del terminale di "Riprendi")', async () => {
  const { clip } = await import('../src/renderer/ui.js');
  assert.equal(clip(`${'a'.repeat(39)}🚀 resto`, 40), 'a'.repeat(39));
  assert.equal(clip('corto', 40), 'corto');
  assert.equal(clip('ab🚀', 4), 'ab🚀');
});

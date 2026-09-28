// renderDiff with a minimal stand-in for the DOM: the rows' HTML is what the
// viewer shows, so the tests read it back from the inserted blocks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDiff, renderDiff } from '../src/renderer/diff.js';

globalThis.document = {
  createElement: () => {
    const el = { innerHTML: '', after(next) { this.box.blocks.splice(this.box.blocks.indexOf(el) + 1, 0, next); next.box = this.box; } };
    return el;
  },
};

function fakeBox() {
  const box = { blocks: [], innerHTML: '', className: '' };
  box.append = (el) => { el.box = box; box.blocks.push(el); };
  box.html = () => box.innerHTML + box.blocks.map((b) => b.innerHTML).join('');
  return box;
}

const diff = (body) => parseDiff(`diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,20 +1,20 @@\n${body}\n`);
const ctx = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => ` riga ${from + i}`).join('\n');

test('affiancato: la riga modificata mostra i numeri di entrambi i lati e la parola cambiata', () => {
  const box = fakeBox();
  const nav = renderDiff(box, diff('-const a = 1;\n+const a = 2;'), 'side');
  const html = box.html();
  assert.equal(box.className, 'diff side');
  assert.match(html, /class="d-row mod" data-i="0" data-change/);
  assert.match(html, /<span class="code l">const a = <span class="w">1<\/span>;<\/span>/);
  assert.match(html, /<span class="code r">const a = <span class="w">2<\/span>;<\/span>/);
  assert.equal(nav.count, 1);
});

test('affiancato: una riga solo aggiunta ha la cella di sinistra vuota', () => {
  const box = fakeBox();
  renderDiff(box, diff(' prima\n+nuova'), 'side');
  assert.match(box.html(), /<span class="ln"><\/span><span class="code l blank">&nbsp;<\/span>\s*<span class="ln">2<\/span><span class="code r">nuova<\/span>/);
});

test('unificato: una modifica diventa una riga tolta e una aggiunta con i segni', () => {
  const box = fakeBox();
  renderDiff(box, diff('-x <b>\n+y <b>'), 'unified');
  const html = box.html();
  assert.equal(box.className, 'diff unified');
  assert.match(html, /u-row del.*<span class="sign">−<\/span><span class="code"><span class="w">x<\/span> &lt;b&gt;<\/span>/s);
  assert.match(html, /u-row add.*<span class="sign">\+<\/span><span class="code"><span class="w">y<\/span> &lt;b&gt;<\/span>/s);
});

test('le righe invariate lontane dalle modifiche vengono compresse e si espandono al clic', () => {
  const box = fakeBox();
  renderDiff(box, diff(`${ctx(1, 10)}\n-vecchia\n+nuova\n${ctx(12, 20)}`), 'side');
  const html = box.html();
  assert.match(html, /data-from="0" data-count="6">[\s\S]*6 righe invariate/);
  assert.match(html, /data-count="5">[\s\S]*5 righe invariate/);
  assert.equal((html.match(/class="d-row ctx"/g) || []).length, 8, '4 context lines on each side of the change');
  // Click on the first gap: its rows replace it.
  let replaced = null;
  const gap = { dataset: { from: '0', count: '6' }, replaceWith: (el) => { replaced = el; el.box = box; box.blocks.push(el); } };
  box.onclick({ target: { closest: () => gap } });
  assert.equal((replaced.innerHTML.match(/class="d-row ctx"/g) || []).length, 6);
  assert.match(replaced.innerHTML, /riga 1<\/span>/);
});

test('file binari e diff senza modifiche mostrano un messaggio invece delle righe', () => {
  const bin = fakeBox();
  assert.equal(renderDiff(bin, parseDiff('Binary files a/i.png and b/i.png differ\n')).count, 0);
  assert.match(bin.innerHTML, /File binario/);
  const same = fakeBox();
  assert.equal(renderDiff(same, diff(' uguale')).count, 0);
  assert.match(same.innerHTML, /Nessuna differenza/);
});

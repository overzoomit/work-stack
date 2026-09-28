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

test('un blocco enorme di righe cambiate viene accoppiato per posizione, senza confronto riga per riga', () => {
  const dels = Array.from({ length: 70 }, (_, i) => `-vecchia ${i}`);
  const adds = Array.from({ length: 80 }, (_, i) => `+altro testo ${i}`);
  const { rows } = diff([...dels, ...adds].join('\n'));
  assert.equal(rows.length, 80);
  assert.deepEqual([rows[0].l.t, rows[0].r.t], ['vecchia 0', 'altro testo 0']);
  assert.equal(rows[79].l, null, 'extra additions stay unpaired');
  assert.equal(rows[79].type, 'add');
});

test('in modalità unificata le righe che git non ha inviato compaiono come segnaposto', () => {
  const box = fakeBox();
  const parsed = parseDiff('diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,1 +1,1 @@\n-a\n+b\n@@ -50,1 +50,1 @@\n-c\n+d\n');
  renderDiff(box, parsed, 'unified');
  assert.match(box.html(), /d-gap static[\s\S]*48 righe non incluse/);
});

test('F7 e Shift+F7 visitano i blocchi di modifiche in ordine e ricominciano dall\'inizio', async () => {
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  const visited = [];
  const rowFor = (i) => ({
    scrollIntoView: () => visited.push(i),
    getBoundingClientRect: () => ({ top: 100 }), // settled on the first check
    classList: { add: (c) => c === 'flash' && visited.push(`flash:${i}`), remove() {} },
    offsetWidth: 1,
  });
  const box = fakeBox();
  box.querySelector = (sel) => rowFor(Number(sel.match(/data-i="(\d+)"/)[1]));
  // Change blocks start at rows 1 (b → b2) and 4 (e → e2, then + f on row 5).
  const nav = renderDiff(box, diff(' a\n-b\n+b2\n c\n d\n-e\n+e2\n+f'), 'side');
  assert.equal(nav.count, 2);
  await nav.next();
  await nav.next();
  await nav.next(); // wraps to the first block
  await nav.prev(); // back to the last
  assert.deepEqual(visited.filter((v) => typeof v === 'number').filter((v, k, all) => all[k - 1] !== v), [1, 4, 1, 4]);
  assert.ok(visited.includes('flash:4'));
});

test('il segnaposto delle righe non incluse usa il singolare per una riga (regressione)', () => {
  for (const mode of ['side', 'unified']) {
    const box = fakeBox();
    // Two hunks one line apart: git left out exactly one unchanged line.
    renderDiff(box, parseDiff('diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n@@ -3 +3 @@\n-c\n+d\n'), mode);
    assert.match(box.html(), /1 riga non inclusa/, mode);
    assert.doesNotMatch(box.html(), /1 righe/, mode);
  }
});

test('se cambia solo l\'a capo finale, il lato che ce l\'ha mostra ⏎ evidenziato (regressione)', () => {
  // Old file had no final newline, the new one has it.
  const parsed = parseDiff('diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-ultima riga\n\\ No newline at end of file\n+ultima riga\n');
  for (const mode of ['side', 'unified']) {
    const box = fakeBox();
    renderDiff(box, parsed, mode);
    const html = box.html();
    assert.equal((html.match(/⏎/g) || []).length, 1, mode);
    assert.match(html, /ultima riga<span class="w ws" title="[^"]*a capo[^"]*">⏎<\/span>/, `${mode}: on the new side, which ends with a newline`);
  }
});

test('un file nuovo o eliminato vuoto lo dice, invece di "solo rinomina o permessi" (regressione)', () => {
  const box = fakeBox();
  renderDiff(box, parseDiff('diff --git a/vuoto.txt b/vuoto.txt\nnew file mode 100644\nindex 0000000..e69de29\n'), 'side');
  assert.match(box.html(), /File nuovo vuoto/);
  renderDiff(box, parseDiff('diff --git a/v b/v\ndeleted file mode 100644\nindex e69de29..0000000\n'), 'side');
  assert.match(box.html(), /File vuoto eliminato/);
  renderDiff(box, parseDiff('diff --git a/x b/x\nold mode 100644\nnew mode 100755\n'), 'side');
  assert.match(box.html(), /solo rinomina o permessi/, 'a mode change keeps its message');
});

// Links in the Markdown preview: web and mail links open outside Work,
// relative ones open the file in the preview, anchors stay in the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { $, tick } from './helpers/renderer-env.mjs';

const files = new Map();
globalThis.window.work.fs = { read: async (p) => files.get(p), openPath() {} };

const { linkTarget, previewFile, closeViewer } = await import('../src/renderer/preview.js');
const base = 'file:///home/u/app/docs/';

test('i link dell\'anteprima: web e mail fuori da Work, relativi nell\'anteprima, ancore nella pagina (regressione: mailto)', () => {
  assert.deepEqual(linkTarget('https://example.com/x', base), { external: 'https://example.com/x' });
  assert.deepEqual(linkTarget('mailto:anna@example.com', base), { external: 'mailto:anna@example.com' });
  assert.deepEqual(linkTarget('../README.md#install', base), { local: '/home/u/app/README.md' });
  assert.deepEqual(linkTarget('guida%20rapida.md', base), { local: '/home/u/app/docs/guida rapida.md' });
  assert.deepEqual(linkTarget('#sezione', base), { anchor: true });
});

test('anteprima di un file di testo: righe numerate ed escapate', async () => {
  files.set('/p/a.txt', { text: 'prima\nsec <b>onda</b>', size: 20 });
  await previewFile('/p/a.txt');
  assert.equal($('#viewer').hidden, false);
  assert.equal($('#viewer-mode').hidden, true, 'plain text has no rendered view');
  const rows = $('#viewer-body').firstChild.children.map((c) => c.innerHTML).join('');
  assert.match(rows, /<span class="ln">2<\/span><span class="code">sec &lt;b&gt;onda&lt;\/b&gt;<\/span>/);
  closeViewer();
  await tick();
  assert.equal($('#viewer').hidden, true);
});

test('una pagina HTML gira in un iframe isolato: script sì, accesso a Work no', async () => {
  files.set('/p/pagina.html', { text: '<script>1</script>', size: 20 });
  await previewFile('/p/pagina.html');
  const html = $('#viewer-body').innerHTML;
  assert.match(html, /<iframe class="html-frame" sandbox="allow-scripts allow-forms allow-modals" src="file:\/\/\/p\/pagina\.html"><\/iframe>/);
  assert.doesNotMatch(html, /allow-same-origin/);
  closeViewer();
});

test('file binari e troppo grandi non vengono mostrati', async () => {
  files.set('/p/img.png', { binary: true, size: 10 });
  await previewFile('/p/img.png');
  assert.match($('#viewer-body').innerHTML, /File binario/);
  files.set('/p/big.log', { tooBig: true, size: 3 * 1024 * 1024 });
  await previewFile('/p/big.log');
  assert.match($('#viewer-body').innerHTML, /troppo grande per l'anteprima \(3072 KB\)/);
  closeViewer();
});

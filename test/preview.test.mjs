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

test('una pagina HTML si vede in un iframe isolato, senza eseguire i suoi script', async () => {
  files.set('/p/pagina.html', { text: '<script>1</script>', size: 20 });
  await previewFile('/p/pagina.html');
  const html = $('#viewer-body').innerHTML;
  assert.match(html, /<iframe class="html-frame" sandbox="[^"]*" src="file:\/\/\/p\/pagina\.html"><\/iframe>/);
  // A script in a file of the repository could read the other project files (regressione).
  assert.doesNotMatch(html, /allow-scripts/);
  assert.doesNotMatch(html, /allow-same-origin/);
  // alert() from the page would block Work's whole window until dismissed (regressione).
  assert.doesNotMatch(html, /allow-modals/);
  closeViewer();
});

test('gli script di una pagina HTML girano solo dopo averli attivati, per quel file', async () => {
  files.set('/p/app.html', { text: '<script>1</script>', size: 20 });
  await previewFile('/p/app.html');
  const flag = $('#viewer-actions').children.find((b) => b.textContent === 'Esegui script');
  assert.ok(flag, 'the HTML preview has the flag');
  assert.doesNotMatch($('#viewer-body').innerHTML, /allow-scripts/, 'off by default');
  flag.onclick();
  assert.match($('#viewer-body').innerHTML, /sandbox="allow-scripts allow-forms"/);
  assert.ok(flag.classList.contains('active'));
  await previewFile('/p/app.html');
  assert.doesNotMatch($('#viewer-body').innerHTML, /allow-scripts/, 'opening the file again starts without scripts');
  files.set('/p/b.txt', { text: 't', size: 1 });
  await previewFile('/p/b.txt');
  assert.ok(!$('#viewer-actions').children.some((b) => b.textContent === 'Esegui script'), 'only for HTML');
  closeViewer();
});

test('file binari e troppo grandi non vengono mostrati', async () => {
  files.set('/p/dati.bin', { binary: true, size: 10 });
  await previewFile('/p/dati.bin');
  assert.match($('#viewer-body').innerHTML, /File binario/);
  files.set('/p/big.log', { tooBig: true, size: 3 * 1024 * 1024 });
  await previewFile('/p/big.log');
  assert.match($('#viewer-body').innerHTML, /troppo grande per l'anteprima \(3072 KB\)/);
  closeViewer();
});

test('le immagini si vedono, anche binarie o grandi; lo SVG tiene anche il sorgente', async () => {
  files.set('/p/foto.png', { tooBig: true, size: 5 * 1024 * 1024 });
  await previewFile('/p/foto.png');
  assert.match($('#viewer-body').innerHTML, /<div class="pv-image"><img src="file:\/\/\/p\/foto\.png\?\d+"/);
  assert.equal($('#viewer-mode').hidden, true, 'a raster image has no source view');
  files.set('/p/logo.svg', { text: '<svg/>', size: 6 });
  await previewFile('/p/logo.svg');
  assert.equal($('#viewer-mode').hidden, false);
  closeViewer();
});

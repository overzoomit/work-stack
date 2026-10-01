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

const { toLF, fromLF, requestClose } = await import('../src/renderer/preview.js');
const actionsByLabel = () => Object.fromEntries($('#viewer-actions').children.map((b) => [b.textContent, b]));

test('i fine riga CRLF si modificano come \\n e tornano CRLF al salvataggio', () => {
  assert.equal(toLF('a\r\nb\r\n'), 'a\nb\n');
  assert.equal(fromLF('a\nb\n', true), 'a\r\nb\r\n');
  assert.equal(fromLF('a\nb\n', false), 'a\nb\n');
});

test('Modifica solo per i file di testo UTF-8', async () => {
  files.set('/p/ok.txt', { text: 'x', size: 1, mtime: 1, utf8: true });
  await previewFile('/p/ok.txt');
  assert.ok(actionsByLabel().Modifica);
  files.set('/p/latin1.txt', { text: 'caff�', size: 5, mtime: 1, utf8: false });
  await previewFile('/p/latin1.txt');
  assert.equal(actionsByLabel().Modifica, undefined, 'saving would rewrite its bytes');
  files.set('/p/dati.bin', { binary: true, size: 10 });
  await previewFile('/p/dati.bin');
  assert.equal(actionsByLabel().Modifica, undefined);
  closeViewer();
});

test('salvare scrive il testo con i fine riga originali e torna all\'anteprima', async () => {
  const writes = [];
  window.work.fs.write = async (file, text, mtime, force) => { writes.push({ file, text, mtime, force }); return { mtime: 2 }; };
  files.set('/p/win.txt', { text: 'uno\r\ndue\r\n', size: 10, mtime: 1, utf8: true });
  await previewFile('/p/win.txt');
  actionsByLabel().Modifica.onclick();
  const ta = $('#viewer-body').querySelector('.pv-edit-text');
  assert.equal(ta.value, 'uno\ndue\n');
  const salva = Object.entries(actionsByLabel()).find(([l]) => l.startsWith('Salva'))[1];
  assert.equal(salva.disabled, true, 'nothing to save yet');
  ta.value = 'uno\ntre\n';
  ta.oninput();
  assert.equal(salva.disabled, false);
  assert.equal($('#viewer-dirty').hidden, false, 'the title shows the unsaved dot');
  await salva.onclick();
  assert.deepEqual(writes, [{ file: '/p/win.txt', text: 'uno\r\ntre\r\n', mtime: 1, force: false }]);
  assert.ok(actionsByLabel().Modifica, 'back to the preview');
  assert.equal($('#viewer-dirty').hidden, true);
  closeViewer();
});

test('chiudere con modifiche non salvate chiede prima: Scarta chiude, Continua resta', async () => {
  files.set('/p/env.txt', { text: 'A=1\n', size: 4, mtime: 1, utf8: true });
  await previewFile('/p/env.txt');
  actionsByLabel().Modifica.onclick();
  const ta = $('#viewer-body').querySelector('.pv-edit-text');
  ta.value = 'A=2\n';
  ta.oninput();

  requestClose();
  await tick();
  assert.equal($('#viewer').hidden, false, 'not closed');
  assert.equal($('#viewer-bar').hidden, false);
  assert.match($('#viewer-bar').innerHTML, /Hai modifiche non salvate in <b>env\.txt<\/b>/);
  $('#viewer-bar').querySelector('.pv-keep').onclick();
  assert.equal($('#viewer-bar').hidden, true);
  assert.equal(ta.value, 'A=2\n', 'the edits are still there');

  requestClose();
  $('#viewer-bar').querySelector('.pv-discard').onclick();
  await tick();
  assert.equal($('#viewer').hidden, true);
});

test('Annulla senza modifiche torna subito all\'anteprima', async () => {
  files.set('/p/b.txt', { text: 'b', size: 1, mtime: 1, utf8: true });
  await previewFile('/p/b.txt');
  actionsByLabel().Modifica.onclick();
  actionsByLabel().Annulla.onclick();
  assert.equal($('#viewer-bar').hidden, true);
  assert.ok(actionsByLabel().Modifica);
  closeViewer();
});

test('un file cambiato su disco mostra la striscia: Sovrascrivi forza, Ricarica prende il disco', async () => {
  const writes = [];
  window.work.fs.write = async (file, text, mtime, force) => {
    writes.push({ text, force });
    if (!force) throw 'CHANGED'; // Tauri rejects with the command's error string
    return { mtime: 9 };
  };
  files.set('/p/c.txt', { text: 'mio\n', size: 4, mtime: 1, utf8: true });
  await previewFile('/p/c.txt');
  actionsByLabel().Modifica.onclick();
  const ta = $('#viewer-body').querySelector('.pv-edit-text');
  ta.value = 'modificato\n';
  ta.oninput();
  await Object.entries(actionsByLabel()).find(([l]) => l.startsWith('Salva'))[1].onclick();
  assert.equal($('#viewer-conflict').hidden, false);
  assert.match($('#viewer-conflict').innerHTML, /<b>c\.txt<\/b> è cambiato su disco/);
  assert.equal(ta.value, 'modificato\n', 'the edits stay until the user chooses');

  files.set('/p/c.txt', { text: 'dal terminale\n', size: 14, mtime: 5, utf8: true });
  await $('#viewer-conflict').querySelector('.pv-reload').onclick();
  assert.equal(ta.value, 'dal terminale\n');
  assert.equal($('#viewer-conflict').hidden, true);

  ta.value = 'di nuovo mio\n';
  ta.oninput();
  await Object.entries(actionsByLabel()).find(([l]) => l.startsWith('Salva'))[1].onclick();
  $('#viewer-conflict').querySelector('.pv-overwrite').onclick();
  await tick();
  assert.deepEqual(writes.at(-1), { text: 'di nuovo mio\n', force: true });
  assert.ok(actionsByLabel().Modifica, 'saved: back to the preview');
  closeViewer();
});

test('le righe di un .env: nomi, export, valori vuoti e commenti', async () => {
  const { envLine, isEnvFile } = await import('../src/renderer/preview.js');
  assert.deepEqual(envLine('DATABASE_URL=postgres://x'), { key: 'DATABASE_URL', eq: '=', value: 'postgres://x' });
  assert.deepEqual(envLine('export API_KEY = "abc"'), { key: 'export API_KEY', eq: ' = ', value: '"abc"' });
  assert.deepEqual(envLine('VUOTO='), { key: 'VUOTO', eq: '=', value: '' });
  assert.deepEqual(envLine('  # commento'), { comment: '  # commento' });
  assert.equal(envLine('testo libero'), null);
  assert.equal(envLine(''), null);
  assert.ok(isEnvFile('/p/.env.local') && isEnvFile('/p/.env'));
  assert.ok(!isEnvFile('/p/config.env') && !isEnvFile('/p/env.txt'));
});

test('un .env si apre con i valori visibili; "Nascondi valori" li copre tutti', async () => {
  files.set('/p/.env', { text: '# db\nDB=segreto\nVUOTO=\n', size: 22, mtime: 1, utf8: true });
  await previewFile('/p/.env');
  const html = () => $('#viewer-body').firstChild.children.map((c) => c.innerHTML).join('');
  assert.match(html(), /<span class="env-key">DB<\/span>=<span class="env-val">segreto<\/span>/);
  assert.match(html(), /<span class="env-comment"># db<\/span>/);
  actionsByLabel()['Nascondi valori'].onclick();
  await tick();
  assert.doesNotMatch(html(), /segreto/);
  assert.match(html(), /••••••••••/);
  assert.ok(actionsByLabel()['Mostra valori']);
  assert.match($('#viewer-foot').innerHTML, /4 righe · 22 byte · UTF-8/);
  assert.match($('#viewer-foot').innerHTML, /<kbd>esc<\/kbd> Chiudi/);
  closeViewer();
});

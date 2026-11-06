// Docked browser preview: address bar, history, viewport switch, QA snapshot,
// dev-server port detection and the split-tree integration with the terminals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env, $, tick } from './helpers/renderer-env.mjs';

const W = await import('../src/renderer/webview_pane.js');
const T = await import('../src/renderer/terminals.js');
T.initTerminals({ homeDir: '/home/u', changed() {} });

const project = (path) => ({ path, name: path, focusedId: null, maximizedId: null });
const toasts = () => $('#toasts').children;
const lastToast = () => toasts().at(-1);
const actionOf = (toast) => toast.children.find((c) => c.className === 'toast-action');

test('solo indirizzi http/https: "localhost:5173" diventa http, gli altri schemi sono rifiutati', () => {
  assert.equal(W.normalizePreviewUrl('localhost:5173'), 'http://localhost:5173/');
  assert.equal(W.normalizePreviewUrl('https://example.test/app'), 'https://example.test/app');
  assert.equal(W.normalizePreviewUrl('http://127.0.0.1:3000/'), 'http://127.0.0.1:3000/');
  assert.equal(W.normalizePreviewUrl('javascript:alert(1)'), null);
  assert.equal(W.normalizePreviewUrl('file:///etc/passwd'), null);
  assert.equal(W.normalizePreviewUrl(''), null);
  assert.equal(W.normalizePreviewUrl(null), null);
});

test('il pannello si monta con toolbar, indirizzo iniziale e cronologia', () => {
  const pane = W.createWebviewPane(project('/pv'), { url: 'http://localhost:5173' });
  assert.equal(pane.kind, 'webview');
  assert.equal(pane.url, 'http://localhost:5173/');
  assert.equal(pane.frame.src, 'http://localhost:5173/', 'the iframe loads the address');
  assert.equal(pane.address.value, 'http://localhost:5173/');
  assert.equal(pane.el.querySelector('.pane-title').textContent, 'localhost:5173');
  assert.ok(pane.el.classList.contains('webview-pane'));
  assert.ok(pane.el.querySelector('.webview-toolbar'), 'address bar');
  assert.ok(pane.el.querySelector('[data-act="reload"]'), 'reload');
  assert.ok(pane.el.querySelector('[data-act="back"]'), 'back');
  assert.ok(pane.el.querySelector('[data-act="open"]'), 'open in the system browser');
});

test('la barra indirizzi naviga, indietro/avanti seguono la cronologia e reload ricarica', () => {
  const pane = W.createWebviewPane(project('/nav'), { url: 'http://localhost:5173' });
  pane.address.value = 'localhost:3000';
  pane.address.onkeydown({ key: 'Enter', preventDefault() {} });
  assert.equal(pane.url, 'http://localhost:3000/');
  assert.equal(pane.frame.src, 'http://localhost:3000/');
  assert.deepEqual(pane.history, ['http://localhost:5173/', 'http://localhost:3000/']);
  assert.equal(pane.index, 1);

  pane.el.querySelector('[data-act="back"]').onclick();
  assert.equal(pane.url, 'http://localhost:5173/');
  assert.equal(pane.address.value, 'http://localhost:5173/');
  pane.el.querySelector('[data-act="forward"]').onclick();
  assert.equal(pane.url, 'http://localhost:3000/');

  pane.el.querySelector('[data-act="reload"]').onclick();
  assert.equal(pane.reloads, 1);
  assert.equal(pane.frame.src, 'http://localhost:3000/');

  // An invalid address keeps the current page and says why.
  const before = toasts().length;
  pane.address.value = 'javascript:alert(1)';
  pane.address.onkeydown({ key: 'Enter', preventDefault() {} });
  assert.equal(pane.url, 'http://localhost:3000/', 'the page did not change');
  assert.equal(toasts().length, before + 1);
  assert.match(lastToast().firstChild.textContent, /http:\/\/ or https:\/\//);
});

test('il selettore viewport passa a mobile e torna a desktop', () => {
  const pane = W.createWebviewPane(project('/vp'), { url: 'http://localhost:5173' });
  pane.el.querySelector('[data-act="viewport"]').onclick();
  assert.equal(pane.viewport, 'mobile');
  assert.ok(pane.el.classList.contains('mobile'));
  assert.equal(pane.el.querySelector('.webview-viewport').value, 'mobile');
  pane.el.querySelector('.webview-viewport').onchange({ target: { value: 'desktop' } });
  assert.equal(pane.viewport, 'desktop');
  assert.ok(!pane.el.classList.contains('mobile'));
});

test('lo snapshot QA chiama il backend, mostra il percorso e lo rivela dal toast', async () => {
  env.webview.calls.length = 0;
  env.webview.error = null;
  const pane = W.createWebviewPane(project('/shot'), { url: 'http://localhost:5173' });
  const path = await pane.el.querySelector('[data-act="snapshot"]').onclick();
  assert.equal(path, env.webview.path);
  assert.equal(pane.snapshotPath, env.webview.path);
  assert.deepEqual(env.webview.calls[0], ['capture', 'http://localhost:5173/']);
  assert.match(lastToast().firstChild.textContent, /Snapshot saved: .*webview-localhost-5173-1\.png/);
  actionOf(lastToast()).onclick();
  assert.deepEqual(env.webview.calls.at(-1), ['reveal', env.webview.path]);
});

test('uno snapshot fallito avvisa senza segnare il percorso', async () => {
  env.webview.error = new Error('nessuno strumento disponibile');
  const pane = W.createWebviewPane(project('/shot-fail'), { url: 'http://localhost:5173' });
  const before = toasts().length;
  const path = await pane.snapshot();
  assert.equal(path, null);
  assert.equal(pane.snapshotPath, null);
  assert.equal(toasts().length, before + 1);
  assert.match(lastToast().firstChild.textContent, /nessuno strumento disponibile/);
  env.webview.error = null;
});

test('il watcher riconosce un URL diviso tra due chunk, lo annuncia una volta sola e nota una porta nuova', () => {
  const found = [];
  const watch = W.createPortWatcher((pane, url) => found.push([pane.id, url]));
  const pane = { id: 7 };

  assert.equal(watch(pane, '  VITE ready\r\n  ➜  Local:   http://local'), null, 'line not ended yet');
  assert.equal(watch(pane, 'host:5173/\r\n'), 'http://localhost:5173');
  assert.deepEqual(found, [[7, 'http://localhost:5173']]);
  assert.equal(pane.previewUrl, 'http://localhost:5173');

  assert.equal(watch(pane, '  ➜  Local:   http://localhost:5173/\r\n'), null, 'same address: no second offer');
  assert.equal(watch(pane, '  ➜  Local:   http://localhost:3000/\r\n'), 'http://localhost:3000');
  assert.deepEqual(found.map(([, u]) => u), ['http://localhost:5173', 'http://localhost:3000']);
});

test('il watcher ignora sequenze ANSI e indirizzi non locali', () => {
  const found = [];
  const watch = W.createPortWatcher((_pane, url) => found.push(url));
  watch({ id: 1 }, '\x1b[32mLocal:\x1b[0m http://127.0.0.1:8080/\r\n');
  assert.deepEqual(found, ['http://127.0.0.1:8080']);
  watch({ id: 2 }, 'API: https://example.test\r\n');
  assert.deepEqual(found, ['http://127.0.0.1:8080'], 'public hosts are not local servers');
});

test('openWebview affianca il pannello al terminale con split orizzontale e verticale', async () => {
  env.tmuxAvailable = false;
  const p = project('/webview-split');
  T.showProject(p);

  const term = await T.openTerminal(p);
  const preview = T.openWebview(p, { url: 'http://localhost:5173', splitFrom: term, splitDirection: 'horizontal' });
  assert.equal(T.terminalsOf(p).length, 2, 'terminal and preview share the grid');
  assert.deepEqual(T.layoutSnapshot(p), {
    dir: 'row', ratio: 0.5,
    a: { pane: term.id },
    b: { pane: preview.id },
  });
  assert.ok(preview.id < 0, 'the preview has its own pane id');

  const second = T.openWebview(p, { splitDirection: 'vertical' });
  const snap = JSON.stringify(T.layoutSnapshot(p));
  assert.match(snap, /"dir":"col"/, 'the second preview stacks below');
  assert.ok(snap.includes(`"pane":${second.id}`));

  // Focus, maximize and close work like any other pane, without touching a PTY.
  T.focus(preview.id);
  assert.equal(p.focusedId, preview.id);
  T.toggleMax(preview.id);
  assert.equal(p.maximizedId, preview.id);
  T.toggleMax(preview.id);

  // A preview is not a tmux window: restarting must not try to reattach it.
  assert.ok(!T.terminalLayout(p).some((entry) => entry.title === 'Browser preview'));

  T.closeTerminal(preview.id);
  T.closeTerminal(second.id);
  assert.deepEqual(T.terminalsOf(p).map((t) => t.id), [term.id]);
  T.closeTerminal(term.id);
  await tick(700);
});

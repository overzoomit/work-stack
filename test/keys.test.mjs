import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRefreshKey } from '../src/renderer/keys.js';

const target = (inPane) => ({ closest: (s) => (s === '.pane' && inPane ? {} : null) });
const key = (k, { ctrl = false, meta = false, inPane = false } = {}) => ({ key: k, ctrlKey: ctrl, metaKey: meta, target: target(inPane) });

test('F5 aggiorna il progetto fuori dai terminali', () => {
  assert.equal(isRefreshKey(key('F5')), true);
  assert.equal(isRefreshKey(key('F6')), false);
  assert.equal(isRefreshKey(key('F5', { ctrl: true })), false, 'Ctrl+F5 is Run → rerun');
  assert.equal(isRefreshKey(key('F5', { meta: true })), false);
});

test('F5 dentro un terminale arriva al programma, non aggiorna (regressione: mc, htop)', () => {
  assert.equal(isRefreshKey(key('F5', { inPane: true })), false);
});

test('un target senza closest (window) non rompe il controllo', () => {
  assert.equal(isRefreshKey({ key: 'F5', ctrlKey: false, metaKey: false, target: {} }), true);
});

test('chiudi terminale: Ctrl/⌘+Shift+W ovunque, e su Mac anche ⌘W come in Terminal.app', async () => {
  const { isCloseTerminalKey } = await import('../src/renderer/keys.js');
  const k = (key, m = {}) => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...m });
  assert.equal(isCloseTerminalKey(k('W', { ctrlKey: true, shiftKey: true }), false), true);
  assert.equal(isCloseTerminalKey(k('W', { metaKey: true, shiftKey: true }), true), true);
  assert.equal(isCloseTerminalKey(k('w', { metaKey: true }), true), true, '⌘W on Mac');
  assert.equal(isCloseTerminalKey(k('w', { metaKey: true }), false), false, 'Super+W elsewhere belongs to the desktop');
  assert.equal(isCloseTerminalKey(k('w', { ctrlKey: true }), true), false, 'Ctrl+W is readline\'s delete-word');
  assert.equal(isCloseTerminalKey(k('w', { ctrlKey: true }), false), false);
});

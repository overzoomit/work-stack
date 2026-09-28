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

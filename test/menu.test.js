// macOS application menu: standard editing shortcuts, but no ⌘W closing the
// only window (and with it every terminal and running agent).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { macMenuTemplate } = require('../src/main/menu');

const flat = (items) => items.flatMap((i) => [i, ...(Array.isArray(i.submenu) ? flat(i.submenu) : [])]);

test('il menu Mac non chiude la finestra con ⌘W ma tiene copia/incolla ed esci (regressione)', () => {
  const items = flat(macMenuTemplate());
  assert.ok(!items.some((i) => i.role === 'close' || i.role === 'windowMenu' || i.role === 'fileMenu'), 'no Close Window (⌘W)');
  assert.ok(!items.some((i) => /(^|\+)W$/i.test(i.accelerator || '')), 'nothing else bound to ⌘W');
  assert.ok(items.some((i) => i.role === 'editMenu'), '⌘C / ⌘V / ⌘A keep working in terminals and fields');
  assert.ok(items.some((i) => i.role === 'appMenu'), 'the app menu, with ⌘Q');
  assert.ok(items.some((i) => i.role === 'minimize'));
});

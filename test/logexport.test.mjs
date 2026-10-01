// The log export in the page: the ⋯ menu (Linux) and the toasts that offer it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { El, openMenuItems, tick } from './helpers/renderer-env.mjs';

const exported = [];
let exportReply = '/home/u/Work-log.txt';
Object.assign(window.work.app, {
  exportLog: async () => { exported.push(true); return exportReply; },
  revealExport: async () => {},
});
const { moreMenu, stalledToast, closeMenu } = await import('../src/renderer/ui.js');
const lastToast = () => document.querySelector('#toasts').children.at(-1);
const action = (t) => t.children.find((c) => c.className === 'toast-action');

test('il menu ⋯ ha una sola voce, "Esporta log…", ed esporta', async () => {
  const button = new El();
  moreMenu(button);
  assert.ok(button.classList.contains('open'), 'the button stays highlighted while its menu is open');
  assert.deepEqual(Object.keys(openMenuItems()), ['Esporta log…']);
  openMenuItems()['Esporta log…'].onclick();
  await tick();
  assert.equal(exported.length, 1);
  assert.equal(lastToast().firstChild.textContent, 'Log esportato');
  assert.equal(action(lastToast()).textContent, 'Mostra nella cartella');
  assert.ok(!button.classList.contains('open'));
});

test('annullare la finestra di salvataggio non mostra nessun toast', async () => {
  const toasts = document.querySelector('#toasts').children.length;
  exportReply = null;
  moreMenu(new El());
  openMenuItems()['Esporta log…'].onclick();
  await tick();
  exportReply = '/home/u/Work-log.txt';
  assert.equal(document.querySelector('#toasts').children.length, toasts);
  closeMenu();
});

test('il toast di uno stallo dice quanto è durato e offre "Esporta log"', async () => {
  stalledToast(6200);
  assert.equal(lastToast().firstChild.textContent, 'Work è rimasto bloccato per 6 s');
  assert.equal(action(lastToast()).textContent, 'Esporta log');
  const before = exported.length;
  action(lastToast()).onclick();
  await tick();
  assert.equal(exported.length, before + 1);
});

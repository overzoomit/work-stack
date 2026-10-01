// App update notice: the status-bar capsule, one toast per version, the popover and manual checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { $, tick, env } from './helpers/renderer-env.mjs';

let reply = null;
let fails = null;
let calls = 0;
let onCheck = null;
globalThis.__purify = { sanitize: (html) => `<!--clean-->${html}` };
Object.assign(globalThis.window.work.app, {
  updateCheck: async () => {
    calls++;
    if (fails) throw fails;
    return reply;
  },
  onCheckUpdate: (fn) => { onCheck = fn; },
});

// Timers of 10 s or more are the schedule: capture them.
const timers = [];
const realSetTimeout = globalThis.setTimeout;
const realSetInterval = globalThis.setInterval;
globalThis.setTimeout = (fn, ms, ...a) => (ms >= 5000 ? (timers.push(['timeout', ms, fn]), 0) : realSetTimeout(fn, ms, ...a));
globalThis.setInterval = (fn, ms) => (timers.push(['interval', ms, fn]), 0);

const { initUpdate, check, notesHtml, FIRST_CHECK, EVERY } = await import('../src/renderer/update.js');
initUpdate({ version: '1.1.0' });

const newer = (version, extra = {}) => ({ version, notes: '- una cosa\n\n[note](https://x.test/n)', date: Date.UTC(2026, 9, 12), canInstall: true, ...extra });
const toasts = () => $('#toasts').children;
const capsule = () => $('#status-version');
const pops = () => document.body.children.filter((c) => c.className === 'update-pop');
const endAnimation = (el) => el.listeners.animationend?.at(-1)?.();

test('il primo controllo è 10 s dopo l\'avvio, poi ogni 6 ore', () => {
  assert.equal(FIRST_CHECK, 10_000);
  assert.equal(EVERY, 6 * 3600_000);
  assert.ok(timers.some(([kind, ms]) => kind === 'timeout' && ms === 10_000));
  assert.ok(timers.some(([kind, ms]) => kind === 'interval' && ms === 6 * 3600_000));
});

test('senza novità la barra di stato resta sulla versione e il controllo a mano lo dice', async () => {
  reply = null;
  const before = toasts().length;
  await check();
  assert.equal(capsule().textContent, 'v1.1.0');
  assert.equal(capsule().classList.contains('has-update'), false);
  assert.equal(toasts().length, before, 'silent on its own');
  await check({ manual: true });
  assert.equal(toasts().at(-1).firstChild.textContent, 'Work è aggiornato (1.1.0)');
});

test('una versione nuova: capsula blu "Aggiorna a X" e un solo toast per versione', async () => {
  reply = newer('1.2.0');
  const before = toasts().length;
  await check();
  assert.equal(capsule().textContent, 'Aggiorna a 1.2.0');
  assert.ok(capsule().classList.contains('has-update'));
  assert.equal(toasts().length, before + 1);
  assert.equal(toasts().at(-1).firstChild.textContent, 'Work 1.2.0 è disponibile');
  assert.equal(toasts().at(-1).children.find((c) => c.className === 'toast-action').textContent, 'Dettagli');

  await check();
  await check();
  assert.equal(toasts().length, before + 1, 'the same version does not notify again');
  reply = newer('1.3.0');
  await check();
  assert.equal(toasts().length, before + 2, 'a newer one does');
  reply = null;
  await check();
  assert.equal(capsule().textContent, 'v1.1.0', 'back to the plain version when the newer one is gone');
});

test('"Dettagli" e la capsula aprono il popover con versione, data e note; Più tardi lo chiude', async () => {
  reply = newer('1.4.0');
  await check();
  toasts().at(-1).children.find((c) => c.className === 'toast-action').onclick();
  const [pop] = pops();
  assert.ok(pop, 'the popover opened');
  assert.match(pop.innerHTML, /Work 1\.4\.0/);
  assert.match(pop.innerHTML, /Pubblicata il 12 ottobre 2026 · hai la 1\.1\.0/);
  assert.match(pop.innerHTML, /<!--clean-->/, 'the notes go through the sanitizer');
  assert.match(pop.innerHTML, /<li>una cosa<\/li>/);
  assert.match(pop.style.transformOrigin, /100%/, 'it grows out of the capsule');

  pop.querySelector('[data-up="later"]').onclick();
  endAnimation(pop);
  assert.equal(pops().length, 0);
  assert.ok(capsule().classList.contains('has-update'), 'the capsule stays');

  capsule().onclick();
  assert.equal(pops().length, 1, 'the capsule opens it again');
  env.key('Escape');
  endAnimation(pops()[0]);
  assert.equal(pops().length, 0, 'Escape closes it');
  reply = null;
  await check();
});

test('un link nelle note si apre nel browser, mai nella pagina di Work', async () => {
  reply = newer('1.5.0');
  await check({ manual: true });
  const notes = pops()[0].querySelector('.update-notes');
  let prevented = false;
  notes.onclick({ preventDefault() { prevented = true; }, target: { closest: () => ({ getAttribute: () => 'https://x.test/n' }) } });
  assert.ok(prevented);
  assert.equal(env.opened.at(-1), 'https://x.test/n');
  notes.onclick({ preventDefault() {}, target: { closest: () => ({ getAttribute: () => 'javascript:alert(1)' }) } });
  assert.equal(env.opened.at(-1), 'https://x.test/n', 'only web links');
  pops()[0].querySelector('[data-up="later"]').onclick();
  endAnimation(pops()[0]);
});

test('"Scarica" apre la pagina della release', async () => {
  reply = newer('1.6.0', { canInstall: false });
  await check({ manual: true });
  pops()[0].querySelector('[data-up="download"]').onclick();
  endAnimation(pops()[0]);
  assert.equal(env.opened.at(-1), 'https://github.com/overzoomit/work-stack/releases/tag/v1.6.0');
});

test('un errore di rete non disturba: niente toast, solo il log; a mano invece lo dice', async () => {
  reply = null;
  fails = new Error('offline');
  const before = toasts().length;
  await check();
  assert.equal(toasts().length, before);
  await check({ manual: true });
  assert.match(toasts().at(-1).firstChild.textContent, /Impossibile controllare gli aggiornamenti: offline/);
  fails = null;
});

test('il comando di menu "Controlla aggiornamenti…" fa un controllo a mano', async () => {
  reply = null;
  const before = calls;
  onCheck();
  await tick();
  assert.equal(calls, before + 1);
  assert.equal(toasts().at(-1).firstChild.textContent, 'Work è aggiornato (1.1.0)');
});

test('notesHtml: note vuote hanno un testo, il markdown passa dal sanificatore', () => {
  assert.match(notesHtml(''), /Nessuna nota/);
  assert.match(notesHtml(undefined), /Nessuna nota/);
  assert.match(notesHtml('**ciao**'), /<!--clean--><p><strong>ciao<\/strong><\/p>/);
});

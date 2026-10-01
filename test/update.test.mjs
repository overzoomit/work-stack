// App update notice: the status-bar capsule, one toast per version, the popover and manual checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { $, tick, env, answer } from './helpers/renderer-env.mjs';

let reply = null;
let fails = null;
let calls = 0;
let onCheck = null;
let onProgress = null;
let installs = 0;
let installGate = null; // a promise the test resolves or rejects, to hold the install mid-way
let restarts = 0;
let restartFails = null;
globalThis.__purify = { sanitize: (html) => `<!--clean-->${html}` };
Object.assign(globalThis.window.work.app, {
  updateCheck: async () => {
    calls++;
    if (fails) throw fails;
    return reply;
  },
  onCheckUpdate: (fn) => { onCheck = fn; },
  onUpdateProgress: (fn) => { onProgress = fn; },
  updateInstall: async () => {
    installs++;
    await installGate;
  },
  updateRestart: async () => {
    restarts++;
    if (restartFails) throw restartFails;
  },
});

// Timers of 10 s or more are the schedule: capture them.
const timers = [];
const realSetTimeout = globalThis.setTimeout;
const realSetInterval = globalThis.setInterval;
globalThis.setTimeout = (fn, ms, ...a) => (ms >= 5000 ? (timers.push(['timeout', ms, fn]), 0) : realSetTimeout(fn, ms, ...a));
globalThis.setInterval = (fn, ms) => (timers.push(['interval', ms, fn]), 0);

const { initUpdate, check, notesHtml, closingText, FIRST_CHECK, EVERY } = await import('../src/renderer/update.js');
let live = {};
let guarded = true; // false: the page's unsaved-edits question was not answered "go on"
initUpdate({
  version: '1.1.0',
  liveWork: () => live,
  guard: (then) => guarded && then(),
});

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

const btns = () => pops()[0].querySelector('.update-btns').innerHTML;
const closePop = () => {
  pops()[0]?.querySelector('[data-up="later"]').onclick();
  endAnimation(pops()[0]);
};
const manualCheck = async (info) => {
  reply = info;
  await check({ manual: true });
};

test('closingText: nomina cosa si chiude, con i singolari', () => {
  assert.equal(closingText({}), '');
  assert.equal(closingText({ terminals: 2, agents: 1 }), '2 terminali e 1 agente verranno chiusi');
  assert.equal(closingText({ terminals: 1 }), '1 terminale verrà chiuso');
  assert.equal(closingText({ agents: 3, runs: 1 }), '3 agenti e 1 processo verranno chiusi');
  assert.equal(closingText({ terminals: 2, agents: 2, runs: 2 }), '2 terminali, 2 agenti e 2 processi verranno chiusi');
});

test('con canInstall il popover offre Installa e Più tardi, non Scarica; senza clic non si installa niente', async () => {
  installs = 0;
  await manualCheck(newer('2.0.0'));
  assert.match(btns(), /data-up="install">Installa</);
  assert.match(btns(), /data-up="later"/);
  assert.doesNotMatch(btns(), /data-up="download"/);
  await check();
  await tick();
  assert.equal(installs, 0, 'never on its own');
  closePop();
  await manualCheck(newer('2.0.0', { canInstall: false }));
  assert.match(btns(), /data-up="download">Scarica</);
  assert.doesNotMatch(btns(), /data-up="install"/);
  closePop();
  reply = null;
  await check();
});

test('Installa: barra che scorre con i MB, poi "Riavvia ora" e "Al prossimo avvio"; la capsula chiede di riavviare', async () => {
  installs = 0;
  let finish;
  installGate = new Promise((resolve) => { finish = resolve; });
  await manualCheck(newer('2.1.0'));
  const pop = pops()[0];
  pop.querySelector('[data-up="install"]').onclick();
  assert.equal(installs, 1);
  assert.equal(pop.querySelector('.update-progress').hidden, false);
  assert.equal(btns(), '', 'no buttons while it downloads');

  const widths = [];
  pop.querySelector('.update-bar i').style.setProperty = (k, v) => widths.push([k, v]);
  onProgress(6_500_000, 13_000_000);
  assert.equal(pop.querySelector('.update-mb').textContent, '6,5 di 13,0 MB');
  onProgress(13_000_000, 13_000_000);
  assert.equal(pop.querySelector('.update-mb').textContent, '13,0 di 13,0 MB');
  assert.deepEqual(widths, [['--v', '0.500'], ['--v', '1.000']], 'the bar follows the bytes');

  finish();
  await tick();
  assert.match(btns(), /data-up="restart">Riavvia ora</);
  assert.match(btns(), /data-up="later">Al prossimo avvio</);
  assert.equal(capsule().textContent, 'Riavvia per aggiornare');

  const calls0 = calls;
  await check();
  await check({ manual: true });
  assert.equal(calls, calls0, 'once installed, it does not look again');

  pop.querySelector('[data-up="later"]').onclick();
  endAnimation(pop);
  assert.equal(capsule().textContent, 'Riavvia per aggiornare', 'the capsule keeps asking');
  capsule().onclick();
  assert.match(btns(), /Riavvia ora/, 'reopening finds the same state');
  closePop();
  installGate = null;
});

test('se l\'installazione fallisce il popover dice perché e offre di riprovare', async () => {
  // A fresh module state is needed after a successful install: this test runs on its own copy.
  const url = new URL('../src/renderer/update.js?fresh', import.meta.url);
  const fresh = await import(url);
  let rejectIt;
  installGate = new Promise((_, reject) => { rejectIt = reject; });
  fresh.initUpdate({ version: '1.1.0', liveWork: () => live, guard: (then) => then() });
  reply = newer('2.2.0');
  await fresh.check({ manual: true });
  pops().at(-1).querySelector('[data-up="install"]').onclick();
  rejectIt(new Error('Aggiornamento non installato: firma non valida'));
  await tick();
  assert.equal(pops().at(-1).querySelector('.update-error').textContent, 'Aggiornamento non installato: firma non valida');
  assert.match(pops().at(-1).querySelector('.update-btns').innerHTML, /data-up="install">Riprova</);
  assert.match(toasts().at(-1).firstChild.textContent, /firma non valida/);
  assert.equal($('#status-version').textContent, 'Aggiorna a 2.2.0', 'not installed: the capsule still offers it');
  installGate = null;
});

test('Riavvia ora senza niente di vivo riavvia subito; la domanda sulle modifiche non salvate viene prima', async () => {
  live = {};
  restarts = 0;
  const fresh = await import(new URL('../src/renderer/update.js?restart', import.meta.url));
  fresh.initUpdate({ version: '1.1.0', liveWork: () => live, guard: (then) => guarded && then() });
  installGate = null;
  reply = newer('3.0.0');
  await fresh.check({ manual: true });
  pops().at(-1).querySelector('[data-up="install"]').onclick();
  await tick();

  guarded = false; // unsaved edits: the page shows its bar and has not said "go on"
  pops().at(-1).querySelector('[data-up="restart"]').onclick();
  await tick();
  assert.equal(restarts, 0, 'not before the edits are settled');
  guarded = true;
  pops().at(-1).querySelector('[data-up="restart"]').onclick();
  await tick();
  assert.equal(restarts, 1);

  restartFails = new Error('Ci sono modifiche non salvate: salvale o scartale, poi riavvia.');
  pops().at(-1).querySelector('[data-up="restart"]').onclick();
  await tick();
  assert.match(toasts().at(-1).firstChild.textContent, /modifiche non salvate/);
  restartFails = null;
});

test('Riavvia ora con terminali o agenti vivi li nomina e chiede conferma; senza il sì non riavvia', async () => {
  live = { terminals: 2, agents: 1 };
  restarts = 0;
  const pop = pops().at(-1);
  pop.querySelector('[data-up="restart"]').onclick();
  await tick(0);
  assert.equal($('#modal-text').textContent, 'Riavviando Work, 2 terminali e 1 agente verranno chiusi. Riavviare ora?');
  $('#modal-cancel').onclick();
  await tick();
  assert.equal(restarts, 0);

  pop.querySelector('[data-up="restart"]').onclick();
  await answer('');
  await tick();
  assert.equal(restarts, 1);
  live = {};
});

// Command palette: fuzzy ranking, quick-command syntax, keyboard navigation
// and the actions behind the selected row.
import './helpers/renderer-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fuzzyScore, rank, highlight, parseCommand,
  initPalette, openPalette, closePalette, paletteOpen,
} from '../src/renderer/palette.js';

const project = { path: '/proj', name: 'proj', root: '/proj' };
const wait = () => new Promise((r) => setTimeout(r, 0));
const lastPalette = () => document.body.children.filter((c) => c.className === 'palette').at(-1);

function setup(extra = {}) {
  const calls = [];
  initPalette({
    files: async () => ['src/app.js', 'README.md', 'docs/guide.md'],
    branches: async () => [{ name: 'main', current: true }, { name: 'feature/palette' }],
    windows: async () => [{ name: 'dev1', detail: 'agent window', kind: 'agent' }],
    tickets: async () => [{ issue: 52, name: 'Palette', state: 'In Progress', id: 'uuid-52' }],
    openFile: (_p, path) => calls.push(['file', path]),
    checkout: (_p, branch) => calls.push(['checkout', branch]),
    gitAction: (_p, name) => calls.push(['git', name]),
    focusWindow: (_p, w) => calls.push(['window', w.name]),
    newTerminal: () => calls.push(['terminal']),
    launchAgent: (_p, prompt, id) => calls.push(['agent', prompt, id]),
    split: () => calls.push(['split']),
    ngrok: () => calls.push(['ngrok']),
    openTicket: (_p, t) => calls.push(['ticket', t.issue]),
    ...extra,
  });
  return calls;
}

async function open() {
  openPalette(project);
  await wait();
  const el = lastPalette();
  return {
    el,
    input: el.querySelector('.palette-input'),
    list: el.querySelector('.palette-list'),
    foot: el.querySelector('.palette-foot'),
  };
}

const key = (el, k) => el.onkeydown({ key: k, preventDefault() {}, stopPropagation() {} });

test('la ricerca fuzzy premia i prefissi e scarta le lettere fuori ordine', () => {
  assert.ok(fuzzyScore('ap', 'app.js').score > fuzzyScore('ap', 'src/map_reduce.js').score);
  assert.equal(fuzzyScore('zzz', 'app.js'), null);
  assert.deepEqual(fuzzyScore('ap', 'app.js').positions, [0, 1]);
  assert.equal(rank('ma', [{ label: 'maintenance' }, { label: 'main' }])[0].label, 'main');
  assert.equal(rank('ma', [{ label: 'maintenance' }, { label: 'main' }]).length, 2);
  assert.equal(rank('q', [{ label: 'app.js' }]).length, 0);
});

test('evidenzia le lettere trovate senza iniettare HTML', () => {
  assert.equal(highlight('main', [0, 1]), '<b>m</b><b>a</b>in');
  assert.equal(highlight('<a>', [1]), '&lt;<b>a</b>&gt;');
});

test('la sintassi @agent e i comandi /split e /ngrok viene riconosciuta', () => {
  assert.deepEqual(parseCommand('/split'), { type: 'split', text: '/split' });
  assert.equal(parseCommand('/ngrok').type, 'ngrok');
  const agent = parseCommand('@claude fix the palette');
  assert.equal(agent.type, 'agent');
  assert.equal(agent.agent.id, 'claude');
  assert.equal(agent.prompt, 'fix the palette');
  assert.equal(parseCommand('@agente fix it').type, 'agent', 'the Italian alias works too');
  assert.equal(parseCommand('@agente fix it').agent, null, 'the alias uses the default agent');
  assert.equal(parseCommand('plain text'), null);
});

test('si mostrano al massimo 80 risultati', () => {
  const entries = Array.from({ length: 200 }, (_, i) => ({ label: `file${i}` }));
  assert.equal(rank('file', entries).length, 80);
});

test("l'apertura crea la palette, dà il focus all'input e mostra le categorie", async () => {
  setup();
  const { input, list } = await open();
  assert.equal(paletteOpen(), true);
  assert.equal(input.focused, true);
  assert.match(list.innerHTML, /palette-cat command/);
  assert.match(list.innerHTML, /Files/);
  assert.match(list.innerHTML, /Git/);
  assert.match(list.innerHTML, /Agents/);
  assert.match(list.innerHTML, /Tickets/);
  closePalette();
  assert.equal(paletteOpen(), false);
});

test('ArrowDown/ArrowUp spostano la selezione, Enter esegue e chiude', async () => {
  const calls = setup();
  const { el, input, list } = await open();
  input.value = '';
  input.oninput();
  assert.match(list.innerHTML, /class="palette-row sel"[^>]*id="palette-row-0"/);
  key(el, 'ArrowDown');
  assert.match(list.innerHTML, /class="palette-row sel"[^>]*id="palette-row-1"/);
  key(el, 'ArrowUp');
  assert.match(list.innerHTML, /class="palette-row sel"[^>]*id="palette-row-0"/);

  input.value = 'README.md';
  input.oninput();
  key(el, 'Enter');
  await wait();
  assert.equal(paletteOpen(), false);
  assert.deepEqual(calls, [['file', 'README.md']]);
});

test('Escape chiude la palette senza eseguire azioni', async () => {
  const calls = setup();
  const { el, input } = await open();
  input.value = 'README.md';
  input.oninput();
  key(el, 'Escape');
  await wait();
  assert.equal(paletteOpen(), false);
  assert.deepEqual(calls, []);
});

test('@claude <prompt> avvia l’agente con il prompt', async () => {
  const calls = setup();
  const { el, input, list } = await open();
  input.value = '@claude fix the palette';
  input.oninput();
  assert.match(list.innerHTML, /Start Claude Code: fix the palette/);
  key(el, 'Enter');
  await wait();
  assert.deepEqual(calls, [['agent', 'fix the palette', 'claude']]);
});

test('/split e /ngrok eseguono i comandi rapidi', async () => {
  const calls = setup();
  let { el, input } = await open();
  input.value = '/split';
  input.oninput();
  key(el, 'Enter');
  await wait();
  assert.deepEqual(calls.at(-1), ['split']);

  ({ el, input } = await open());
  input.value = '/ngrok';
  input.oninput();
  key(el, 'Enter');
  await wait();
  assert.deepEqual(calls.at(-1), ['ngrok']);
});

test('un branch Git e una finestra agente sono azioni selezionabili', async () => {
  const calls = setup();
  let { el, input } = await open();
  input.value = 'feature/palette';
  input.oninput();
  key(el, 'Enter');
  await wait();
  assert.deepEqual(calls.at(-1), ['checkout', 'feature/palette']);

  ({ el, input } = await open());
  input.value = 'dev1';
  input.oninput();
  key(el, 'Enter');
  await wait();
  assert.deepEqual(calls.at(-1), ['window', 'dev1']);
});

test('un ticket Plane si apre dalla palette', async () => {
  const calls = setup();
  const { el, input } = await open();
  input.value = '#52';
  input.oninput();
  key(el, 'Enter');
  await wait();
  assert.deepEqual(calls.at(-1), ['ticket', 52]);
});

test('le risposte di una palette chiusa non sovrascrivono quella nuova (regressione)', async () => {
  closePalette();
  const calls = [];
  const pending = [];
  setup({
    files: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    openFile: (project, path) => calls.push(['file', project.path, path]),
  });
  const a = { path: '/A', name: 'A', root: '/A' };
  const b = { path: '/B', name: 'B', root: '/B' };

  openPalette(a);
  await wait();
  assert.equal(pending.length, 1, 'A asks for its files');
  closePalette();

  openPalette(b);
  await wait();
  assert.equal(pending.length, 2, 'B asks for its own files');
  pending[1].resolve(['B-only.txt']);
  await wait();
  pending[0].resolve(['A-only.txt']); // the closed palette answers last
  await wait();

  const el = lastPalette();
  const input = el.querySelector('.palette-input');
  const list = el.querySelector('.palette-list');
  input.value = 'A-only';
  input.oninput();
  assert.doesNotMatch(list.innerHTML, /A-only\.txt/, 'a closed open cannot add files to B');
  input.value = 'B-only';
  input.oninput();
  assert.match(list.innerHTML, /<b>B<\/b>/, 'B keeps its own files');
  key(el, 'Enter');
  await wait();
  assert.deepEqual(calls, [['file', '/B', 'B-only.txt']], 'the action belongs to the palette that is open');
  assert.equal(paletteOpen(), false);
});

test('gli errori di una palette chiusa non finiscono nella nuova apertura (regressione)', async () => {
  closePalette();
  const pending = [];
  setup({
    files: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
  });
  const a = { path: '/A', name: 'A', root: '/A' };
  const b = { path: '/B', name: 'B', root: '/B' };

  openPalette(a);
  await wait();
  closePalette();
  openPalette(b);
  await wait();
  pending[1].resolve(['B-only.txt']);
  await wait();
  pending[0].reject(new Error('A failed after close'));
  await wait();

  const foot = lastPalette().querySelector('.palette-foot');
  assert.doesNotMatch(foot.innerHTML, /unavailable/, 'the old error is dropped');
  assert.doesNotMatch(foot.innerHTML, /loading/);
  closePalette();
});

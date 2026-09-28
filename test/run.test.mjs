// Run configurations (WebStorm's Run): background processes with their own
// console, URL chip, stop with Ctrl+C, failure toast, rerun.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env, $, tick, openMenuItems, answer } from './helpers/renderer-env.mjs';

const T = await import('../src/renderer/terminals.js');
const R = await import('../src/renderer/run.js');
T.initTerminals({ homeDir: '/home/u', changed() {} });
const revealed = [];
const saves = [];
R.initRun({ save: () => saves.push(1), changed() {}, reveal: () => revealed.push(1) });

env.detected = [
  { id: 'npm:dev', name: 'dev', command: 'npm run dev', group: 'npm' },
  { id: 'npm:build', name: 'build', command: 'npm run build', group: 'npm' },
];
const project = { path: '/p', name: 'p', focusedId: null, maximizedId: null };
T.showProject(project);
await R.showRun(project);

async function start() {
  const before = env.created.length;
  $('#run-start').onclick();
  await tick();
  assert.equal(env.created.length, before + 1, 'a process started');
  return env.lastId;
}
const lastToast = () => $('#toasts').children.at(-1);

test('la console di un processo appena avviato è visibile nel tab Run, anche senza URL (regressione)', async () => {
  await start(); // npm run dev, which prints nothing yet
  const box = $('#run-output').children.at(-1);
  assert.equal(box.hidden, false, 'its console is the one shown');
  assert.equal($('#run-tab-stop').disabled, false, 'and it can be stopped from the Run tab');
  assert.match($('#run-list').innerHTML, /run-chip active/);
  R.forgetProject(project);
  await R.showRun(project);
  await tick(700);
});

test('▶ avvia la configurazione in background: nessun terminale nella griglia, console nel tab Run', async () => {
  assert.equal($('#run-name').textContent, 'dev', 'the first detected configuration is selected');
  const id = await start();
  assert.equal(env.created.at(-1).command, 'npm run dev');
  assert.equal(T.terminalsOf(project).length, 0, 'the terminal grid stays as it was');
  assert.equal($('#run-output').children.length, 1, 'its console lives in the Run tab');
  assert.equal($('#run').dataset.state, 'running');
  assert.equal($('#run-stop').disabled, false);
  assert.equal(R.runningCount(project), 1);

  // The dev server prints its address: the capsule shows a chip that opens it.
  env.output(id, '  VITE ready\r\n  ➜  Local:   http://localhost:5173/\r\n');
  await tick();
  assert.equal($('#run-url').hidden, false);
  assert.match($('#run-url').innerHTML, /^localhost:5173<span>↗<\/span>$/);
  $('#run-url').onclick();
  assert.equal(env.opened.length, 1);
  assert.match(env.opened[0], /^http:\/\/localhost:5173\/?$/);

  // ■ stops it with Ctrl+C; stopping on purpose is not a failure.
  const toasts = $('#toasts').children.length;
  $('#run-stop').onclick();
  assert.deepEqual(env.input.at(-1), [id, '\x03']);
  assert.equal($('#run').dataset.state, 'blocked', 'stopping');
  env.exit(id, 130);
  await tick();
  assert.equal($('#run').dataset.state, 'idle');
  assert.equal($('#toasts').children.length, toasts, 'no failure toast');
  assert.equal($('#run-url').hidden, true);
});

test('un processo che termina con errore mostra un avviso con "Mostra output"', async () => {
  const id = await start();
  env.exit(id, 1);
  await tick();
  assert.equal($('#run').dataset.state, 'failed');
  const t = lastToast();
  assert.equal(t.firstChild.textContent, 'dev terminato con codice 1');
  const show = t.children.find((c) => c.className === 'toast-action');
  assert.equal(show.textContent, 'Mostra output');
  show.onclick();
  assert.equal(revealed.length, 1, 'the Run tab opens');
});

test('↻ mentre gira: ferma, poi riparte con una console nuova al posto della vecchia', async () => {
  const id = await start();
  assert.match($('#run-start').innerHTML, /i-rerun/, 'the play button became rerun');
  $('#run-start').onclick();
  assert.deepEqual(env.input.at(-1), [id, '\x03']);
  env.exit(id, 130);
  await tick(20);
  assert.notEqual(env.lastId, id, 'a new process started');
  assert.equal(env.created.at(-1).command, 'npm run dev');
  assert.equal($('#run-output').children.length, 1, 'the old console was replaced');
  assert.equal($('#run').dataset.state, 'running');

  // Closing the project stops what runs in it.
  R.forgetProject(project);
  assert.ok(env.killed.includes(env.lastId));
  assert.equal($('#run-output').children.length, 0);
  await tick(700);
});

test('il menu delle configurazioni cambia quella scelta e aggiunge comandi personalizzati', async () => {
  await R.showRun(project); // the previous test closed the project
  saves.length = 0;
  $('#run-config').onpointerdown({ button: 0 });
  let items = openMenuItems();
  assert.ok(items.dev && items.build && items['Aggiungi comando…'] && items['Rileva di nuovo']);
  items.build.onclick();
  assert.equal($('#run-name').textContent, 'build');
  assert.equal(project.run.selected, 'npm:build');

  $('#run-config').onpointerdown({ button: 0 });
  openMenuItems()['Aggiungi comando…'].onclick();
  await answer('npm run dev -- --port 4000');
  await answer('dev 4000');
  await tick();
  assert.equal($('#run-name').textContent, 'dev 4000', 'the new command is selected');
  assert.deepEqual(project.run.custom.map((c) => c.command), ['npm run dev -- --port 4000']);
  assert.ok(saves.length >= 2, 'saved with the project');

  // A custom command can be removed from the same menu.
  $('#run-config').onpointerdown({ button: 0 });
  items = openMenuItems();
  items['Rimuovi “dev 4000”'].onclick();
  assert.deepEqual(project.run.custom, []);
  assert.equal($('#run-name').textContent, 'dev', 'back to the first detected one');
});

test('scorciatoie di WebStorm: Shift+F10 avvia, Ctrl+F2 ferma; il tab Run ha gli stessi comandi', async () => {
  project.run.selected = 'npm:dev';
  env.key('F10', { shiftKey: true });
  await tick();
  const id = env.lastId;
  assert.equal(env.created.at(-1).command, 'npm run dev');
  R.renderRunTab();
  assert.match($('#run-list').innerHTML, /run-chip active[^>]*><span class="dot running"><\/span>dev/);
  assert.equal($('#run-tab-stop').disabled, false);
  env.key('F2', { ctrlKey: true });
  assert.deepEqual(env.input.at(-1), [id, '\x03']);
  env.exit(id, 130);
  await tick();
  // From the Run tab: rerun starts it again, stop stops it.
  $('#run-tab-rerun').onclick();
  await tick();
  assert.notEqual(env.lastId, id);
  $('#run-tab-stop').onclick();
  assert.deepEqual(env.input.at(-1), [env.lastId, '\x03']);
  env.exit(env.lastId, 0);
  await tick();
  assert.equal($('#run-tab-stop').disabled, true);
});

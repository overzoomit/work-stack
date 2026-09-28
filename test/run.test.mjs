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

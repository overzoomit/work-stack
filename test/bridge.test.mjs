// bridge.js times every command: slow and failed ones reach the log (debug_log).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/renderer/bridge.js', import.meta.url), 'utf8');

function load(answer) {
  const logged = [];
  let now = 0;
  const window = { addEventListener() {} };
  const ctx = {
    window,
    document: { visibilityState: 'visible', addEventListener() {} },
    performance: { now: () => now },
    setInterval() {},
    console,
    String,
  };
  window.__TAURI__ = {
    core: {
      Channel: class {},
      invoke: async (cmd, args) => {
        if (cmd === 'debug_log') { logged.push(`${args.level} ${args.msg}`); return; }
        return answer(cmd, (ms) => { now += ms; });
      },
    },
    event: { listen: async () => () => {} },
  };
  vm.runInNewContext(source, ctx);
  return { work: window.work, logged };
}

test('a command slower than 2 s is logged with its name and duration', async () => {
  const { work, logged } = load((cmd, wait) => { wait(cmd === 'git_root' ? 2500 : 100); return '/repo'; });
  assert.equal(await work.git.root('/repo'), '/repo');
  await work.git.log('/repo');
  assert.deepEqual(logged, ['warn lento: git_root 2500 ms']);
});

test('the folder picker waits for the user and is never slow', async () => {
  const { work, logged } = load((_cmd, wait) => { wait(60000); return null; });
  await work.app.pickFolder();
  assert.deepEqual(logged, []);
});

test('a failed command is logged and still rejects', async () => {
  const { work, logged } = load(() => { throw new Error('non è un repository'); });
  await assert.rejects(work.git.status('/x'), /non è un repository/);
  assert.deepEqual(logged, ['warn git_status fallito: non è un repository']);
});

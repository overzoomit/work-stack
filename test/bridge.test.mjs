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

test('work.tmux exposes tmux IPC commands', async () => {
  const calls = [];
  const { work } = load((cmd) => {
    calls.push(cmd);
    if (cmd === 'tmux_is_available') return true;
    if (cmd === 'tmux_session_for_project') return 'work_test_123456';
    if (cmd === 'tmux_list_windows') return [{ id: '@0', name: 'shell', active: true, path: '/tmp' }];
    return null;
  });
  assert.equal(await work.tmux.isAvailable(), true);
  assert.equal(await work.tmux.sessionForProject('/tmp'), 'work_test_123456');
  const windows = await work.tmux.listWindows('work_test_123456');
  assert.equal(windows.length, 1);
  assert.equal(windows[0].name, 'shell');
  assert.deepEqual(calls, ['tmux_is_available', 'tmux_session_for_project', 'tmux_list_windows']);
});

test('work.dogwatch inspects a session and relays the PM answer with named arguments', async () => {
  const calls = [];
  const { work } = load((cmd, ...rest) => {
    calls.push(cmd);
    return cmd === 'dogwatch_inspect' ? { session: 's', windows: [] } : null;
  });
  assert.deepEqual(await work.dogwatch.inspect('s'), { session: 's', windows: [] });
  await work.dogwatch.answer('s', 'dev1', 'yes');
  assert.deepEqual(calls, ['dogwatch_inspect', 'dogwatch_answer']);
  assert.equal(typeof work.dogwatch.onUpdate, 'function');
});

test('work.mcp asks for the status and launches a browser by id', async () => {
  const seen = [];
  const { work } = load((cmd) => {
    seen.push(cmd);
    return cmd === 'mcp_status' ? { servers: [], browsers: [], env: [] } : 'Started chrome';
  });
  assert.deepEqual(await work.mcp.status(), { servers: [], browsers: [], env: [] });
  assert.equal(await work.mcp.launchBrowser('chrome'), 'Started chrome');
  assert.deepEqual(seen, ['mcp_status', 'mcp_launch_browser']);
});

test('work.telegram exposes status, connect, disconnect, send and events', async () => {
  const calls = [];
  const { work } = load((cmd) => { calls.push(cmd); return null; });
  await work.telegram.connect('t', 'c', '/p', 's');
  await work.telegram.disconnect();
  await work.telegram.send('hi');
  assert.deepEqual(calls, ['telegram_connect', 'telegram_disconnect', 'telegram_send']);
  assert.equal(typeof work.telegram.status, 'function');
  assert.equal(typeof work.telegram.onStatus, 'function');
  assert.equal(typeof work.telegram.onMessage, 'function');
});

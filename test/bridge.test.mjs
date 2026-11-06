// bridge.js times every command: slow and failed ones reach the log (debug_log).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/renderer/bridge.js', import.meta.url), 'utf8');

function load(answer) {
  const logged = [];
  const listeners = {};
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
        return answer(cmd, (ms) => { now += ms; }, args);
      },
    },
    event: {
      listen: async (name, cb) => {
        listeners[name] = cb;
        return () => {};
      },
    },
  };
  vm.runInNewContext(source, ctx);
  return { work: window.work, logged, emit: (name, payload) => listeners[name]({ payload }) };
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

test('work.tmux exposes the Time Machine commands', async () => {
  const calls = [];
  const { work } = load((cmd, _wait, args) => {
    calls.push([cmd, args]);
    if (cmd === 'tmux_get_history_timeline') return [{ index: 0, timestamp: 1, text: 'out' }];
    if (cmd === 'tmux_fork_from_history') return '@9';
    return null;
  });
  const timeline = await work.tmux.getHistoryTimeline('work_s', '@1');
  assert.deepEqual(timeline, [{ index: 0, timestamp: 1, text: 'out' }]);
  assert.equal(await work.tmux.forkFromHistory('work_s', '@1', 3), '@9');
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ['tmux_get_history_timeline', { session: 'work_s', window: '@1' }],
    ['tmux_fork_from_history', { session: 'work_s', window: '@1', atIndex: 3 }],
  ]);
});

test('work.dogwatch inspects a session, explains a window and relays the PM answer', async () => {
  const calls = [];
  const { work } = load((cmd, ...rest) => {
    calls.push(cmd);
    if (cmd === 'dogwatch_inspect') return { session: 's', windows: [] };
    if (cmd === 'dogwatch_explain') return { session: 's', window: 'dev1', state: 'blocked', rule: 'claude-permission' };
    return null;
  });
  assert.deepEqual(await work.dogwatch.inspect('s'), { session: 's', windows: [] });
  assert.deepEqual(await work.dogwatch.explain('s', 'dev1'), { session: 's', window: 'dev1', state: 'blocked', rule: 'claude-permission' });
  await work.dogwatch.answer('s', 'dev1', 'yes');
  assert.deepEqual(calls, ['dogwatch_inspect', 'dogwatch_explain', 'dogwatch_answer']);
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

test('work.plugins sends the url and id under the names the Rust commands take', async () => {
  const seen = [];
  const { work } = load((cmd, _wait, args) => { seen.push([cmd, { ...args }]); return cmd.endsWith('remove') ? null : []; });
  await work.plugins.list();
  await work.plugins.checkUpdates();
  await work.plugins.install('https://github.com/o/r');
  await work.plugins.update('r');
  await work.plugins.remove('r');
  assert.deepEqual(seen, [
    ['plugins_list', {}],
    ['plugins_check_updates', {}],
    ['plugins_install', { url: 'https://github.com/o/r' }],
    ['plugins_update', { id: 'r' }],
    ['plugins_remove', { id: 'r' }],
  ]);
  assert.equal(typeof work.app.onOpenPlugins, 'function');
});

test('work.app relays app:open-settings from the macOS menu bar', async () => {
  const { work, emit } = load(() => null);
  assert.equal(typeof work.app.onOpenSettings, 'function');
  const opened = [];
  const off = work.app.onOpenSettings(() => opened.push(true));
  emit('app:open-settings', []);
  assert.deepEqual(opened, [true]);
  off();
});

test('work.ngrok sends start/stop/status with the argument names the Rust commands take', async () => {
  const seen = [];
  const { work, emit } = load((cmd, _wait, args) => { seen.push([cmd, { ...args }]); return { active: cmd === 'ngrok_start' }; });
  assert.deepEqual(await work.ngrok.start('/p', 3000, 'http', 'mia-app.ngrok-free.app'), { active: true });
  await work.ngrok.status('/p');
  await work.ngrok.stop('/p');
  assert.deepEqual(seen, [
    ['ngrok_start', { project: '/p', port: 3000, protocol: 'http', customDomain: 'mia-app.ngrok-free.app' }],
    ['ngrok_status', { project: '/p' }],
    ['ngrok_stop', { project: '/p' }],
  ]);
  const ended = [];
  work.ngrok.onUpdate((project) => ended.push(project));
  emit('ngrok:update', ['/p']);
  assert.deepEqual(ended, ['/p']);
});

test('work.planeDogwatch exposes status, syncNow and the update event', async () => {
  const seen = [];
  const { work, emit } = load((cmd) => { seen.push(cmd); return cmd === 'plane_dogwatch_status' ? { projects: [] } : null; });
  assert.deepEqual(await work.planeDogwatch.status(), { projects: [] });
  await work.planeDogwatch.syncNow();
  assert.deepEqual(seen, ['plane_dogwatch_status', 'plane_dogwatch_sync_now']);
  const reports = [];
  work.planeDogwatch.onUpdate((r) => reports.push(r));
  emit('plane_dogwatch:update', { project: '/p', assignments: [] });
  assert.equal(reports[0].project, '/p', 'one report object, not spread');
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

test('object event payloads do not break the spread listener; arrays still spread', async () => {
  const { work, emit } = load(() => null);
  const seen = [];
  work.telegram.onStatus((s) => seen.push(['status', s]));
  work.telegram.onMessage((m) => seen.push(['message', m]));
  work.agents.onUpdate((list) => seen.push(['agents', list]));

  emit('telegram:status', { connected: true, chatId: '42', lastError: null });
  emit('telegram:message', { direction: 'in', text: 'hello' });
  emit('agents:update', [['claude']]);

  assert.deepEqual(seen, [
    ['status', { connected: true, chatId: '42', lastError: null }],
    ['message', { direction: 'in', text: 'hello' }],
    ['agents', ['claude']],
  ]);
});

test('the tmux bridge forwards the remote settings to every remote-aware command', async () => {
  const seen = [];
  const remote = { host: 'vps', user: 'deploy', port: 2222, remotePath: '/srv/app' };
  const { work } = load((cmd, _wait, args) => {
    seen.push([cmd, { ...args }]);
    if (cmd === 'tmux_session_for_project') return 'work_app_123456';
    if (cmd === 'tmux_list_windows') return [];
    return cmd === 'tmux_new_window' ? '@3' : null;
  });
  await work.tmux.sessionForProject('ssh://deploy@vps:2222/srv/app', remote);
  await work.tmux.ensureSession('work_app_123456', '/srv/app', remote);
  await work.tmux.listWindows('work_app_123456', remote);
  await work.tmux.newWindow('work_app_123456', 'dev1', '/srv/app', 'echo ok', remote);
  await work.tmux.killWindow('work_app_123456', '@3', remote);
  await work.tmux.killSession('work_app_123456', remote);
  await work.tmux.sendKeys('work_app_123456', 'dev1', 'yes', remote);
  await work.tmux.capturePane('work_app_123456', 'dev1', 20, remote);

  assert.deepEqual(seen.map(([cmd]) => cmd), [
    'tmux_session_for_project', 'tmux_ensure_session', 'tmux_list_windows', 'tmux_new_window',
    'tmux_kill_window', 'tmux_kill_session', 'tmux_send_keys', 'tmux_capture_pane',
  ]);
  assert.ok(seen.every(([, args]) => args.remote === remote), 'every call carries the remote object');
});

test('work.fs.quickFiles asks the backend for the palette file index', async () => {
  const seen = [];
  const { work } = load((cmd, _wait, args) => {
    seen.push([cmd, { ...args }]);
    return ['src/app.js'];
  });
  assert.deepEqual(await work.fs.quickFiles('/proj', 5000), ['src/app.js']);
  assert.deepEqual(seen, [['project_files_quick', { root: '/proj', max: 5000 }]]);
});

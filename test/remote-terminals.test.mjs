// A remote project opens its shell over SSH even when the local machine has no
// tmux: the session lives on the server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env } from './helpers/renderer-env.mjs';

const T = await import('../src/renderer/terminals.js');
T.initTerminals({ homeDir: '/home/u', changed() {} });

const project = () => ({
  path: 'ssh://deploy@vps:2222/srv/app',
  name: 'app',
  remote: { host: 'vps', user: 'deploy', port: 2222, remotePath: '/srv/app' },
  focusedId: null,
  maximizedId: null,
});

test('un progetto remoto crea un PTY SSH con la sessione tmux del server', async () => {
  env.created.length = 0;
  env.tmuxCalls.length = 0;
  env.tmuxAvailable = false;
  env.tmuxSession = 'work_app_123456';
  const p = project();
  T.showProject(p);
  const t = await T.openTerminal(p);

  assert.equal(env.created.length, 1);
  const opts = env.created[0];
  assert.deepEqual(opts.remote, p.remote);
  assert.equal(opts.tmux_session, 'work_app_123456');
  assert.equal(opts.cwd, '/srv/app');
  assert.equal(opts.tmux_window, undefined, 'the backend creates the remote window');
  assert.equal(t.cwd, '/srv/app');
  assert.equal(t.tmuxSession, 'work_app_123456');
  assert.deepEqual(env.tmuxCalls, [], 'local tmux is never queried for a remote project');
});

test('il primo terminale remoto non aspetta un giro SSH per creare la sessione', async () => {
  env.created.length = 0;
  env.tmuxCalls.length = 0;
  const p = project();
  p.savedTerminals = null;
  const panes = await T.ensureInitialTerminal(p);
  assert.equal(panes.length, 1);
  assert.equal(env.created.length, 1);
  assert.deepEqual(env.tmuxCalls, [], 'ensureSession/listWindows are skipped before the first pane');
});

test('il ripristino delle finestre remote ripassa il progetto al bridge', async () => {
  env.created.length = 0;
  env.tmuxCalls.length = 0;
  env.tmuxAvailable = false;
  env.tmuxSession = 'work_app_123456';
  env.tmuxWindows = [
    { id: '@4', name: 'dev1', active: false, path: '/srv/app' },
  ];
  const p = project();
  const panes = await T.syncProjectTerminals(p);
  assert.equal(panes.length, 1);
  assert.equal(env.created.length, 1);
  assert.equal(env.created[0].tmux_window, '@4');
  assert.deepEqual(env.created[0].remote, p.remote);
  assert.ok(env.tmuxCalls.some(([kind]) => kind === 'ensureSession'), 'the remote session is ensured');
  assert.ok(env.tmuxCalls.some(([kind]) => kind === 'listWindows'), 'the remote windows are listed');
});

test('un progetto remoto non espone il pannello Run locale', async () => {
  const Run = await import('../src/renderer/run.js');
  Run.initRun({ save() {}, changed() {}, reveal() {} });
  const p = project();
  await Run.showRun(p);
  assert.ok(p.runs instanceof Map, 'runs è inizializzato anche senza detect locale');
  assert.equal(document.querySelector('#run').hidden, true, 'il pannello Run resta nascosto');
});

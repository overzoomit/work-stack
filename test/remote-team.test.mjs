// Squad roles on a remote project must be created as remote tmux windows and
// opened through SSH, with the remote settings carried to every bridge call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env } from './helpers/renderer-env.mjs';

const T = await import('../src/renderer/terminals.js');
T.initTerminals({ homeDir: '/home/u', changed() {} });
const Team = await import('../src/renderer/team.js');

test('initializeTeam crea i quattro ruoli sul server remoto', async () => {
  env.tmuxAvailable = false;
  env.tmuxSession = 'work_app_123456';
  env.tmuxWindows = [];
  env.createdWindows = [];
  env.created = [];
  const project = {
    path: 'ssh://deploy@vps:2222/srv/app',
    name: 'app',
    remote: { host: 'vps', user: 'deploy', port: 2222, remotePath: '/srv/app' },
    focusedId: null,
    maximizedId: null,
    savedTerminals: null,
  };
  const panes = await Team.initializeTeam(project);
  assert.equal(panes.length, 4);
  assert.deepEqual(env.createdWindows.map((w) => w.name), ['pm', 'dev1', 'dev2', 'qa']);
  assert.ok(env.createdWindows.every((w) => w.cwd === '/srv/app'), 'windows start in the remote path');
  assert.equal(env.created.length, 4);
  assert.ok(env.created.every((opts) => opts.remote?.host === 'vps'), 'each pane is an SSH pane');
  assert.ok(env.created.every((opts) => opts.cwd === '/srv/app'));
});

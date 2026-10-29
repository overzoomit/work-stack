// Tests for tmux terminal synchronization, window re-attaching, and role badges.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env, FakeTerminal, $, tick } from './helpers/renderer-env.mjs';

const T = await import('../src/renderer/terminals.js');
T.initTerminals({ homeDir: '/home/u', changed() {} });

test('roleBadgeFor returns proper labels for agent roles', () => {
  assert.deepEqual(T.roleBadgeFor('pm'), { text: 'PM', title: 'Senior PM & Architect' });
  assert.deepEqual(T.roleBadgeFor('dev1'), { text: 'DEV1', title: 'Senior Developer #1' });
  assert.deepEqual(T.roleBadgeFor('dev2'), { text: 'DEV2', title: 'Senior Developer #2' });
  assert.deepEqual(T.roleBadgeFor('qa'), { text: 'QA', title: 'QA Engineer' });
  assert.deepEqual(T.roleBadgeFor('dev3'), { text: 'DEV3', title: 'Developer' });
  assert.equal(T.roleBadgeFor('bash'), null);
  assert.equal(T.roleBadgeFor(null), null);
});

test('syncProjectTerminals re-attaches existing windows from tmux session without duplication', async () => {
  env.tmuxAvailable = true;
  env.tmuxSession = 'work_work-stack_123456';
  env.tmuxWindows = [
    { id: '@0', name: 'pm', active: true, path: '/home/u/work-stack' },
    { id: '@1', name: 'dev1', active: false, path: '/home/u/work-stack' },
    { id: '@2', name: 'qa', active: false, path: '/home/u/work-stack' },
  ];

  const p = { path: '/home/u/work-stack', focusedId: null, maximizedId: null };
  T.showProject(p);

  const reattached = await T.syncProjectTerminals(p);
  assert.equal(reattached.length, 3, 're-attaches all 3 windows');

  const panes = T.terminalsOf(p);
  assert.equal(panes.length, 3);
  assert.equal(panes[0].title, 'pm');
  assert.equal(panes[0].tmuxWindow, '@0');
  assert.equal(panes[1].title, 'dev1');
  assert.equal(panes[1].tmuxWindow, '@1');
  assert.equal(panes[2].title, 'qa');
  assert.equal(panes[2].tmuxWindow, '@2');

  // Calling sync again does not duplicate panes
  const secondSync = await T.syncProjectTerminals(p);
  assert.equal(secondSync.length, 0, 'no duplicates created on second sync');

  for (const pane of panes) {
    T.closeTerminal(pane.id);
  }
  await new Promise((r) => setTimeout(r, 700));
  env.tmuxAvailable = false;
});

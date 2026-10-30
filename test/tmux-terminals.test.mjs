// Tests for tmux terminal synchronization, window re-attaching, and role badges.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env, FakeTerminal, $, tick } from './helpers/renderer-env.mjs';

const T = await import('../src/renderer/terminals.js');
T.initTerminals({ homeDir: '/home/u', changed() {} });

test('roleBadgeFor returns proper labels for agent roles', () => {
  assert.deepEqual(T.roleBadgeFor('pm'), { text: 'PM', title: 'Senior PM & Architect', role: 'pm' });
  assert.deepEqual(T.roleBadgeFor('dev1'), { text: 'DEV1', title: 'Senior Developer #1', role: 'dev1' });
  assert.deepEqual(T.roleBadgeFor('dev2'), { text: 'DEV2', title: 'Senior Developer #2', role: 'dev2' });
  assert.deepEqual(T.roleBadgeFor('qa'), { text: 'QA', title: 'QA Engineer', role: 'qa' });
  assert.deepEqual(T.roleBadgeFor('dev3'), { text: 'DEV3', title: 'Developer #3', role: 'dev' });
  assert.deepEqual(T.roleBadgeFor('qa1'), { text: 'QA1', title: 'QA Engineer #1', role: 'qa' });
  assert.deepEqual(T.roleBadgeFor('qa2'), { text: 'QA2', title: 'QA Engineer #2', role: 'qa' });
  assert.deepEqual(T.roleBadgeFor('agent1'), { text: 'AGENT1', title: 'Generic agent #1', role: 'agent' });
  assert.deepEqual(T.roleBadgeFor('agent12'), { text: 'AGENT12', title: 'Generic agent #12', role: 'agent' });
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

test('ensureInitialTerminal re-attaches every window the tmux session kept alive', async () => {
  env.tmuxAvailable = true;
  env.tmuxSession = 'work_work-stack_123456';
  env.tmuxWindows = ['shell', 'pm', 'dev1', 'qa'].map((name, i) => ({ id: `@${i}`, name, active: i === 0, path: '/home/u/work-stack' }));
  env.createdWindows = [];

  const p = { path: '/home/u/work-stack', focusedId: null, maximizedId: null };
  T.showProject(p);

  const opened = await T.ensureInitialTerminal(p);
  assert.equal(opened.length, 4);
  const panes = T.terminalsOf(p);
  assert.deepEqual(panes.map((t) => [t.title, t.tmuxWindow]), [['shell', '@0'], ['pm', '@1'], ['dev1', '@2'], ['qa', '@3']]);
  assert.ok(panes.every((t) => t.tmuxSession === 'work_work-stack_123456'));
  assert.deepEqual(env.createdWindows, [], 'attaches the existing windows, creates none');

  assert.deepEqual(await T.ensureInitialTerminal(p), [], 'a project that already has panes is left alone');
  assert.equal(T.terminalsOf(p).length, 4);

  for (const t of panes) {
    T.closeTerminal(t.id);
  }
  await new Promise((r) => setTimeout(r, 700));
  env.tmuxAvailable = false;
});

test('ensureInitialTerminal opens one plain shell when tmux has no windows or is missing', async () => {
  for (const tmuxAvailable of [true, false]) {
    env.tmuxAvailable = tmuxAvailable;
    env.tmuxSession = 'work_empty_proj';
    env.tmuxWindows = [];
    const p = { path: '/home/u/empty-proj', focusedId: null, maximizedId: null };
    T.showProject(p);

    const opened = await T.ensureInitialTerminal(p);
    assert.equal(opened.length, 1, `tmux available: ${tmuxAvailable}`);
    assert.equal(T.terminalsOf(p).length, 1);

    T.closeTerminal(opened[0].id);
    await new Promise((r) => setTimeout(r, 700));
  }
  env.tmuxAvailable = false;
});

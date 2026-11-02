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

const closeAll = async (p) => {
  for (const t of T.terminalsOf(p)) T.closeTerminal(t.id);
  await new Promise((r) => setTimeout(r, 700));
};

test('after closing a pane, a restart reopens only the tmux windows that were still open', async () => {
  env.tmuxAvailable = true;
  env.tmuxSession = 'work_porto-genova_abcdef';
  env.tmuxWindows = ['shell', 'pm', 'dev1', 'qa'].map((name, i) => ({ id: `@${i}`, name, active: i === 0, path: '/home/u/porto-genova' }));
  env.createdWindows = [];

  const before = { path: '/home/u/porto-genova', focusedId: null, maximizedId: null, savedTerminals: null };
  T.showProject(before);
  assert.equal((await T.ensureInitialTerminal(before)).length, 4, 'no saved state yet: every window of the session');
  T.closeTerminal(T.terminalsOf(before).find((t) => t.title === 'pm').id);
  const saved = JSON.parse(JSON.stringify(T.terminalLayout(before)));
  assert.deepEqual(saved, [
    { title: 'shell', tmuxWindow: '@0', tmuxName: 'shell', cwd: '/home/u/porto-genova' },
    { title: 'dev1', tmuxWindow: '@2', tmuxName: 'dev1', cwd: '/home/u/porto-genova' },
    { title: 'qa', tmuxWindow: '@3', tmuxName: 'qa', cwd: '/home/u/porto-genova' },
  ]);
  await closeAll(before);

  // Work restarts: the closed window is still alive in tmux, but is not reopened.
  env.created = [];
  const after = { path: '/home/u/porto-genova', focusedId: null, maximizedId: null, savedTerminals: saved };
  T.showProject(after);
  const reopened = await T.ensureInitialTerminal(after);
  assert.deepEqual(reopened.map((t) => [t.title, t.tmuxWindow]), [['shell', '@0'], ['dev1', '@2'], ['qa', '@3']]);
  assert.deepEqual(env.created.map((o) => o.tmux_window), ['@0', '@2', '@3'], 'attaches the saved windows only');
  assert.deepEqual(env.createdWindows, [], 'creates no window');
  assert.deepEqual(after.savedTerminals, [], 'restored once');

  await closeAll(after);
  assert.equal((await T.ensureInitialTerminal(after)).length, 1, 'closing every pane later does not bring the windows back');
  assert.equal(env.created.at(-1).tmux_window, undefined, 'a fresh shell instead');
  await closeAll(after);
  env.tmuxAvailable = false;
});

test('restore follows the saved order and titles and skips windows gone from tmux', async () => {
  env.tmuxAvailable = true;
  env.tmuxSession = 'work_order_proj';
  env.tmuxWindows = ['shell', 'pm', 'dev1'].map((name, i) => ({ id: `@${i}`, name, active: false, path: '/home/u/order' }));
  const p = {
    path: '/home/u/order', focusedId: null, maximizedId: null,
    savedTerminals: [
      { title: 'my dev', tmuxWindow: '@2', tmuxName: 'dev1', cwd: null },
      { title: 'gone', tmuxWindow: '@9', tmuxName: 'gone', cwd: null },
      { title: 'shell', tmuxWindow: '@0', tmuxName: 'shell', cwd: null },
    ],
  };
  T.showProject(p);

  await T.ensureInitialTerminal(p);
  assert.deepEqual(T.terminalsOf(p).map((t) => [t.title, t.tmuxWindow, t.tmuxName]), [['my dev', '@2', 'dev1'], ['shell', '@0', 'shell']]);
  await closeAll(p);
  env.tmuxAvailable = false;
});

test('an empty saved list, or saved windows all gone, open one fresh shell', async () => {
  env.tmuxAvailable = true;
  env.tmuxSession = 'work_fresh_proj';
  for (const savedTerminals of [[], [{ title: 'pm', tmuxWindow: '@1', tmuxName: 'pm', cwd: null }]]) {
    env.tmuxWindows = [{ id: '@5', name: 'dev1', active: true, path: '/home/u/fresh' }];
    env.created = [];
    const p = { path: '/home/u/fresh', focusedId: null, maximizedId: null, savedTerminals };
    T.showProject(p);

    const opened = await T.ensureInitialTerminal(p);
    assert.equal(opened.length, 1, JSON.stringify(savedTerminals));
    assert.equal(env.created[0].tmux_window, undefined, 'does not reattach the unsaved dev1 window');
    await closeAll(p);
  }
  env.tmuxAvailable = false;
});

test('a new tmux terminal saves the window it opened; an unshown project keeps its saved list', async () => {
  env.tmuxAvailable = true;
  env.tmuxSession = 'work_new_term';
  env.tmuxWindowOf = () => '@7';
  const p = { path: '/home/u/new-term', focusedId: null, maximizedId: null };
  T.showProject(p);

  const t = await T.openTerminal(p);
  assert.deepEqual(T.terminalLayout(p), [{ title: t.title, tmuxWindow: '@7', tmuxName: null, cwd: '/home/u/new-term' }]);
  await closeAll(p);
  env.tmuxWindowOf = null;
  env.tmuxAvailable = false;

  const saved = [{ title: 'pm', tmuxWindow: '@1', tmuxName: 'pm', cwd: null }];
  assert.deepEqual(T.terminalLayout({ path: '/x', savedTerminals: saved }), saved);
  assert.equal(T.terminalLayout({ path: '/y', savedTerminals: null }), null);
  assert.deepEqual(T.terminalLayout({ path: '/z', savedTerminals: [] }), []);
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

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
  // Screen order of the team layout: PM, devs, QA, then plain shells.
  assert.deepEqual(panes.map((t) => [t.title, t.tmuxWindow]), [['pm', '@1'], ['dev1', '@2'], ['qa', '@3'], ['shell', '@0']]);
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
  // Screen order of the team layout: devs, QA, then plain shells.
  assert.deepEqual(saved, [
    { title: 'dev1', tmuxWindow: '@2', tmuxName: 'dev1', cwd: '/home/u/porto-genova', role: 'dev1', agentId: 'ollama', command: 'ollama launch opencode --model deepseek-v4.1-flash:cloud' },
    { title: 'qa', tmuxWindow: '@3', tmuxName: 'qa', cwd: '/home/u/porto-genova', role: 'qa', agentId: 'codex', command: 'codex --dangerously-bypass-approvals-and-sandbox' },
    { title: 'shell', tmuxWindow: '@0', tmuxName: 'shell', cwd: '/home/u/porto-genova' },
  ]);
  await closeAll(before);

  // Work restarts: the closed window is still alive in tmux, but is not reopened.
  env.created = [];
  const after = { path: '/home/u/porto-genova', focusedId: null, maximizedId: null, savedTerminals: saved };
  T.showProject(after);
  const reopened = await T.ensureInitialTerminal(after);
  assert.deepEqual(reopened.map((t) => [t.title, t.tmuxWindow]), [['dev1', '@2'], ['qa', '@3'], ['shell', '@0']]);
  assert.deepEqual(env.created.map((o) => o.tmux_window), ['@2', '@3', '@0'], 'attaches the saved windows only');
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

test('re-attaches a saved window whose tmux id changed, following its name', async () => {
  env.tmuxAvailable = true;
  env.tmuxSession = 'work_renumbered';
  env.tmuxWindows = [{ id: '@0', name: 'pm', active: true, path: '/home/u/renumbered' }];
  env.created = [];

  const p = {
    path: '/home/u/renumbered', focusedId: null, maximizedId: null,
    savedTerminals: [{ title: 'pm', tmuxWindow: '@15', tmuxName: 'pm', cwd: null }],
  };
  T.showProject(p);

  const reattached = await T.ensureInitialTerminal(p);
  assert.equal(reattached.length, 1);
  assert.equal(reattached[0].tmuxWindow, '@0', 'follows the window by name instead of the dead id');
  assert.equal(env.created[0].tmux_window, '@0', 'attaches the current window id');
  assert.deepEqual(p.savedTerminals, [], 'restored once');
  assert.deepEqual(T.terminalLayout(p).map((s) => [s.title, s.tmuxWindow]), [['pm', '@0']]);

  await closeAll(p);
  env.tmuxAvailable = false;
});

test('syncProjectTerminals ensures the tmux session before listing its windows', async () => {
  env.tmuxAvailable = true;
  env.tmuxSession = 'work_init_order';
  env.tmuxWindows = [];
  env.tmuxCalls = [];

  const p = { path: '/home/u/init-order', focusedId: null, maximizedId: null };
  T.showProject(p);
  await T.syncProjectTerminals(p);

  assert.deepEqual(env.tmuxCalls.slice(0, 2), [
    ['ensureSession', 'work_init_order', '/home/u/init-order'],
    ['listWindows', 'work_init_order'],
  ], 'the session is created/checked before any window scan');

  env.tmuxAvailable = false;
});

test('a transient tmux failure keeps savedTerminals instead of overwriting state.json', async () => {
  env.tmuxAvailable = true;
  env.tmuxSession = 'work_transient';
  env.tmuxWindows = [{ id: '@0', name: 'pm', active: true, path: '/home/u/transient' }];
  env.tmuxListError = new Error('error connecting to /tmp/tmux-1000/default');
  env.created = [];

  const saved = [{ title: 'pm', tmuxWindow: '@7', tmuxName: 'pm', cwd: null }];
  const p = { path: '/home/u/transient', focusedId: null, maximizedId: null, savedTerminals: saved };
  T.showProject(p);

  assert.deepEqual(await T.ensureInitialTerminal(p), [], 'no fallback shell while tmux is unreachable');
  assert.deepEqual(p.savedTerminals, saved, 'the saved windows survive the failure');
  assert.deepEqual(T.terminalLayout(p), saved, 'state.json keeps the history');
  assert.equal(env.created.length, 0, 'no pty is opened');

  // The socket answers again: the next activation realigns the saved windows.
  env.tmuxListError = null;
  const reattached = await T.ensureInitialTerminal(p);
  assert.equal(reattached.length, 1);
  assert.equal(reattached[0].tmuxWindow, '@0');
  assert.deepEqual(p.savedTerminals, [], 'restored once tmux confirms the windows');

  await closeAll(p);
  env.tmuxAvailable = false;
});

test('an ensureSession failure also preserves savedTerminals', async () => {
  env.tmuxAvailable = true;
  env.tmuxSession = 'work_no_session';
  env.tmuxWindows = [{ id: '@0', name: 'qa1', active: true, path: '/home/u/no-session' }];
  env.tmuxEnsureError = new Error("can't find session: work_no_session");
  env.created = [];

  const saved = [{ title: 'qa1', tmuxWindow: '@3', tmuxName: 'qa1', cwd: null }];
  const p = { path: '/home/u/no-session', focusedId: null, maximizedId: null, savedTerminals: saved };
  T.showProject(p);

  assert.deepEqual(await T.ensureInitialTerminal(p), [], 'does not open the fallback shell');
  assert.deepEqual(p.savedTerminals, saved);
  assert.equal(T.terminalLayout(p), saved);
  assert.equal(env.created.length, 0);

  env.tmuxEnsureError = null;
  env.created = [];
  const reattached = await T.ensureInitialTerminal(p);
  assert.equal(reattached.length, 1);
  assert.equal(reattached[0].tmuxWindow, '@0');

  await closeAll(p);
  env.tmuxAvailable = false;
});

test('a reattached squad pane keeps role, agentId, command and sessionRef', async () => {
  env.tmuxAvailable = true;
  env.tmuxSession = 'work_meta_proj';
  env.tmuxWindows = [{ id: '@4', name: 'pm', active: true, path: '/home/u/meta-proj' }];
  env.created = [];
  const ref = '11111111-2222-3333-4444-555555555555';

  const p = {
    path: '/home/u/meta-proj', focusedId: null, maximizedId: null,
    savedTerminals: [{
      title: 'PM', tmuxWindow: '@15', tmuxName: 'pm', cwd: '/home/u/meta-proj',
      role: 'pm', agentId: 'claude', command: 'claude', sessionRef: ref,
    }],
  };
  T.showProject(p);

  const panes = await T.ensureInitialTerminal(p);
  assert.equal(panes.length, 1);
  assert.equal(panes[0].tmuxWindow, '@4');
  assert.equal(panes[0].role, 'pm');
  assert.equal(panes[0].agentId, 'claude');
  assert.equal(panes[0].command, 'claude');
  assert.equal(panes[0].sessionRef, ref);
  assert.deepEqual(env.created[0], {
    cwd: '/home/u/meta-proj', cols: 80, rows: 24, command: 'claude',
    tmux_session: 'work_meta_proj', tmux_window: '@4', tmux_name: 'pm',
    role: 'pm', agent_id: 'claude', session_ref: ref,
  }, 'the IPC keeps the resume metadata too');
  assert.deepEqual(T.terminalLayout(p), [{
    title: 'PM', tmuxWindow: '@4', tmuxName: 'pm', cwd: '/home/u/meta-proj',
    role: 'pm', agentId: 'claude', command: 'claude', sessionRef: ref,
  }], 'state.json saves everything needed to resume the agent');

  await closeAll(p);
  env.tmuxAvailable = false;
});

test('after the tmux server dies, saved squad roles are relaunched with their commands', async () => {
  env.tmuxAvailable = true;
  env.tmuxSession = 'work_reboot_proj';
  env.tmuxWindows = [];
  env.createdWindows = [];
  env.created = [];

  const p = {
    path: '/home/u/reboot-proj', focusedId: null, maximizedId: null,
    savedTerminals: [
      {
        title: 'pm', tmuxWindow: '@15', tmuxName: 'pm', cwd: '/home/u/reboot-proj',
        role: 'pm', agentId: 'antigravity', command: 'agy --dangerously-skip-permissions',
      },
      { title: 'dev1', tmuxWindow: '@16', tmuxName: 'dev1', cwd: '/home/u/reboot-proj', role: 'dev1' },
      {
        title: 'qa1', tmuxWindow: '@17', tmuxName: 'qa1', cwd: '/home/u/reboot-proj',
        role: 'qa1', agentId: 'codex', command: 'codex --dangerously-bypass-approvals-and-sandbox',
      },
    ],
  };
  T.showProject(p);

  const panes = await T.ensureInitialTerminal(p);
  assert.deepEqual(env.createdWindows.map((w) => [w.name, w.command]), [
    ['pm', 'agy --dangerously-skip-permissions'],
    ['dev1', 'ollama launch opencode --model deepseek-v4.1-flash:cloud'],
    ['qa1', 'codex --dangerously-bypass-approvals-and-sandbox'],
  ], 'each role is relaunched with its stored or default command');
  assert.deepEqual(panes.map((t) => [t.title, t.tmuxWindow, t.role]), [
    ['pm', '@0', 'pm'], ['dev1', '@1', 'dev1'], ['qa1', '@2', 'qa1'],
  ]);
  assert.deepEqual(p.savedTerminals, [], 'restored once');
  assert.deepEqual(T.terminalLayout(p).map((t) => [t.role, t.tmuxName]), [
    ['pm', 'pm'], ['dev1', 'dev1'], ['qa1', 'qa1'],
  ]);

  await closeAll(p);
  env.tmuxWindows = [];
  env.createdWindows = [];
  env.tmuxAvailable = false;
});

test('a saved Claude session relaunches with --resume <id>', async () => {
  env.tmuxAvailable = true;
  env.tmuxSession = 'work_claude_proj';
  env.tmuxWindows = [];
  env.createdWindows = [];
  env.created = [];
  const ref = '11111111-2222-3333-4444-555555555555';

  const p = {
    path: '/home/u/claude-proj', focusedId: null, maximizedId: null,
    savedTerminals: [{
      title: 'Claude Code', tmuxWindow: '@9', tmuxName: 'claude',
      cwd: '/home/u/claude-proj', role: 'claude', agentId: 'claude',
      command: 'claude --dangerously-skip-permissions', sessionRef: ref,
    }],
  };
  T.showProject(p);

  const panes = await T.ensureInitialTerminal(p);
  assert.equal(panes.length, 1);
  assert.deepEqual(env.createdWindows, [{
    session: 'work_claude_proj', name: 'claude', cwd: '/home/u/claude-proj',
    command: `claude --dangerously-skip-permissions --resume ${ref}`,
  }]);
  assert.equal(panes[0].sessionRef, ref);

  await closeAll(p);
  env.tmuxWindows = [];
  env.createdWindows = [];
  env.tmuxAvailable = false;
});

test('a role window that cannot be recreated keeps its resume metadata', async () => {
  env.tmuxAvailable = true;
  env.tmuxSession = 'work_resume_fail';
  env.tmuxWindows = [];
  env.createdWindows = [];
  env.created = [];
  env.tmuxNewError = new Error('tmux: cannot create window');

  const saved = [{
    title: 'pm', tmuxWindow: '@15', tmuxName: 'pm', cwd: '/home/u/resume-fail',
    role: 'pm', agentId: 'antigravity', command: 'agy --dangerously-skip-permissions',
  }];
  const p = { path: '/home/u/resume-fail', focusedId: null, maximizedId: null, savedTerminals: saved };
  T.showProject(p);

  assert.deepEqual(await T.ensureInitialTerminal(p), [], 'does not replace the agent with a shell');
  assert.deepEqual(p.savedTerminals, saved, 'the entry stays queued for the next attempt');
  assert.deepEqual(T.terminalLayout(p), saved, 'and state.json keeps it');

  env.tmuxNewError = null;
  const reattached = await T.ensureInitialTerminal(p);
  assert.equal(reattached.length, 1);
  assert.deepEqual(p.savedTerminals, []);

  await closeAll(p);
  env.tmuxWindows = [];
  env.createdWindows = [];
  env.tmuxAvailable = false;
});

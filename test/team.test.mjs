// Unit tests for the Multi-Agent Team Orchestrator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env, $, tick } from './helpers/renderer-env.mjs';

const T = await import('../src/renderer/terminals.js');
T.initTerminals({ homeDir: '/home/u', changed() {} });

const Team = await import('../src/renderer/team.js');
const Launcher = await import('../src/renderer/launcher.js');

test('TEAM_ROLES defines pm, dev1, dev2, and qa with valid properties', () => {
  const roles = Team.TEAM_ROLES;
  assert.equal(roles.length, 4);

  const ids = roles.map((r) => r.id);
  assert.deepEqual(ids, ['pm', 'dev1', 'dev2', 'qa']);

  const names = roles.map((r) => r.name);
  assert.deepEqual(names, ['pm', 'dev1', 'dev2', 'qa']);

  const pm = roles.find((r) => r.id === 'pm');
  assert.equal(pm.role, 'PM');
  assert.ok(pm.command.includes('agy'));

  const dev1 = roles.find((r) => r.id === 'dev1');
  assert.equal(dev1.role, 'DEV1');
  assert.ok(dev1.command.includes('ollama') || dev1.command.includes('opencode'));

  const dev2 = roles.find((r) => r.id === 'dev2');
  assert.equal(dev2.role, 'DEV2');
  assert.ok(dev2.command.includes('ollama') || dev2.command.includes('opencode'));

  const qa = roles.find((r) => r.id === 'qa');
  assert.equal(qa.role, 'QA');
  assert.ok(qa.command.includes('codex'));
});

test('hasPm accurately checks for PM presence (PM is unique)', () => {
  assert.equal(Team.hasPm([]), false);
  assert.equal(Team.hasPm(['dev1', 'dev2', 'qa1']), false);
  assert.equal(Team.hasPm(['pm']), true);
  assert.equal(Team.hasPm(['PM', 'dev1']), true);
  assert.equal(Team.hasPm(['dev1', 'pm', 'qa1']), true);
});

test('nextDevName increments sequentially starting from dev1', () => {
  assert.equal(Team.nextDevName([]), 'dev1');
  assert.equal(Team.nextDevName(['pm']), 'dev1');
  assert.equal(Team.nextDevName(['dev1']), 'dev2');
  assert.equal(Team.nextDevName(['pm', 'dev1']), 'dev2');
  assert.equal(Team.nextDevName(['dev1', 'dev2']), 'dev3');
  assert.equal(Team.nextDevName(['pm', 'dev1', 'dev2', 'qa1']), 'dev3');
  assert.equal(Team.nextDevName(['dev1', 'dev2', 'dev5']), 'dev6');
});

test('nextQaName increments sequentially starting from qa1 and considers legacy qa', () => {
  assert.equal(Team.nextQaName([]), 'qa1');
  assert.equal(Team.nextQaName(['pm', 'dev1']), 'qa1');
  assert.equal(Team.nextQaName(['qa']), 'qa2');
  assert.equal(Team.nextQaName(['qa1']), 'qa2');
  assert.equal(Team.nextQaName(['pm', 'qa1']), 'qa2');
  assert.equal(Team.nextQaName(['qa1', 'qa2']), 'qa3');
  assert.equal(Team.nextQaName(['qa', 'qa2']), 'qa3');
});

test('createTeamMember creates and attaches a window with the chosen agent', async () => {
  env.tmuxAvailable = true;
  env.tmuxSession = 'work_create_test';
  env.tmuxWindows = [];
  env.createdWindows = [];

  const project = { path: '/home/u/create-proj', focusedId: null, maximizedId: null };
  T.showProject(project);

  const agy = Launcher.AGENTS.find((a) => a.id === 'antigravity');
  const pane = await Team.createTeamMember(project, 'pm', agy);

  assert.ok(pane);
  assert.equal(pane.title, 'pm');
  assert.equal(env.createdWindows.length, 1);
  assert.equal(env.createdWindows[0].name, 'pm');
  assert.equal(env.createdWindows[0].cwd, '/home/u/create-proj', 'cwd is the 3rd argument');
  assert.ok(env.createdWindows[0].command.includes('agy'), 'the agent command is the 4th argument');

  // Clean up
  T.closeTerminal(pane.id);
  await tick(50);
  env.tmuxAvailable = false;
});

test('initializeTeam on tmux creates missing windows and attaches them', async () => {
  env.tmuxAvailable = true;
  env.tmuxSession = 'work_team_proj';
  env.tmuxWindows = [];
  env.createdWindows = [];

  const project = { path: '/home/u/team-proj', focusedId: null, maximizedId: null };
  T.showProject(project);

  const panes = await Team.initializeTeam(project);
  assert.equal(env.createdWindows.length, 4, 'creates 4 tmux windows for the team');
  assert.deepEqual(env.createdWindows.map((w) => w.name), ['pm', 'dev1', 'dev2', 'qa']);
  assert.deepEqual(
    env.createdWindows.map((w) => [w.cwd, w.command]),
    Team.TEAM_ROLES.map((r) => ['/home/u/team-proj', r.command]),
    'each window starts its role command in the project folder',
  );

  assert.equal(panes.length, 4);
  const titles = panes.map((p) => p.title);
  assert.deepEqual(titles, ['pm', 'dev1', 'dev2', 'qa']);

  // Clean up
  for (const pane of panes) {
    T.closeTerminal(pane.id);
  }
  await tick(50);
  env.tmuxAvailable = false;
});

test('openTeamMenu mounts the popover and closes with closeTeamMenu', async () => {
  const project = { path: '/home/u/menu-proj', focusedId: null, maximizedId: null };
  Team.initTeam({ activeProject: () => project });

  await Team.openTeamMenu();
  const pop = document.body.children.find((c) => c.className?.includes('team-pop'));
  assert.ok(pop, 'popover mounted in DOM');

  Team.closeTeamMenu();
  await tick(700);
  const popAfter = document.body.children.find((c) => c.className?.includes('team-pop'));
  assert.equal(popAfter, undefined, 'popover removed after close');
});

test('openTeamMenu allows selecting agent for PM and DEV', async () => {
  env.tmuxAvailable = true;
  env.tmuxSession = 'work_interactive_test';
  env.tmuxWindows = [];
  env.createdWindows = [];

  const project = { path: '/home/u/interactive-proj', focusedId: null, maximizedId: null };
  Team.initTeam({ activeProject: () => project });

  await Team.openTeamMenu();
  const pop = document.body.children.find((c) => c.className?.includes('team-pop'));
  assert.ok(pop);

  // Click "+ Configura PM"
  await pop.listeners.click[0]({
    target: { closest: (sel) => (sel === '[data-act]' ? { dataset: { act: 'add-pm' } } : null) },
  });

  // Verify view transitioned to agent selection
  assert.ok(pop.innerHTML.includes('Attiva <b>PM</b>'));

  // Select "claude" agent
  await pop.listeners.click[0]({
    target: { closest: (sel) => (sel === '.tp-agent-row' ? { dataset: { agentId: 'claude' } } : null) },
  });

  // Verify PM window was created with claude
  assert.equal(env.createdWindows.length, 1);
  assert.equal(env.createdWindows[0].name, 'pm');
  assert.ok(env.createdWindows[0].command.includes('claude'));

  // Clean up
  env.tmuxAvailable = false;
});

test('openOrFocusRole and killTeamRole open and kill specific role windows', async () => {
  env.tmuxAvailable = true;
  env.tmuxSession = 'work_role_test';
  env.tmuxWindows = [
    { id: '@10', name: 'pm', active: false, path: '/home/u/role-proj' },
  ];
  env.createdWindows = [];
  env.killedWindows = [];

  const project = { path: '/home/u/role-proj', focusedId: null, maximizedId: null };
  T.showProject(project);

  // openOrFocusRole should open only the requested role window
  const pane = await Team.openOrFocusRole(project, 'pm');
  assert.ok(pane);
  assert.equal(pane.title, 'pm');
  assert.equal(pane.tmuxWindow, '@10');

  const panes = T.terminalsOf(project);
  assert.equal(panes.length, 1);

  // Now kill role
  await Team.killTeamRole(project, 'pm');
  await tick(50);

  const panesAfter = T.terminalsOf(project);
  assert.equal(panesAfter.length, 0, 'pane was closed');

  env.tmuxAvailable = false;
});

test('launchTeamMember creates a missing role window with cwd before the command', async () => {
  env.tmuxAvailable = true;
  env.tmuxSession = 'work_missing_role';
  env.tmuxWindows = [];
  env.createdWindows = [];

  const project = { path: '/home/u/missing-proj', focusedId: null, maximizedId: null };
  T.showProject(project);
  const dev1 = Team.TEAM_ROLES.find((r) => r.name === 'dev1');

  const pane = await Team.launchTeamMember(project, dev1);
  assert.deepEqual(env.createdWindows, [{ session: 'work_missing_role', name: 'dev1', cwd: '/home/u/missing-proj', command: dev1.command }]);
  assert.equal(pane.tmuxWindow, '@0');

  T.closeTerminal(pane.id);
  await tick(50);
  env.tmuxAvailable = false;
});

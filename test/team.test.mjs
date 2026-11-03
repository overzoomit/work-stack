// Unit tests for the Multi-Agent Team Orchestrator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env, $, tick } from './helpers/renderer-env.mjs';

const T = await import('../src/renderer/terminals.js');
T.initTerminals({ homeDir: '/home/u', changed() {} });

const Team = await import('../src/renderer/team.js');
const Launcher = await import('../src/renderer/launcher.js');
const Roles = await import('../src/renderer/teamroles.js');

// Telegram bridge stub: only the PM control panel uses it.
const telegramState = { connected: false, bot: null, chatId: null, project: null, session: null, lastError: null };
const telegramCalls = [];
globalThis.window.work.telegram = {
  status: async () => ({ ...telegramState }),
  connect: async (token, chatId, project, session) => {
    telegramCalls.push(['connect', token, chatId, project, session]);
    Object.assign(telegramState, { connected: true, bot: 'work_pm_bot', chatId, project, session, lastError: null });
    return { ...telegramState };
  },
  disconnect: async () => {
    telegramCalls.push(['disconnect']);
    Object.assign(telegramState, { connected: false, bot: null, chatId: null, project: null, session: null, lastError: null });
    return { ...telegramState };
  },
  send: async (text) => telegramCalls.push(['send', text]),
  onStatus: () => {},
  onMessage: () => {},
};

test('TEAM_ROLES defines pm, dev1, dev2, qa and doc1 with valid properties', () => {
  const roles = Team.TEAM_ROLES;
  assert.equal(roles.length, 5);

  const ids = roles.map((r) => r.id);
  assert.deepEqual(ids, ['pm', 'dev1', 'dev2', 'qa', 'doc']);

  const names = roles.map((r) => r.name);
  assert.deepEqual(names, ['pm', 'dev1', 'dev2', 'qa', 'doc1']);

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

  const doc = roles.find((r) => r.id === 'doc');
  assert.equal(doc.role, 'DOC1');
  assert.equal(doc.title, 'Documentation Specialist #1');
  assert.equal(doc.agentId, 'claude');
  assert.ok(doc.command.includes('claude'));
  assert.deepEqual(Roles.roleFor('doc2'), doc, 'numbered doc roles use the doc default');
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

test('nextDocName increments doc members and getDocMembers sorts them', () => {
  assert.equal(Team.nextDocName([]), 'doc1');
  assert.equal(Team.nextDocName(['pm', 'dev1']), 'doc1');
  assert.equal(Team.nextDocName(['doc']), 'doc2');
  assert.equal(Team.nextDocName(['doc1']), 'doc2');
  assert.equal(Team.nextDocName(['doc1', 'doc3']), 'doc4');
  assert.deepEqual(Team.getDocMembers([]), []);
  assert.deepEqual(Team.getDocMembers(['pm', 'qa1', 'dev1']), []);
  assert.deepEqual(Team.getDocMembers(['doc2', 'pm', 'doc1']), ['doc1', 'doc2']);
  assert.deepEqual(Team.getDocMembers(['doc', 'doc3']), ['doc', 'doc3']);
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
  assert.equal(env.createdWindows.length, 5, 'creates 5 tmux windows for the team');
  assert.deepEqual(env.createdWindows.map((w) => w.name), ['pm', 'dev1', 'dev2', 'qa', 'doc1']);
  assert.deepEqual(
    env.createdWindows.map((w) => [w.cwd, w.command]),
    Team.TEAM_ROLES.map((r) => ['/home/u/team-proj', r.command]),
    'each window starts its role command in the project folder',
  );

  assert.equal(panes.length, 5);
  const titles = panes.map((p) => p.title);
  assert.deepEqual(titles, ['pm', 'dev1', 'dev2', 'qa', 'doc1']);

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
  const pop = document.body.children.filter((c) => c.className?.includes('team-pop')).at(-1);
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
  const pop = document.body.children.filter((c) => c.className?.includes('team-pop')).at(-1);
  assert.ok(pop);

  // Click "+ Add PM"
  await pop.listeners.click[0]({
    target: { closest: (sel) => (sel === '[data-act]' ? { dataset: { act: 'add-pm' } } : null) },
  });

  // Verify view transitioned to agent selection
  assert.ok(pop.innerHTML.includes('Activate <b>PM</b>'));

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

test('nextAgentName increments generic members and ignores the fixed roles', () => {
  assert.equal(Team.nextAgentName([]), 'agent1');
  assert.equal(Team.nextAgentName(['pm', 'dev1', 'qa1']), 'agent1');
  assert.equal(Team.nextAgentName(['agent1']), 'agent2');
  assert.equal(Team.nextAgentName(['agent1', 'agent3']), 'agent4');
  assert.equal(Team.nextAgentName(['generico']), 'agent1');
  assert.equal(Team.nextGenericName, Team.nextAgentName, 'alias usato dal ticket');
});

test('getAgentMembers lists only generic members, in numeric order', () => {
  assert.deepEqual(Team.getAgentMembers([]), []);
  assert.deepEqual(Team.getAgentMembers(['pm', 'dev1', 'qa1']), []);
  assert.deepEqual(Team.getAgentMembers(['agent2', 'pm', 'agent1', 'dev1']), ['agent1', 'agent2']);
  assert.deepEqual(Team.getAgentMembers(['generico', 'agent2']), ['generico', 'agent2']);
  assert.equal(Team.getGenericMembers, Team.getAgentMembers, 'alias usato dal ticket');
});

test('la sezione Generico elenca i membri e avvia l\'agente scelto come agentN', async () => {
  env.tmuxAvailable = true;
  env.tmuxSession = 'work_generic_test';
  env.tmuxWindows = [{ id: '@7', name: 'agent1', active: false, path: '/home/u/generic-proj' }];
  env.createdWindows = [];

  const project = { path: '/home/u/generic-proj', focusedId: null, maximizedId: null };
  T.showProject(project);
  Team.initTeam({ activeProject: () => project });

  await Team.openTeamMenu();
  const pop = document.body.children.filter((c) => c.className?.includes('team-pop')).at(-1);
  assert.ok(pop);
  assert.match(pop.innerHTML, /Generic \(1 active\)/);
  assert.match(pop.innerHTML, /AGENT1/, 'badge del membro generico esistente');
  assert.match(pop.innerHTML, /data-act="kill-role" data-role="agent1"/, 'pulsante per terminarlo');
  assert.match(pop.innerHTML, /Add Generic \(agent2\)/);

  // "＋ Add Generic" apre la scelta dell'agente CLI.
  await pop.listeners.click[0]({
    target: { closest: (sel) => (sel === '[data-act]' ? { dataset: { act: 'add-generic' } } : null) },
  });
  assert.match(pop.innerHTML, /generic member AGENT2/);
  assert.match(pop.innerHTML, /data-agent-id="claude"/, 'la vista di selezione usa AGENTS');

  // Scegliendo Claude il membro generico parte con il comando dell'agente.
  await pop.listeners.click[0]({
    target: { closest: (sel) => (sel === '.tp-agent-row' ? { dataset: { agentId: 'claude' } } : null) },
  });
  assert.equal(env.createdWindows.at(-1).name, 'agent2');
  assert.equal(env.createdWindows.at(-1).cwd, '/home/u/generic-proj');
  assert.ok(env.createdWindows.at(-1).command.includes('claude'));

  for (const pane of T.terminalsOf(project)) T.closeTerminal(pane.id);
  await tick(50);
  env.tmuxAvailable = false;
});

test('la sezione Documentation sta tra QA e Generic e avvia docN con l’agente scelto', async () => {
  env.tmuxAvailable = true;
  env.tmuxSession = 'work_doc_test';
  env.tmuxWindows = [{ id: '@8', name: 'doc1', active: false, path: '/home/u/doc-proj' }];
  env.createdWindows = [];

  const project = { path: '/home/u/doc-proj', focusedId: null, maximizedId: null };
  T.showProject(project);
  Team.initTeam({ activeProject: () => project });
  await Team.openTeamMenu();
  const pop = document.body.children.filter((c) => c.className?.includes('team-pop')).at(-1);
  assert.ok(pop);

  const html = pop.innerHTML;
  const qa = html.indexOf('Quality Assurance');
  const docs = html.indexOf('Documentation');
  const generic = html.indexOf('Generic (');
  assert.ok(qa >= 0 && docs > qa && generic > docs, 'Documentation è tra QA e Generic');
  assert.match(html, /Documentation \(1 active\)/);
  assert.match(html, /tp-role-badge tp-role-doc">\[DOC1\]/);
  assert.match(html, /data-act="kill-role" data-role="doc1"/);
  assert.match(html, /Add Doc \(doc2\)/);

  await pop.listeners.click[0]({
    target: { closest: (sel) => (sel === '[data-act]' ? { dataset: { act: 'add-doc' } } : null) },
  });
  assert.match(pop.innerHTML, /documentation specialist DOC2/);
  assert.match(pop.innerHTML, /data-agent-id="claude"/);

  await pop.listeners.click[0]({
    target: { closest: (sel) => (sel === '.tp-agent-row' ? { dataset: { agentId: 'codex' } } : null) },
  });
  assert.equal(env.createdWindows.at(-1).name, 'doc2');
  assert.equal(env.createdWindows.at(-1).cwd, '/home/u/doc-proj');
  assert.ok(env.createdWindows.at(-1).command.includes('codex'));

  for (const pane of T.terminalsOf(project)) T.closeTerminal(pane.id);
  await tick(50);
  env.tmuxAvailable = false;
});

test('statusBadge shows Waiting with the question for a window that waits, Active otherwise', () => {
  const prompts = new Map([['dev1', { prompt_type: 'permission', question: 'Do you want to proceed?', options: [] }]]);
  assert.match(Team.statusBadge(prompts, 'dev1'), /waiting.*Waiting for answer/);
  assert.match(Team.statusBadge(prompts, 'dev1'), /title="Do you want to proceed\?"/);
  assert.match(Team.statusBadge(prompts, 'qa'), /active.*Active/);
});

test('statusBadge renders working, blocked and idle states from the dogwatch manifests', () => {
  const states = new Map([
    ['dev1', { state: 'working', rule: 'claude-spinner' }],
    ['qa1', { state: 'blocked', rule: 'claude-permission', prompt: { question: 'Proceed?' } }],
    ['agent1', { state: 'idle' }],
  ]);
  const working = Team.statusBadge(states, 'dev1');
  assert.match(working, /working.*Working/);
  assert.match(working, /tp-spinner/, 'a spinner shows the agent is active');
  const blocked = Team.statusBadge(states, 'qa1');
  assert.match(blocked, /waiting.*Waiting for answer/);
  assert.match(blocked, /title="Proceed\?"/);
  assert.match(Team.statusBadge(states, 'agent1'), /idle.*Idle/);
  assert.match(Team.statusBadge(states, 'unknown'), /active.*Active/);
});

test('the BotFather guide explains that only the PM talks to Telegram', () => {
  const guide = Team.telegramGuide();
  assert.match(guide, /@BotFather/);
  assert.match(guide, /\/newbot/);
  assert.match(guide, /0:pm/);
  assert.match(guide, /Dev and QA agents do not talk to Telegram/);
});

test('the Telegram panel appears only while the PM is active', async () => {
  env.tmuxAvailable = true;
  env.tmuxSession = 'work_tg_panel';
  env.tmuxWindows = [];
  const project = { path: '/home/u/tg-panel', focusedId: null, maximizedId: null };
  Team.initTeam({ activeProject: () => project });

  await Team.openTeamMenu();
  let pop = document.body.children.filter((c) => c.className?.includes('team-pop')).at(-1);
  assert.doesNotMatch(pop.innerHTML, /Telegram Bot/, 'no PM: no bot controls');

  Team.closeTeamMenu();
  env.tmuxWindows = [{ id: '@20', name: 'pm', active: false, path: '/home/u/tg-panel' }];
  Team.initTeam({ activeProject: () => project });
  await Team.openTeamMenu();
  pop = document.body.children.filter((c) => c.className?.includes('team-pop')).at(-1);
  assert.match(pop.innerHTML, /Telegram Bot/);
  assert.match(pop.innerHTML, /data-act="telegram-info"/);
  assert.match(pop.innerHTML, /data-telegram-form/);
  assert.match(pop.innerHTML, /id="tg-token"/, 'token field');
  assert.match(pop.innerHTML, /id="tg-chat"/, 'chat id field');
  assert.match(pop.innerHTML, /Connect/);
  env.tmuxAvailable = false;
});

test('connecting the Telegram form sends token, chat and session; disconnect returns the form', async () => {
  env.tmuxAvailable = true;
  env.tmuxSession = 'work_tg_connect';
  env.tmuxWindows = [{ id: '@21', name: 'pm', active: false, path: '/home/u/tg-connect' }];
  const project = { path: '/home/u/tg-connect', focusedId: null, maximizedId: null };
  Team.initTeam({ activeProject: () => project });
  telegramCalls.length = 0;

  await Team.openTeamMenu();
  let pop = document.body.children.filter((c) => c.className?.includes('team-pop')).at(-1);
  $('#tg-token').value = '123456:AAHm2x3YqW8sVn4Lp6Rt0Zk9Bd1Cf5Gh7J';
  $('#tg-chat').value = '987654321';
  await pop.listeners.submit[0]({
    preventDefault() {},
    target: { closest: (sel) => (sel === '[data-telegram-form]' ? {} : null) },
  });

  assert.deepEqual(telegramCalls[0], ['connect', '123456:AAHm2x3YqW8sVn4Lp6Rt0Zk9Bd1Cf5Gh7J', '987654321', '/home/u/tg-connect', 'work_tg_connect']);
  assert.match(pop.innerHTML, /Connected as @work_pm_bot/);
  assert.match(pop.innerHTML, /data-act="telegram-disconnect"/);

  await pop.listeners.click[0]({
    target: { closest: (sel) => (sel === '[data-act]' ? { dataset: { act: 'telegram-disconnect' } } : null) },
  });
  assert.deepEqual(telegramCalls.at(-1), ['disconnect']);
  assert.match(pop.innerHTML, /data-telegram-form/, 'the connection form is back');
  env.tmuxAvailable = false;
});

test('a dogwatch update refreshes the open popover: badge and count, without probing MCP again', async () => {
  env.tmuxAvailable = true;
  env.tmuxSession = 'work_live_test';
  env.tmuxWindows = [{ id: '@1', name: 'dev1', active: false, path: '/home/u/live-proj' }];
  let inspection = { session: 'work_live_test', windows: [{ id: '@1', name: 'dev1', prompt: null, state: 'working', rule: 'claude-spinner' }] };
  let onUpdate;
  let probes = 0;
  window.work.dogwatch = { onUpdate: (cb) => { onUpdate = cb; }, inspect: async () => inspection };
  window.work.mcp = { status: async () => { probes++; return { servers: [], browsers: [], env: [] }; } };

  const project = { path: '/home/u/live-proj', focusedId: null, maximizedId: null };
  T.showProject(project);
  Team.initTeam({ activeProject: () => project });
  await Team.openTeamMenu();
  const pop = document.body.children.filter((c) => c.className?.includes('team-pop')).at(-1);
  await tick();
  assert.doesNotMatch(pop.innerHTML, /Waiting for answer/);
  assert.match(pop.innerHTML, /Working/, 'the row follows the working state');
  assert.equal(probes, 1);

  const waiting = { prompt_type: 'permission', question: 'Do you want to proceed?', options: [] };
  inspection = { ...inspection, windows: [{ id: '@1', name: 'dev1', prompt: waiting, state: 'blocked', rule: 'claude-permission' }] };
  onUpdate(project.path, 'work_live_test', [{ target: 'dev1', ...waiting }]);
  await tick();
  assert.match(pop.innerHTML, /Waiting for answer/, 'the badge follows');
  assert.match(pop.innerHTML, /1 waiting for an answer/, 'and the count');
  assert.equal(probes, 1, 'the MCP result is kept');

  inspection = { ...inspection, windows: [{ id: '@1', name: 'dev1', prompt: null, state: 'idle' }] };
  onUpdate(project.path, 'work_live_test', []);
  await tick();
  assert.doesNotMatch(pop.innerHTML, /Waiting for answer/, 'it clears when answered');
  assert.match(pop.innerHTML, /Idle/, 'and the row goes back to idle');

  const before = pop.innerHTML;
  inspection = { ...inspection, windows: [{ id: '@1', name: 'dev1', prompt: waiting, state: 'blocked' }] };
  onUpdate('/another/project', 'other', [{ target: 'dev1', ...waiting }]);
  await tick();
  assert.equal(pop.innerHTML, before, 'another project leaves this popover alone');

  Team.closeTeamMenu();
  delete window.work.dogwatch;
  delete window.work.mcp;
  for (const pane of T.terminalsOf(project)) T.closeTerminal(pane.id);
  await tick(50);
  env.tmuxAvailable = false;
});

test('ledState: off without a tmux session, live while watching, escalation while agents wait', () => {
  assert.equal(Team.ledState(false, 0), 'off');
  assert.equal(Team.ledState(true, 0), 'live');
  assert.equal(Team.ledState(true, 2), 'escalation');
});

test('the Dogwatch LED follows the active project: off, Live, escalation and back', () => {
  let onUpdate;
  window.work.dogwatch = { onUpdate: (cb) => { onUpdate = cb; } };
  let project = { path: '/home/u/led-proj' };
  Team.initTeam({ activeProject: () => project });
  const led = $('#dogwatch-led');
  const label = led.querySelector('.led-label');

  onUpdate(project.path, 'work_led', [], false);
  assert.equal(led.dataset.state, 'off', 'no tmux session: the LED is off');
  assert.equal(label.textContent, 'Off');
  assert.match(led.title, /no tmux session/);

  onUpdate(project.path, 'work_led', [], true);
  assert.equal(led.dataset.state, 'live', 'the session is watched');
  assert.equal(label.textContent, 'Live');

  const waiting = { target: 'dev1', prompt_type: 'permission', question: 'Proceed?', options: [] };
  onUpdate(project.path, 'work_led', [waiting, { ...waiting, target: 'qa' }], true);
  assert.equal(led.dataset.state, 'escalation', 'agents waiting: orange');
  assert.equal(label.textContent, 'Live');
  assert.match(led.title, /2 agent\(s\) waiting/);

  onUpdate('/another/project', 'other', [], false);
  assert.equal(led.dataset.state, 'escalation', 'another project leaves the LED alone');

  project = { path: '/another/project' };
  Team.showLiveLed();
  assert.equal(led.dataset.state, 'off', 'switching project shows that project state');

  project = null;
  Team.showLiveLed();
  assert.equal(led.dataset.state, 'off', 'no project: off');

  project = { path: '/home/u/led-proj' };
  onUpdate(project.path, 'work_led', [], true);
  assert.equal(led.dataset.state, 'live', 'the answer clears the escalation');

  onUpdate('/home/u/led-proj', 'work_led', [], false);
  delete window.work.dogwatch;
});

test('startup with an existing tmux session: the LED asks dogwatch and turns Live without any update (regression)', async () => {
  let inspection = { session: 'work_test', windows: [{ id: '@1', name: 'dev1', prompt: null }] };
  window.work.dogwatch = { onUpdate: () => {}, inspect: async () => inspection };
  let project = { path: '/home/u/boot-live' };
  Team.initTeam({ activeProject: () => project });
  const led = $('#dogwatch-led');

  Team.showLiveLed();
  await tick();
  assert.equal(led.dataset.state, 'live', 'the missed first update does not leave the LED off');
  assert.equal(led.querySelector('.led-label').textContent, 'Live');

  inspection = { session: 'work_test', windows: [{ id: '@1', name: 'dev1', prompt: { prompt_type: 'permission', question: 'Proceed?', options: [] } }] };
  project = { path: '/home/u/boot-waiting' };
  Team.showLiveLed();
  await tick();
  assert.equal(led.dataset.state, 'escalation', 'a prompt already pending at startup is orange');

  window.work.dogwatch.inspect = async () => { throw new Error('no session'); };
  project = { path: '/home/u/boot-off' };
  Team.showLiveLed();
  await tick();
  assert.equal(led.dataset.state, 'off', 'no tmux session: off');
  delete window.work.dogwatch;
});

test('an update that lands while the startup check is in flight wins over the check', async () => {
  let onUpdate;
  let release;
  window.work.dogwatch = {
    onUpdate: (cb) => { onUpdate = cb; },
    inspect: () => new Promise((resolve) => { release = () => resolve({ session: 'work_test', windows: [] }); }),
  };
  const project = { path: '/home/u/boot-race' };
  Team.initTeam({ activeProject: () => project });
  const led = $('#dogwatch-led');

  Team.showLiveLed();
  await tick();
  onUpdate(project.path, 'work_test', [], false);
  release();
  await tick();
  assert.equal(led.dataset.state, 'off', 'the newer update is kept');
  delete window.work.dogwatch;
});

test('an agent row shows the Plane ticket the plane dogwatch gave it', () => {
  const assignments = [
    { window: 'dev1', issue: 26, id: 'u-26', state: 'In Progress', name: 'Plugin <updates>' },
    { window: 'qa', issue: 25, id: 'u-25', state: 'Test', name: 'Plugins' },
  ];
  assert.equal(Team.ticketLine(assignments, 'dev1'), '<div class="tp-ticket" title="Plugin &lt;updates&gt;">Ticket [26]: In Progress</div>');
  assert.match(Team.ticketLine(assignments, 'qa'), /Ticket \[25\]: Test/);
  assert.equal(Team.ticketLine(assignments, 'dev2'), '', 'no ticket, no line');
  assert.equal(Team.ticketLine([], 'dev1'), '');
});

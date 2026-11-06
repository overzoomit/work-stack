// Mission Control: the node canvas behind the Team popover.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env, tick, FakeTerminal } from './helpers/renderer-env.mjs';

const T = await import('../src/renderer/terminals.js');
const Team = await import('../src/renderer/team.js');
const Graph = await import('../src/renderer/agent_graph.js');
T.initTerminals({ homeDir: '/home/u', changed() {} });

const project = { path: '/home/u/graph-proj', focusedId: null, maximizedId: null };

let inspection = { session: 'work_graph', windows: [] };
let assignments = [];
let onUpdate;
let onPlaneUpdate;

window.work.dogwatch = {
  onUpdate: (cb) => {
    onUpdate = (path, session, pending, live, windows) => {
      inspection = { session, windows };
      cb(path, session, pending, live, windows);
    };
  },
  inspect: async () => inspection,
  answer: async () => {},
};
window.work.planeDogwatch = {
  onUpdate: (cb) => { onPlaneUpdate = cb; },
  status: async () => ({ projects: [{ project: project.path, assignments }] }),
};

test('roleOf maps every team family to a badge', () => {
  assert.equal(Graph.roleOf('pm').label, 'PM');
  assert.equal(Graph.roleOf('dev2').family, 'dev');
  assert.equal(Graph.roleOf('dev2').label, 'DEV2');
  assert.equal(Graph.roleOf('qa1').family, 'qa');
  assert.equal(Graph.roleOf('doc1').family, 'doc');
  assert.equal(Graph.roleOf('agent3').family, 'generic');
  assert.equal(Graph.roleOf('generico').family, 'generic');
});

test('agentState normalizes dogwatch records and bare prompts', () => {
  assert.equal(Graph.agentState({ state: 'working' }), 'working');
  assert.equal(Graph.agentState({ state: 'blocked', prompt: {} }), 'blocked');
  assert.equal(Graph.agentState({ prompt_type: 'question', question: 'Why?' }), 'blocked');
  assert.equal(Graph.agentState(null), 'idle');
});

test('buildAgentGraph orders roles, marks live states and carries the ticket', () => {
  const states = new Map([
    ['pm', { state: 'idle' }],
    ['dev1', { state: 'working' }],
    ['dev2', { state: 'blocked', prompt: { prompt_type: 'confirmation', question: 'Go?' } }],
    ['qa1', { state: 'idle' }],
  ]);
  const agents = new Map([['dev1', 'opencode']]);
  const graph = Graph.buildAgentGraph({
    names: ['qa1', 'dev2', 'pm', 'dev1', 'doc1'],
    states,
    agents,
    assignments: [
      { window: 'dev1', issue: 55, state: 'In Progress', name: 'Mission Control' },
      { window: 'doc1', issue: 12, state: 'Done', name: 'Docs' },
    ],
  });

  assert.deepEqual(graph.nodes.map((n) => n.name), ['pm', 'dev1', 'dev2', 'qa1', 'doc1']);
  const pm = graph.nodes.find((n) => n.name === 'pm');
  const dev1 = graph.nodes.find((n) => n.name === 'dev1');
  assert.ok(pm.y < dev1.y, 'PM sits above the squad');
  assert.equal(dev1.state, 'working');
  assert.equal(dev1.agent, 'opencode');
  assert.equal(dev1.ticketText, '[55] In Progress');
  assert.equal(graph.nodes.find((n) => n.name === 'dev2').state, 'blocked');
  assert.equal(graph.nodes.find((n) => n.name === 'doc1').state, 'done', 'a done ticket marks the idle agent as done');
  assert.equal(graph.nodes.find((n) => n.name === 'doc1').ticketText, '[12] Done');
  assert.equal(graph.edges.length, 4, 'one delegation edge from the PM to each role');
  assert.ok(graph.edges.every((e) => e.from === 'pm'));
  assert.equal(graph.edges.find((e) => e.to === 'dev1').state, 'working');
});

test('agentGraphSvg renders nodes, badges, tickets and animated flow particles', () => {
  const graph = Graph.buildAgentGraph({
    names: ['pm', 'dev1', 'dev2', 'qa1'],
    states: new Map([
      ['pm', { state: 'idle' }],
      ['dev1', { state: 'working' }],
      ['dev2', { state: 'blocked' }],
      ['qa1', { state: 'idle' }],
    ]),
    assignments: [{ window: 'dev2', issue: 42, state: 'Test', name: 'QA pass' }],
  });
  const svg = Graph.agentGraphSvg(graph);

  assert.match(svg, /<svg class="tp-graph-svg"/);
  assert.match(svg, /data-graph-node="pm"/);
  assert.match(svg, /data-graph-node="dev1"/);
  assert.match(svg, /\[DEV1\]/, 'role badge on the node');
  assert.match(svg, /ag-node state-working/, 'working ring on the node');
  assert.match(svg, /ag-node state-blocked[\s\S]*Needs You/, 'blocked node says Needs You');
  assert.match(svg, /Ticket \[42\] Test/, 'assigned ticket is shown');
  assert.match(svg, /class="ag-flow-particle state-working"/, 'working particle travels the edge');
  assert.match(svg, /class="ag-flow-particle state-blocked"/, 'blocked particle travels the edge');
  assert.match(svg, /<animateMotion dur="1.8s"/);
  assert.match(svg, /<animateMotion dur="1.1s"/);
  assert.equal((svg.match(/class="ag-flow-particle/g) || []).length, 2, 'idle roles get no particle');
});

test('Mission Control toggle, live dogwatch repaint and click-to-terminal', async () => {
  env.tmuxAvailable = true;
  env.tmuxSession = 'work_graph';
  env.tmuxWindows = [
    { id: '@0', name: 'pm', active: false, path: project.path },
    { id: '@1', name: 'dev1', active: false, path: project.path },
  ];
  inspection = { session: 'work_graph', windows: [
    { id: '@0', name: 'pm', state: 'idle', agent: 'antigravity' },
    { id: '@1', name: 'dev1', state: 'idle', agent: 'opencode' },
  ] };
  assignments = [];
  T.showProject(project);

  const pane = await Team.openOrFocusRole(project, 'dev1');
  assert.ok(pane);

  Team.initTeam({ activeProject: () => project });
  await Team.openTeamMenu();
  const pop = document.body.children.filter((c) => c.className?.includes('team-pop')).at(-1);
  assert.ok(pop);

  assert.match(pop.innerHTML, /data-act="view-graph"/, 'toggle is visible in the list view');
  assert.match(pop.innerHTML, /Mission Control/);

  const click = (map) => ({ target: { closest: (sel) => map[sel] ?? null } });
  await pop.listeners.click[0](click({ '[data-act]': { dataset: { act: 'view-graph' } } }));
  await tick();
  assert.match(pop.innerHTML, /<svg class="tp-graph-svg"/);
  assert.match(pop.innerHTML, /data-graph-node="dev1"/);
  assert.match(pop.innerHTML, /data-act="view-main"/, 'the list is one click away');
  assert.match(pop.innerHTML, /ag-node state-idle/, 'starts idle');

  // The watcher blocks dev1 and assigns ticket 55: the open canvas repaints.
  assignments = [{ window: 'dev1', issue: 55, state: 'In Progress', name: 'Mission Control' }];
  onUpdate(
    project.path,
    'work_graph',
    [{ target: 'dev1', prompt_type: 'confirmation', question: 'Go?' }],
    true,
    [
      { id: '@0', name: 'pm', state: 'idle', agent: 'antigravity' },
      { id: '@1', name: 'dev1', state: 'blocked', rule: 'opencode-permission', agent: 'opencode' },
    ],
  );
  await tick();
  assert.match(pop.innerHTML, /ag-node state-blocked[\s\S]*Needs You/, 'blocked state animated on the node');
  assert.match(pop.innerHTML, /Ticket \[55\] In Progress/, 'ticket follows the plane update');
  assert.match(pop.innerHTML, /class="ag-flow-particle state-blocked"/);

  onPlaneUpdate({ project: project.path, assignments });
  await tick();
  assert.match(pop.innerHTML, /Ticket \[55\] In Progress/);

  // Clicking the node closes the canvas and focuses the agent terminal.
  await pop.listeners.click[0](click({ '[data-graph-node]': { dataset: { graphNode: 'dev1' } } }));
  await tick();
  assert.equal(FakeTerminal.focused, pane.term, 'node click focuses the tmux terminal');
  await tick(700);
  assert.equal(
    document.body.children.find((c) => c.className?.includes('team-pop')),
    undefined,
    'the popover closes after the jump',
  );

  T.closeTerminal(pane.id);
  await tick(50);
  await Team.closeTeamMenu();
  env.tmuxAvailable = false;
});

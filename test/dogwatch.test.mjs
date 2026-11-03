// Dogwatch update propagation: the agent detected in a tmux pane (or read from
// the window command at re-attach) must win over the static role default.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env, tick } from './helpers/renderer-env.mjs';

const T = await import('../src/renderer/terminals.js');
const Team = await import('../src/renderer/team.js');
T.initTerminals({ homeDir: '/home/u', changed() {} });

const closeAll = async (project) => {
  for (const pane of T.terminalsOf(project)) T.closeTerminal(pane.id);
  await tick(700);
};

test('un update di dogwatch porta l’agente reale opencode su una finestra qa1, senza toccare gli altri progetti', async () => {
  let onUpdate;
  window.work.dogwatch = { onUpdate: (cb) => { onUpdate = cb; }, inspect: async () => null };

  const project = { path: '/home/u/dogwatch-proj', focusedId: null, maximizedId: null };
  const other = { path: '/home/u/other-proj', focusedId: null, maximizedId: null };
  T.showProject(project);
  Team.initTeam({ activeProject: () => project });

  const pane = await T.openTerminal(project, { title: 'qa1', kind: 'agent', tmuxName: 'qa1', agentId: 'codex' });
  const otherPane = await T.openTerminal(other, { title: 'qa1', kind: 'agent', tmuxName: 'qa1', agentId: 'codex' });
  const badge = pane.el.querySelector('.pane-agent-badge');
  const otherBadge = otherPane.el.querySelector('.pane-agent-badge');
  assert.equal(badge.textContent, 'CODEX', 'before the update: the hardcoded role fallback');

  onUpdate(project.path, 'work_dogwatch', [], true, [
    { id: '@7', name: 'qa1', agent: 'opencode', state: 'working', rule: 'opencode-spinner' },
  ]);

  assert.equal(pane.agentId, 'opencode');
  assert.equal(badge.textContent, 'OPENCODE', 'the badge shows the CLI really running');
  assert.equal(badge.dataset.agent, 'opencode');
  assert.equal(badge.title, 'OpenCode');
  assert.equal(badge.style.props['--agent-tint-1'], '#4fb3bf');
  assert.equal(badge.style.props['--agent-tint-2'], '#2d6f86');
  assert.equal(otherBadge.textContent, 'CODEX', 'another project has its own qa1 window');

  await closeAll(project);
  await closeAll(other);
  delete window.work.dogwatch;
});

test('al re-attach il comando della finestra tmux batte il fallback statico del ruolo', async () => {
  env.tmuxAvailable = true;
  env.tmuxSession = 'work_reattach_dogwatch';
  env.tmuxWindows = [{
    id: '@3', name: 'qa1', active: false, path: '/home/u/reattach-dogwatch',
    startCommand: 'ollama launch opencode --model deepseek-v4.1-flash:cloud',
    currentCommand: 'ollama',
  }];
  env.created = [];

  const project = { path: '/home/u/reattach-dogwatch', focusedId: null, maximizedId: null };
  T.showProject(project);

  const [pane] = await T.syncProjectTerminals(project);
  assert.equal(pane.agentId, 'opencode', 'the real command wins over roleFor(qa1) -> codex');
  const badge = pane.el.querySelector('.pane-agent-badge');
  assert.equal(badge.textContent, 'OPENCODE');
  assert.equal(badge.dataset.agent, 'opencode');
  assert.equal(env.created.at(-1).agent_id, 'opencode');

  await closeAll(project);
  env.tmuxWindows = [];
  env.tmuxAvailable = false;
});

test('la Squadra Agenti mostra l’agente realmente attivo accanto al ruolo', () => {
  const agents = new Map([
    ['qa1', 'opencode'],
    ['dev1', 'claude'],
    ['pm', 'antigravity'],
  ]);
  assert.equal(Team.agentLabel(agents, 'qa1'), 'OpenCode');
  assert.equal(Team.agentLabel(agents, 'dev1'), 'Claude Code');
  assert.equal(Team.agentLabel(agents, 'pm'), 'Antigravity (AGY)');
  assert.equal(Team.agentLabel(agents, 'unknown'), null);
  assert.equal(Team.agentLabel(null, 'qa1'), null);
});

test('la lista della Squadra Agenti rende OpenCode per una finestra qa1', async () => {
  env.tmuxAvailable = true;
  env.tmuxSession = 'work_team_dogwatch';
  env.tmuxWindows = [{ id: '@1', name: 'qa1', active: false, path: '/home/u/team-dogwatch' }];
  window.work.dogwatch = {
    onUpdate: () => {},
    inspect: async () => ({
      session: 'work_team_dogwatch',
      windows: [{ id: '@1', name: 'qa1', agent: 'opencode', state: 'working', rule: 'opencode-spinner', prompt: null }],
    }),
  };
  window.work.mcp = { status: async () => ({ servers: [], browsers: [], env: [] }) };

  const project = { path: '/home/u/team-dogwatch', focusedId: null, maximizedId: null };
  T.showProject(project);
  Team.initTeam({ activeProject: () => project });
  await Team.openTeamMenu();
  const pop = document.body.children.filter((c) => c.className?.includes('team-pop')).at(-1);
  await tick();

  assert.match(pop.innerHTML, /tp-agent-name">OpenCode</, 'the role shows the CLI really running');
  assert.match(pop.innerHTML, /\[QA1\]/, 'the role badge stays QA1');

  Team.closeTeamMenu();
  delete window.work.dogwatch;
  delete window.work.mcp;
  env.tmuxAvailable = false;
  env.tmuxWindows = [];
});

test('agentIdFromCommand riconosce i comandi reali e lascia vuoto ciò che non conosce', async () => {
  const { agentIdFromCommand } = await import('../src/renderer/agentcatalog.js');
  assert.equal(agentIdFromCommand('ollama launch opencode --model deepseek'), 'opencode');
  assert.equal(agentIdFromCommand('codex --dangerously-bypass-approvals-and-sandbox'), 'codex');
  assert.equal(agentIdFromCommand('agy --dangerously-skip-permissions'), 'antigravity');
  assert.equal(agentIdFromCommand('claude --resume abc'), 'claude');
  assert.equal(agentIdFromCommand('', null), null);
  assert.equal(agentIdFromCommand('bash -l'), null);
});

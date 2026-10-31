// Orchestrator for Multi-Agent Teams (PM, Dev1, Dev2..., QA1, QA2...) on tmux.
import { $, esc, leave, toast, ask } from './ui.js';
import { openTerminal, closeTerminal, focus, terminalsOf, syncProjectTerminals } from './terminals.js';
import { AGENTS, commandFor } from './launcher.js';
import { mcpSection } from './mcp.js';

const { work } = window;

let getProject = () => null;

export const TEAM_ROLES = [
  {
    id: 'pm',
    name: 'pm',
    role: 'PM',
    title: 'Senior PM & Architect',
    agent: 'Antigravity (AGY)',
    command: 'agy --dangerously-skip-permissions',
  },
  {
    id: 'dev1',
    name: 'dev1',
    role: 'DEV1',
    title: 'Senior Developer #1',
    agent: 'OpenCode (Ollama DeepSeek)',
    command: 'ollama launch opencode --model deepseek-v4.1-flash:cloud',
  },
  {
    id: 'dev2',
    name: 'dev2',
    role: 'DEV2',
    title: 'Senior Developer #2',
    agent: 'OpenCode (Ollama DeepSeek)',
    command: 'ollama launch opencode --model deepseek-v4.1-flash:cloud',
  },
  {
    id: 'qa',
    name: 'qa',
    role: 'QA',
    title: 'QA Engineer',
    agent: 'OpenAI Codex',
    command: 'codex --dangerously-bypass-approvals-and-sandbox',
  },
];

let pop = null;
const waitingByProject = new Map();
let viewState = { mode: 'main', targetRoleName: null, targetRoleLabel: null };

export function hasPm(existingNames = []) {
  return existingNames.some((n) => String(n).toLowerCase() === 'pm');
}

export function nextDevName(existingNames = []) {
  let highest = 0;
  for (const name of existingNames) {
    const m = String(name).match(/^dev(\d+)$/i);
    if (m) {
      const num = parseInt(m[1], 10);
      if (num > highest) highest = num;
    }
  }
  return `dev${highest + 1}`;
}

export function nextQaName(existingNames = []) {
  let highest = 0;
  for (const name of existingNames) {
    const m = String(name).match(/^qa(\d+)$/i);
    if (m) {
      const num = parseInt(m[1], 10);
      if (num > highest) highest = num;
    } else if (String(name).toLowerCase() === 'qa') {
      if (highest < 1) highest = 1;
    }
  }
  return `qa${highest + 1}`;
}

export function getDevMembers(existingNames = []) {
  return existingNames
    .filter((n) => /^dev(\d+)?$/i.test(n))
    .sort((a, b) => {
      const numA = parseInt((a.match(/\d+/) || [0])[0], 10);
      const numB = parseInt((b.match(/\d+/) || [0])[0], 10);
      return numA - numB;
    });
}

export function getQaMembers(existingNames = []) {
  return existingNames
    .filter((n) => /^qa(\d+)?$/i.test(n))
    .sort((a, b) => {
      const numA = parseInt((a.match(/\d+/) || [0])[0], 10);
      const numB = parseInt((b.match(/\d+/) || [0])[0], 10);
      return numA - numB;
    });
}

// Generic members: agent1, agent2…; a window named "generico" counts too.
const GENERIC = /^(agent(\d+)|generico)$/i;

export function nextAgentName(existingNames = []) {
  const nums = existingNames.map((n) => Number(String(n).match(GENERIC)?.[2] || 0));
  return `agent${Math.max(0, ...nums) + 1}`;
}

export function getAgentMembers(existingNames = []) {
  const num = (n) => Number(n.match(GENERIC)[2] || 0);
  return existingNames.filter((n) => GENERIC.test(n)).sort((a, b) => num(a) - num(b));
}

// Alias names used by the ticket: generic = ad-hoc agent outside the fixed roles.
export const nextGenericName = nextAgentName;
export const getGenericMembers = getAgentMembers;

// Dogwatch: the team button lights up while any agent waits for an answer.
function showWaiting(project, count) {
  waitingByProject.set(project, count);
  const total = [...waitingByProject.values()].reduce((a, b) => a + b, 0);
  const btn = $('#agent-team');
  btn?.classList.toggle('attention', total > 0);
  if (btn) btn.title = total > 0 ? `${total} agent(s) waiting for an answer` : 'Manage the agent team (PM, Dev1, Dev2, QA, Generic)';
}

export function statusBadge(prompts, name) {
  const prompt = prompts.get(name);
  if (!prompt) return '<span class="tp-badge-status active">Active</span>';
  return `<span class="tp-badge-status waiting" title="${esc(prompt.question)}">Waiting for answer</span>`;
}

const dotClass = (prompts, name) => (prompts.has(name) ? 'waiting' : 'active');

// The Info button opens this guide in the shared modal. Only the PM is wired
// to the bot: dev and QA never get a token or a chat.
export function telegramGuide() {
  return [
    'How to connect the PM to Telegram',
    '',
    '1. Open Telegram and search @BotFather.',
    '2. Send /newbot, choose a name and a username ending in "bot".',
    '3. Copy the token BotFather gives you (format 123456:ABC…).',
    '4. Open a chat with your new bot and press Start.',
    '5. Get your numeric Chat ID (for example from @userinfobot) and paste it here.',
    '',
    'The bot forwards only this chat to the PM window (0:pm). Dev and QA agents do not talk to Telegram: their questions go through dogwatch and the PM decides what to escalate.',
  ].join('\n');
}

export function telegramLabel(status) {
  if (!status) return 'Not available';
  if (status.connected) return `Connected as @${status.bot || 'bot'}`;
  return status.lastError ? 'Connection error' : 'Not connected';
}

function telegramPanel(status) {
  const connected = !!status?.connected;
  return `
    <div class="tp-telegram">
      <div class="tp-telegram-head">
        <span class="tp-telegram-title">✈️ Telegram Bot</span>
        <span class="tp-badge-status ${connected ? 'active' : ''}">${esc(telegramLabel(status))}</span>
        <div class="spacer"></div>
        <button class="icon-btn tp-act-btn" data-act="telegram-info" title="Guide: create the bot with @BotFather">Info</button>
      </div>
      ${connected ? `
        <div class="tp-telegram-meta">Chat <b>${esc(status.chatId)}</b> · messages go to the PM window (0:pm)</div>
        ${status.lastError ? `<div class="tp-error">${esc(status.lastError)}</div>` : ''}
        <button class="tp-add-btn telegram" data-act="telegram-disconnect">Disconnect</button>
      ` : `
        <form class="tp-telegram-form" data-telegram-form>
          <label>Bot token<input class="tp-input" id="tg-token" type="password" autocomplete="off" spellcheck="false" placeholder="123456:ABC…"></label>
          <label>Chat ID<input class="tp-input" id="tg-chat" inputmode="numeric" autocomplete="off" placeholder="123456789"></label>
          <button type="submit" class="tp-add-btn telegram">Connect</button>
        </form>
        ${status?.lastError ? `<div class="tp-error">${esc(status.lastError)}</div>` : ''}
      `}
    </div>`;
}

async function connectTelegram(project) {
  const token = $('#tg-token').value.trim();
  const chatId = $('#tg-chat').value.trim();
  if (!token || !chatId) {
    toast('Enter both the bot token and the chat ID.', { error: true });
    return;
  }
  const { session } = await getExistingNames(project);
  if (!session) {
    toast('A tmux session is needed: open the project and try again.', { error: true });
    return;
  }
  try {
    await work.telegram.connect(token, chatId, project.path, session);
    toast(`Telegram bot connected to ${session}:pm.`);
    await renderPopContent();
  } catch (e) {
    toast(e?.message || String(e), { error: true });
  }
}

async function refreshMcp() {
  const body = pop?.querySelector('.tp-mcp-body');
  if (!body) return;
  body.innerHTML = '<div class="tp-desc">Checking…</div>';
  body.innerHTML = mcpSection(await work.mcp?.status().catch(() => null));
}

async function launchBrowser(id) {
  try {
    toast(await work.mcp.launchBrowser(id));
  } catch (e) {
    toast(e?.message || String(e), { error: true });
    return;
  }
  setTimeout(refreshMcp, 2500);
}

export function initTeam({ activeProject }) {
  getProject = activeProject;
  work?.dogwatch?.onUpdate((project, _session, pending) => showWaiting(project, pending.length));
  work?.telegram?.onStatus(() => {
    if (pop) renderPopContent();
  });
  const btn = $('#agent-team');
  if (!btn) return;

  btn.onpointerdown = (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (pop) closeTeamMenu();
    else openTeamMenu();
  };
}

export function closeTeamMenu() {
  if (!pop) return;
  const el = pop;
  pop = null;
  viewState = { mode: 'main', targetRoleName: null, targetRoleLabel: null };
  $('#agent-team')?.classList.remove('open');
  removeEventListener('keydown', onKey, true);
  removeEventListener('pointerdown', onOutside, true);
  leave(el, () => el.remove());
}

function onOutside(e) {
  if (pop && !pop.contains(e.target) && !$('#agent-team')?.contains(e.target)) {
    closeTeamMenu();
  }
}

function onKey(e) {
  if (!pop) return;
  if (e.key === 'Escape') {
    if (viewState.mode === 'select-agent') {
      viewState.mode = 'main';
      renderPopContent();
    } else {
      closeTeamMenu();
    }
    e.preventDefault();
    e.stopPropagation();
  }
}

// Launches or focuses an existing terminal pane by title/tmuxName
export function focusOrFindPane(project, name) {
  if (!project || !name) return null;
  const existing = terminalsOf(project).find((t) => t.tmuxName === name || t.title === name);
  if (existing) {
    focus(existing.id);
    existing.term?.focus();
    return existing;
  }
  return null;
}

// Opens or focuses a specific team role window without opening all windows
export async function openOrFocusRole(project, roleName) {
  if (!project || !roleName) return null;
  const existing = focusOrFindPane(project, roleName);
  if (existing) return existing;

  const isTmux = await work?.tmux?.isAvailable().catch(() => false);
  if (isTmux) {
    const session = await work.tmux.sessionForProject(project.path).catch(() => null);
    if (session) {
      const windows = await work.tmux.listWindows(session).catch(() => []);
      const win = windows.find((w) => w.name === roleName);
      if (win) {
        return openTerminal(project, {
          cwd: win.path || project.path,
          title: win.name,
          tmuxSession: session,
          tmuxWindow: win.id,
          tmuxName: win.name,
        });
      }
    }
  }
  return null;
}

// Terminates a team role window and closes its UI pane
export async function killTeamRole(project, roleName) {
  if (!project || !roleName) return;
  const isTmux = await work?.tmux?.isAvailable().catch(() => false);
  if (isTmux) {
    const session = await work.tmux.sessionForProject(project.path).catch(() => null);
    if (session) {
      const windows = await work.tmux.listWindows(session).catch(() => []);
      const win = windows.find((w) => w.name === roleName);
      if (win) {
        await work.tmux.killWindow(session, win.id).catch(() => {});
      }
    }
  }
  const pane = terminalsOf(project).find((t) => t.tmuxName === roleName || t.title === roleName);
  if (pane) {
    closeTerminal(pane.id);
  }
  toast(`Role [${roleName.toUpperCase()}] terminated.`);
}

// Creates and launches a team window for a specific role and selected agent
export async function createTeamMember(project, roleName, agent) {
  if (!project || !roleName || !agent) return null;

  const cmd = commandFor(agent);
  const isTmux = await work?.tmux?.isAvailable().catch(() => false);

  if (isTmux) {
    const session = await work.tmux.sessionForProject(project.path).catch(() => null);
    if (session) {
      await work.tmux.ensureSession(session, project.path).catch(() => {});
      const windows = await work.tmux.listWindows(session).catch(() => []);
      const existingWin = windows.find((w) => w.name === roleName);
      if (existingWin) {
        await work.tmux.killWindow(session, existingWin.id).catch(() => {});
      }
      const existingPane = terminalsOf(project).find((t) => t.tmuxName === roleName || t.title === roleName);
      if (existingPane) {
        closeTerminal(existingPane.id);
      }
      const newWinId = await work.tmux.newWindow(session, roleName, project.path, cmd);
      const pane = await openTerminal(project, {
        cwd: project.path,
        title: roleName,
        tmuxSession: session,
        tmuxWindow: newWinId || roleName,
        tmuxName: roleName,
      });
      toast(`Started [${roleName.toUpperCase()}] with ${agent.name} on tmux.`);
      return pane;
    }
  }

  // Fallback without tmux
  const existingPane = terminalsOf(project).find((t) => t.tmuxName === roleName || t.title === roleName);
  if (existingPane) {
    closeTerminal(existingPane.id);
  }
  const pane = await openTerminal(project, {
    cwd: project.path,
    title: roleName,
    command: cmd,
    tmuxName: roleName,
  });
  toast(`Started [${roleName.toUpperCase()}] with ${agent.name}.`);
  return pane;
}

// Collect all existing window/pane names in project
async function getExistingNames(project) {
  const openPanes = terminalsOf(project);
  const names = new Set();
  openPanes.forEach((p) => {
    if (p.tmuxName) names.add(p.tmuxName);
    if (p.title) names.add(p.title);
  });

  const isTmux = await work?.tmux?.isAvailable().catch(() => false);
  let session = null;
  let tmuxWindows = [];
  if (isTmux) {
    session = await work.tmux.sessionForProject(project.path).catch(() => null);
    if (session) {
      tmuxWindows = await work.tmux.listWindows(session).catch(() => []);
      tmuxWindows.forEach((w) => {
        if (w.name) names.add(w.name);
      });
    }
  }

  const inspection = session ? await work.dogwatch?.inspect(session).catch(() => null) : null;
  const prompts = new Map((inspection?.windows ?? []).filter((w) => w.prompt).map((w) => [w.name, w.prompt]));

  return { isTmux, session, tmuxWindows, openPanes, prompts, names: [...names] };
}

// Renders the popover content based on current viewState
async function renderPopContent() {
  if (!pop) return;
  const p = getProject();
  if (!p) return;

  if (viewState.mode === 'select-agent') {
    const { targetRoleName, targetRoleLabel } = viewState;
    pop.innerHTML = `
      <header class="tp-head">
        <div class="tp-title">
          <div style="display:flex;align-items:center;">
            <button class="icon-btn tp-back" data-act="back" title="Back to team">←</button>
            <span>Activate <b>${esc(targetRoleName.toUpperCase())}</b></span>
          </div>
          <button class="icon-btn" data-act="close" title="Close (Esc)">✕</button>
        </div>
        <div class="tp-sub">
          ${esc(targetRoleLabel || 'Choose which CLI agent to activate:')}
        </div>
      </header>
      <div class="tp-select-list">
        ${AGENTS.map((a) => `
          <div class="tp-agent-row" data-agent-id="${esc(a.id)}">
            <span class="ap-tile" style="--t1:${esc(a.tint[0])};--t2:${esc(a.tint[1])}">${esc(a.mono)}</span>
            <div class="tp-info">
              <div class="tp-name">
                <span>${esc(a.name)}</span>
                <span style="font-size:10.5px;color:var(--text-2);">${esc(a.by)}</span>
              </div>
              <div class="tp-desc">${esc(a.desc)}</div>
              <div class="tp-cmd">${esc(commandFor(a))}</div>
            </div>
          </div>
        `).join('')}
      </div>
    `;
    return;
  }

  // Main squad view
  const { isTmux, session, tmuxWindows, prompts, names } = await getExistingNames(p);

  const pmActive = hasPm(names);
  const devList = getDevMembers(names);
  const qaList = getQaMembers(names);
  const agentList = getAgentMembers(names);

  const nextDev = nextDevName(names);
  const nextQa = nextQaName(names);
  const nextAgent = nextAgentName(names);
  const telegram = pmActive && work?.telegram?.status ? await work.telegram.status().catch(() => null) : null;

  pop.innerHTML = `
    <header class="tp-head">
      <div class="tp-title">
        <span>👥 Agent Team</span>
        <button class="icon-btn" data-act="close" title="Close (Esc)">✕</button>
      </div>
      <div class="tp-sub">
        ${isTmux ? `tmux session: <b>${esc(session || 'inactive')}</b> · ${tmuxWindows.length} windows${prompts.size ? ` · <b class="tp-waiting">${prompts.size} waiting for an answer</b>` : ''}` : 'Standard terminal mode (tmux not available)'}
      </div>
    </header>

    <div class="tp-list">
      <!-- PM section: only one -->
      <div class="tp-section">
        <div class="tp-section-head">
          <span>👑 Project Manager (PM - 1 only)</span>
          <span style="font-size:10px;font-weight:normal;color:var(--text-2);">${pmActive ? 'Assigned' : 'Not configured'}</span>
        </div>
        ${pmActive ? `
          <div class="tp-row" data-focus-role="pm" title="Click to open the PM terminal">
            <span class="tp-status-dot active"></span>
            <span class="tp-role-badge tp-role-pm">[PM]</span>
            <div class="tp-info">
              <div class="tp-name">
                <span>pm</span>
                <span class="tp-badge-status active">Active</span>
              </div>
              <div class="tp-desc">Senior PM &amp; Architect · Click to view</div>
            </div>
            <div class="tp-row-actions">
              <button class="icon-btn tp-act-btn" data-act="reconfig-role" data-role="pm" title="Reconfigure or change agent for PM">⚙</button>
              <button class="icon-btn tp-act-btn" data-act="kill-role" data-role="pm" title="Terminate PM window">✕</button>
            </div>
          </div>
        ` : `
          <button class="tp-add-btn pm" data-act="add-pm">
            ＋ Add PM (choose agent)
          </button>
        `}
        ${pmActive ? telegramPanel(telegram) : ''}
      </div>

      <!-- Dev section: multiple (dev1, dev2...) -->
      <div class="tp-section">
        <div class="tp-section-head">
          <span>💻 Developers (${devList.length} active)</span>
        </div>
        ${devList.map((devName) => `
          <div class="tp-row" data-focus-role="${esc(devName)}" title="Click to open the ${esc(devName)} terminal">
            <span class="tp-status-dot ${dotClass(prompts, devName)}"></span>
            <span class="tp-role-badge tp-role-dev">[${esc(devName.toUpperCase())}]</span>
            <div class="tp-info">
              <div class="tp-name">
                <span>${esc(devName)}</span>
                ${statusBadge(prompts, devName)}
              </div>
              <div class="tp-desc">Developer · Click to view</div>
            </div>
            <div class="tp-row-actions">
              <button class="icon-btn tp-act-btn" data-act="kill-role" data-role="${esc(devName)}" title="Terminate window ${esc(devName)}">✕</button>
            </div>
          </div>
        `).join('')}
        <button class="tp-add-btn dev" data-act="add-dev" data-next="${esc(nextDev)}">
          ＋ Add Dev (${esc(nextDev)})
        </button>
      </div>

      <!-- QA section: multiple (qa1, qa2...) -->
      <div class="tp-section">
        <div class="tp-section-head">
          <span>🛡️ Quality Assurance (${qaList.length} active)</span>
        </div>
        ${qaList.map((qaName) => `
          <div class="tp-row" data-focus-role="${esc(qaName)}" title="Click to open the ${esc(qaName)} terminal">
            <span class="tp-status-dot ${dotClass(prompts, qaName)}"></span>
            <span class="tp-role-badge tp-role-qa">[${esc(qaName.toUpperCase())}]</span>
            <div class="tp-info">
              <div class="tp-name">
                <span>${esc(qaName)}</span>
                ${statusBadge(prompts, qaName)}
              </div>
              <div class="tp-desc">QA Engineer · Click to view</div>
            </div>
            <div class="tp-row-actions">
              <button class="icon-btn tp-act-btn" data-act="kill-role" data-role="${esc(qaName)}" title="Terminate window ${esc(qaName)}">✕</button>
            </div>
          </div>
        `).join('')}
        <button class="tp-add-btn qa" data-act="add-qa" data-next="${esc(nextQa)}">
          ＋ Add QA (${esc(nextQa)})
        </button>
      </div>

      <!-- Generic section: ad-hoc members (agent1, agent2...) with a CLI agent of choice -->
      <div class="tp-section">
        <div class="tp-section-head">
          <span>🤖 Generic (${agentList.length} active)</span>
        </div>
        ${agentList.map((agentName) => `
          <div class="tp-row" data-focus-role="${esc(agentName)}" title="Click to open the ${esc(agentName)} terminal">
            <span class="tp-status-dot ${dotClass(prompts, agentName)}"></span>
            <span class="tp-role-badge tp-role-generic">[${esc(agentName.toUpperCase())}]</span>
            <div class="tp-info">
              <div class="tp-name">
                <span>${esc(agentName)}</span>
                ${statusBadge(prompts, agentName)}
              </div>
              <div class="tp-desc">Generic agent · Click to view</div>
            </div>
            <div class="tp-row-actions">
              <button class="icon-btn tp-act-btn" data-act="kill-role" data-role="${esc(agentName)}" title="Terminate window ${esc(agentName)}">✕</button>
            </div>
          </div>
        `).join('')}
        <button class="tp-add-btn generic" data-act="add-generic" data-next="${esc(nextAgent)}">
          ＋ Add Generic (${esc(nextAgent)})
        </button>
      </div>
      <div class="tp-section">
        <div class="tp-section-head">
          <span>🔌 MCP &amp; browsers</span>
          <button class="icon-btn tp-act-btn" data-act="mcp-check" title="Check MCP servers and browsers">↻</button>
        </div>
        <div class="tp-mcp-body"><div class="tp-desc">Checking…</div></div>
      </div>
    </div>

    <div class="tp-actions">
      <button class="tp-btn-secondary" data-act="sync-team" style="flex:1;">
        ↻ Sync tmux windows
      </button>
    </div>
  `;
  refreshMcp();
}

export async function openTeamMenu() {
  const p = getProject();
  if (!p) {
    toast('Open a project first to manage the agent team.');
    return;
  }

  closeTeamMenu();
  // A previous interaction may have left the agent-selection view behind.
  viewState = { mode: 'main', targetRoleName: null, targetRoleLabel: null };

  pop = document.createElement('div');
  pop.className = 'team-pop';
  document.body.appendChild(pop);

  const btn = $('#agent-team');
  if (btn) {
    const b = btn.getBoundingClientRect();
    pop.style.top = `${b.bottom + 8}px`;
    pop.style.right = `${Math.max(8, innerWidth - b.right)}px`;
    pop.style.transformOrigin = `calc(100% - ${b.width / 2}px) -8px`;
    btn.classList.add('open');
  }

  await renderPopContent();

  pop.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') {
      closeTeamMenu();
      return;
    }
    if (act === 'back') {
      viewState.mode = 'main';
      await renderPopContent();
      return;
    }
    if (act === 'sync-team') {
      const reattached = await syncProjectTerminals(p);
      toast(reattached.length ? `Reattached ${reattached.length} tmux windows.` : 'All windows are already in sync.');
      await renderPopContent();
      return;
    }

    if (act === 'telegram-info') {
      await ask({ text: telegramGuide(), input: false, okLabel: 'Close' });
      return;
    }

    if (act === 'telegram-disconnect') {
      if (!work?.telegram?.disconnect) {
        toast('Telegram is not available in this build.', { error: true });
        return;
      }
      await work.telegram.disconnect();
      toast('Telegram bot disconnected.');
      await renderPopContent();
      return;
    }

    if (act === 'mcp-check') {
      await refreshMcp();
      return;
    }

    if (act === 'mcp-launch') {
      await launchBrowser(e.target.closest('[data-browser]')?.dataset.browser);
      return;
    }

    if (act === 'kill-role') {
      const role = e.target.closest('[data-role]')?.dataset.role;
      if (role) {
        await killTeamRole(p, role);
        await renderPopContent();
      }
      return;
    }

    if (act === 'reconfig-role') {
      const role = e.target.closest('[data-role]')?.dataset.role || 'pm';
      viewState = {
        mode: 'select-agent',
        targetRoleName: role,
        targetRoleLabel: `Choose which CLI agent to reactivate for ${role.toUpperCase()}:`,
      };
      await renderPopContent();
      return;
    }

    if (act === 'add-pm') {
      const { names } = await getExistingNames(p);
      if (hasPm(names)) {
        toast('The team already has a PM (only one PM allowed).');
        return;
      }
      viewState = {
        mode: 'select-agent',
        targetRoleName: 'pm',
        targetRoleLabel: 'Choose which CLI agent to activate for the PM role:',
      };
      await renderPopContent();
      return;
    }

    if (act === 'add-dev') {
      const { names } = await getExistingNames(p);
      const devName = nextDevName(names);
      viewState = {
        mode: 'select-agent',
        targetRoleName: devName,
        targetRoleLabel: `Choose which CLI agent to activate for developer ${devName.toUpperCase()}:`,
      };
      await renderPopContent();
      return;
    }

    if (act === 'add-qa') {
      const { names } = await getExistingNames(p);
      const qaName = nextQaName(names);
      viewState = {
        mode: 'select-agent',
        targetRoleName: qaName,
        targetRoleLabel: `Choose which CLI agent to activate for QA ${qaName.toUpperCase()}:`,
      };
      await renderPopContent();
      return;
    }

    if (act === 'add-generic') {
      const { names } = await getExistingNames(p);
      const agentName = nextAgentName(names);
      viewState = {
        mode: 'select-agent',
        targetRoleName: agentName,
        targetRoleLabel: `Choose which CLI agent to activate for generic member ${agentName.toUpperCase()}:`,
      };
      await renderPopContent();
      return;
    }

    // In agent selection mode: clicking an agent row
    const agentRow = e.target.closest('.tp-agent-row');
    if (agentRow && viewState.mode === 'select-agent') {
      const agentId = agentRow.dataset.agentId;
      const agent = AGENTS.find((a) => a.id === agentId);
      const target = viewState.targetRoleName;
      if (agent && target) {
        closeTeamMenu();
        await createTeamMember(p, target, agent);
      }
      return;
    }

    // Focus or open existing role pane
    const focusRow = e.target.closest('[data-focus-role]');
    if (focusRow && !e.target.closest('.tp-act-btn')) {
      const roleName = focusRow.dataset.focusRole;
      closeTeamMenu();
      await openOrFocusRole(p, roleName);
      return;
    }
  });

  addEventListener('keydown', onKey, true);
  addEventListener('pointerdown', onOutside, true);

  // The PM connection form submits with the button or Enter.
  pop.addEventListener('submit', async (e) => {
    if (!e.target.closest?.('[data-telegram-form]')) return;
    e.preventDefault();
    if (!work?.telegram?.connect) {
      toast('Telegram is not available in this build.', { error: true });
      return;
    }
    await connectTelegram(p);
  });
}

// Launches or focuses an individual member of the team
export async function launchTeamMember(project, role) {
  if (!project || !role) return null;
  const existing = terminalsOf(project).find((t) => t.tmuxName === role.name || t.title === role.name);
  if (existing) {
    existing.term?.focus();
    return existing;
  }

  const isTmux = await work?.tmux?.isAvailable().catch(() => false);
  if (isTmux) {
    const session = await work.tmux.sessionForProject(project.path).catch(() => null);
    if (session) {
      const windows = await work.tmux.listWindows(session).catch(() => []);
      const win = windows.find((w) => w.name === role.name);
      if (win) {
        return openTerminal(project, {
          cwd: win.path || project.path,
          title: win.name,
          tmuxSession: session,
          tmuxWindow: win.id,
          tmuxName: win.name,
        });
      } else {
        await work.tmux.newWindow(session, role.name, project.path, role.command);
        const updated = await work.tmux.listWindows(session).catch(() => []);
        const newWin = updated.find((w) => w.name === role.name);
        return openTerminal(project, {
          cwd: project.path,
          title: role.name,
          tmuxSession: session,
          tmuxWindow: newWin ? newWin.id : null,
          tmuxName: role.name,
        });
      }
    }
  }

  // Fallback without tmux
  return openTerminal(project, {
    cwd: project.path,
    title: role.name,
    command: role.command,
    tmuxName: role.name,
  });
}

// Initializes the entire squad: pm, dev1, dev2, qa
export async function initializeTeam(project) {
  if (!project) return [];
  const isTmux = await work?.tmux?.isAvailable().catch(() => false);
  const panes = [];

  if (isTmux) {
    const session = await work.tmux.sessionForProject(project.path).catch(() => null);
    if (session) {
      const windows = await work.tmux.listWindows(session).catch(() => []);
      for (const role of TEAM_ROLES) {
        const exists = windows.some((w) => w.name === role.name);
        if (!exists) {
          await work.tmux.newWindow(session, role.name, project.path, role.command);
        }
      }
      const reattached = await syncProjectTerminals(project);
      panes.push(...reattached);
      toast(`Agent team initialized on tmux (${TEAM_ROLES.length} roles).`);
      return panes;
    }
  }

  // Fallback without tmux: open terminal panes directly
  for (const role of TEAM_ROLES) {
    const p = await launchTeamMember(project, role);
    if (p) panes.push(p);
  }
  toast(`Agent team started (${panes.length} terminals).`);
  return panes;
}

// Adds an ad-hoc agent window to the team session
export async function addAgentWindow(project, agent, customName = null) {
  if (!project || !agent) return null;
  const name = customName || agent.id;
  return createTeamMember(project, name, agent);
}

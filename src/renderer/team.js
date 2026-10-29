// Orchestrator for Multi-Agent Teams (PM, Dev1, Dev2, QA) on tmux.
import { $, esc, leave, toast } from './ui.js';
import { openTerminal, terminalsOf, syncProjectTerminals } from './terminals.js';
import { AGENTS } from './launcher.js';

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

export function initTeam({ activeProject }) {
  getProject = activeProject;
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
    closeTeamMenu();
    e.preventDefault();
    e.stopPropagation();
  }
}

export async function openTeamMenu() {
  const p = getProject();
  if (!p) {
    toast('Apri prima un progetto per gestire la squadra agenti.');
    return;
  }

  closeTeamMenu();

  const isTmux = await work?.tmux?.isAvailable().catch(() => false);
  const session = isTmux ? await work.tmux.sessionForProject(p.path).catch(() => null) : null;
  const tmuxWindows = session ? await work.tmux.listWindows(session).catch(() => []) : [];
  const openPanes = terminalsOf(p);

  pop = document.createElement('div');
  pop.className = 'team-pop';
  pop.innerHTML = `
    <header class="tp-head">
      <div class="tp-title">
        <span>👥 Squadra Agenti Multi-Ruolo</span>
        <button class="icon-btn" data-act="close" title="Chiudi (Esc)">✕</button>
      </div>
      <div class="tp-sub">
        ${isTmux ? `Sessione tmux: <b>${esc(session || 'non attiva')}</b> · ${tmuxWindows.length} finestre` : 'Modalità terminali standard (tmux non disponibile)'}
      </div>
    </header>
    <div class="tp-actions">
      <button class="tp-btn-primary" data-act="init-team">
        🚀 Inizializza Squadra (PM + 2 Dev + QA)
      </button>
      <button class="tp-btn-secondary" data-act="sync-team" title="Rileva finestre tmux esistenti">
        ↻ Sincronizza
      </button>
    </div>
    <div class="tp-list">
      ${TEAM_ROLES.map((r) => {
        const isOpen = openPanes.some((pane) => pane.tmuxName === r.name || pane.title === r.name);
        const inTmux = tmuxWindows.some((w) => w.name === r.name);
        const active = isOpen || inTmux;
        return `
          <div class="tp-row" data-role-id="${esc(r.id)}" data-role-name="${esc(r.name)}" title="${active ? 'Finestra attiva - clicca per aprire' : 'Clicca per avviare questo agente'}">
            <span class="tp-status-dot${active ? ' active' : ''}"></span>
            <span class="tp-role-badge tp-role-${esc(r.id)}">[${esc(r.role)}]</span>
            <div class="tp-info">
              <div class="tp-name">
                <span>${esc(r.title)}</span>
                <span class="tp-badge-status${active ? ' active' : ''}">${active ? 'Attivo' : 'Non avviato'}</span>
              </div>
              <div class="tp-desc">${esc(r.agent)}</div>
              <div class="tp-cmd">${esc(r.command)}</div>
            </div>
          </div>
        `;
      }).join('')}
    </div>
    <div class="tp-agent-picker">
      <div class="tp-picker-title">＋ Aggiungi Agente al volo:</div>
      <div class="tp-agent-chips">
        ${AGENTS.map((a) => `
          <button class="tp-chip" data-agent-id="${esc(a.id)}" data-agent-bin="${esc(a.bin)}" data-agent-name="${esc(a.name)}" data-agent-cmd="${esc(a.command)}">
            ${esc(a.name)}
          </button>
        `).join('')}
      </div>
    </div>
  `;

  document.body.appendChild(pop);
  const btn = $('#agent-team');
  if (btn) {
    const b = btn.getBoundingClientRect();
    pop.style.top = `${b.bottom + 8}px`;
    pop.style.right = `${Math.max(8, innerWidth - b.right)}px`;
    pop.style.transformOrigin = `calc(100% - ${b.width / 2}px) -8px`;
    btn.classList.add('open');
  }

  pop.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') {
      closeTeamMenu();
      return;
    }
    if (act === 'init-team') {
      closeTeamMenu();
      await initializeTeam(p);
      return;
    }
    if (act === 'sync-team') {
      closeTeamMenu();
      const reattached = await syncProjectTerminals(p);
      toast(reattached.length ? `Ricollegate ${reattached.length} finestre tmux.` : 'Tutte le finestre sono già sincronizzate.');
      return;
    }

    const row = e.target.closest('.tp-row');
    if (row) {
      const roleName = row.dataset.roleName;
      const role = TEAM_ROLES.find((r) => r.name === roleName);
      if (role) {
        closeTeamMenu();
        await launchTeamMember(p, role);
      }
      return;
    }

    const chip = e.target.closest('.tp-chip');
    if (chip) {
      const agentId = chip.dataset.agentId;
      const agent = AGENTS.find((a) => a.id === agentId);
      if (agent) {
        closeTeamMenu();
        await addAgentWindow(p, agent);
      }
    }
  });

  addEventListener('keydown', onKey, true);
  addEventListener('pointerdown', onOutside, true);
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
        await work.tmux.newWindow(session, role.name, role.command, project.path);
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
          await work.tmux.newWindow(session, role.name, role.command, project.path);
        }
      }
      const reattached = await syncProjectTerminals(project);
      panes.push(...reattached);
      toast(`Squadra Agenti inizializzata su tmux (${TEAM_ROLES.length} ruoli).`);
      return panes;
    }
  }

  // Fallback without tmux: open terminal panes directly
  for (const role of TEAM_ROLES) {
    const p = await launchTeamMember(project, role);
    if (p) panes.push(p);
  }
  toast(`Squadra Agenti avviata (${panes.length} terminali).`);
  return panes;
}

// Adds an ad-hoc agent window to the team session
export async function addAgentWindow(project, agent, customName = null) {
  if (!project || !agent) return null;
  const name = customName || agent.id;
  const isTmux = await work?.tmux?.isAvailable().catch(() => false);

  if (isTmux) {
    const session = await work.tmux.sessionForProject(project.path).catch(() => null);
    if (session) {
      await work.tmux.newWindow(session, name, agent.command, project.path);
      const windows = await work.tmux.listWindows(session).catch(() => []);
      const win = windows.find((w) => w.name === name);
      const pane = await openTerminal(project, {
        cwd: project.path,
        title: name,
        tmuxSession: session,
        tmuxWindow: win ? win.id : null,
        tmuxName: name,
      });
      toast(`Aggiunto agente ${agent.name} alla sessione tmux.`);
      return pane;
    }
  }

  // Fallback
  const pane = await openTerminal(project, {
    cwd: project.path,
    title: name,
    command: agent.command,
    tmuxName: name,
  });
  toast(`Avviato agente ${agent.name}.`);
  return pane;
}

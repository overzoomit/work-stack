// Orchestrator for Multi-Agent Teams (PM, Dev1, Dev2..., QA1, QA2...) on tmux.
import { $, esc, leave, toast, ask } from './ui.js';
import { openTerminal, closeTerminal, focus, terminalsOf, syncProjectTerminals, updateTerminalAgentBadge } from './terminals.js';
import { AGENTS, commandFor } from './launcher.js';
import { agentBadgeFor, agentIdFromCommand } from './agentcatalog.js';
import { mcpSection } from './mcp.js';
import { TEAM_ROLES, roleFor } from './teamroles.js';
import { buildAgentGraph, agentGraphSvg } from './agent_graph.js';

export { TEAM_ROLES } from './teamroles.js';

const { work } = window;

const isRemote = (project) => !!project?.remote;
const tmuxReady = async (project) =>
  isRemote(project) || (await work?.tmux?.isAvailable().catch(() => false));
const tmuxSessionFor = (project) =>
  work.tmux.sessionForProject(project.path, project.remote || null);

let getProject = () => null;

let pop = null;
const waitingByProject = new Map();
const liveByProject = new Map();
// Pending dogwatch prompts per project, as last announced by the watcher:
// project path -> { session, pending }. The "Needs You" card reads this so it
// disappears as soon as an agent resumes, without waiting for another render.
const pendingByProject = new Map();
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

export function nextDocName(existingNames = []) {
  let highest = 0;
  for (const name of existingNames) {
    const m = String(name).match(/^doc(\d+)$/i);
    if (m) {
      const num = parseInt(m[1], 10);
      if (num > highest) highest = num;
    } else if (String(name).toLowerCase() === 'doc') {
      if (highest < 1) highest = 1;
    }
  }
  return `doc${highest + 1}`;
}

export function getDocMembers(existingNames = []) {
  return existingNames
    .filter((n) => /^doc(\d+)?$/i.test(n))
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

// ── Role skills: editable init prompts ───────────────────────
// Every role family owns a default profile. A project may override it from the
// Agent Team panel; templates keep {project_name} so the prompt follows a
// renamed project instead of freezing the old name inside the text.

// Workers never pick tickets from Plane on their own: two agents (or an agent and
// the PM) on the same ticket write the same files at the same time.
const STANDBY =
  " Non consultare Plane per cercare o auto-assegnarti ticket: lavori solo sul ticket che il PM (o plane-dogwatch per sua delega) ti assegna esplicitamente. Come prima risposta scrivi soltanto: 'Sono pronto e a disposizione del PM per ricevere un task.' e resta in attesa senza fare altro.";

export const ROLE_SKILLS = {
  pm: {
    name: 'Project Manager (PM)',
    text: "Sei il Project Manager del progetto {project_name} con oltre 30 anni di esperienza con metodologie Scrum e Agile. Coordini le priorità verso i Dev, i QA e i Doc usando l'istanza Plane, approvi le milestone e gestisci l'escalation. Sei l'unico ad assegnare i ticket: gli agenti restano in attesa finché non assegni loro un ticket, direttamente o tramite plane-dogwatch. Per lo stato della squadra usa python3 scripts/work-agent.py status (finestre, durata dello stato, ticket, domande pendenti e anomalie), python3 scripts/work-agent.py log [--window <finestra>] per lo storico degli eventi e python3 scripts/work-agent.py inspect <finestra> per la scheda di un agente. I messaggi [WATCHDOG] segnalano ticket orfani, agenti fermi o domande senza risposta.",
  },
  dev: {
    name: 'Developer (DEV)',
    text: "Sei uno sviluppatore software senior del progetto {project_name}. Sviluppi codice pulito, test unitari/integrazione ed esegui la suite npm test prima di promuovere i ticket in Test." + STANDBY,
  },
  qa: {
    name: 'QA Engineer (QA)',
    text: "Sei il QA Engineer del progetto {project_name}. Convalidi end-to-end e a runtime i ticket in stato Test, verificando l'assenza di regressioni e muovendo a Done con report in italiano o Re-open in caso di difetti." + STANDBY,
  },
  doc: {
    name: 'Documentation Specialist (DOC)',
    text: 'Sei il Documentation Specialist del progetto {project_name}. Ti occupi esclusivamente di redigere e aggiornare README.md, documentazione architetturale, guide utente e materiali di presentazione.' + STANDBY,
  },
  generic: {
    name: 'Generic Agent',
    text: 'Sei un assistente AI specializzato per task ad-hoc e supporto operativo al progetto {project_name}.' + STANDBY,
  },
};

export const ROLE_SKILL_ORDER = ['pm', 'dev', 'qa', 'doc', 'generic'];

// Window name -> role family (dev3 -> dev, generico -> generic).
export function skillFamily(name) {
  const n = String(name || '').trim().toLowerCase();
  if (n === 'pm') return 'pm';
  if (/^dev\d*$/.test(n)) return 'dev';
  if (/^qa\d*$/.test(n)) return 'qa';
  if (/^doc\d*$/.test(n)) return 'doc';
  if (/^(agent\d*|generico)$/.test(n)) return 'generic';
  return null;
}

export function defaultSkill(family) {
  return ROLE_SKILLS[family]?.text || null;
}

export function skillIsCustom(project, family) {
  return typeof project?.agentSkills?.[family] === 'string' && !!project.agentSkills[family].trim();
}

// The template for a role: the project's override, else the shipped default.
export function roleSkill(project, roleName) {
  const family = skillFamily(roleName);
  if (!family) return null;
  return skillIsCustom(project, family) ? project.agentSkills[family] : defaultSkill(family);
}

export function formatSkill(template, projectName) {
  if (!template) return '';
  return String(template).replaceAll('{project_name}', projectName || 'this project');
}

export function projectLabel(project) {
  if (!project) return 'this project';
  if (project.name) return project.name;
  const path = String(project.path || '').replace(/\/+$/, '');
  return path.split('/').pop() || 'this project';
}

// The text actually sent to a freshly started teammate.
export function initPromptFor(project, roleName) {
  const template = roleSkill(project, roleName);
  if (!template) return '';
  return formatSkill(template, projectLabel(project));
}

// Persistence is wired by app.js through initTeam: skills live in Work's
// project metadata, not in the repository, and follow local and SSH projects.
let persistProjects = null;

export function setRoleSkill(project, family, text, { persist = true } = {}) {
  if (!project || !ROLE_SKILLS[family]) return false;
  const value = String(text ?? '').trim();
  if (!value) return false;
  project.agentSkills = { ...(project.agentSkills || {}), [family]: value };
  if (persist) persistProjects?.();
  return true;
}

export function resetRoleSkill(project, family, { persist = true } = {}) {
  if (!project || !ROLE_SKILLS[family]) return false;
  const changed = !!project.agentSkills && Object.prototype.hasOwnProperty.call(project.agentSkills, family);
  if (project.agentSkills) delete project.agentSkills[family];
  if (changed && persist) persistProjects?.();
  return changed;
}

// Sending the profile too early would type into a TUI that is still starting.
export const INIT_PROMPT_DELAY = 1200;

export async function injectInitPrompt(project, roleName, session, { delay = INIT_PROMPT_DELAY } = {}) {
  const prompt = initPromptFor(project, roleName);
  if (!project || !roleName || !session || !prompt || !work?.tmux?.sendKeys) return false;
  if (delay > 0) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, delay);
      timer?.unref?.();
    });
  }
  try {
    await work.tmux.sendKeys(session, roleName, prompt, project.remote || null);
    return true;
  } catch {
    // The agent window may already be gone: never break the launch for this.
    return false;
  }
}

// Modal editor for a role family. Returns a small controller so tests and the
// UI share the same save/reset path.
let skillModal = null;

export function closeSkillEditor() {
  if (!skillModal) return;
  skillModal.el.remove();
  skillModal = null;
}

export function openSkillEditor(project, family) {
  const def = ROLE_SKILLS[family];
  if (!project || !def) return null;
  closeSkillEditor();

  const custom = skillIsCustom(project, family);
  const template = custom ? project.agentSkills[family] : def.text;
  const name = projectLabel(project);

  const el = document.createElement('div');
  el.className = 'modal skill-modal';
  el.innerHTML = `
    <form class="modal-card skill-card" id="skill-form">
      <p class="skill-title">
        <span>${esc(def.name)}</span>
        <span class="skill-tag${custom ? ' custom' : ''}">${custom ? 'Custom' : 'Default'}</span>
      </p>
      <p class="skill-hint">Sent as the init prompt to every new <b>${esc(def.name)}</b> terminal. <code>{project_name}</code> becomes <b>${esc(name)}</b>.</p>
      <textarea id="skill-text" rows="7" spellcheck="false">${esc(template)}</textarea>
      <div class="skill-preview">
        <span class="skill-preview-label">Preview</span>
        <div id="skill-preview-text">${esc(formatSkill(template, name))}</div>
      </div>
      <div class="commit-row">
        <button type="button" class="btn" id="skill-reset"${custom ? '' : ' disabled'}>Reset default</button>
        <div class="spacer"></div>
        <button type="button" class="btn" id="skill-cancel">Cancel</button>
        <button type="submit" class="btn btn-accent" id="skill-save">Save</button>
      </div>
    </form>`;
  document.body.appendChild(el);

  const textarea = el.querySelector('textarea');
  const preview = el.querySelector('#skill-preview-text');
  textarea.value = template;

  const updatePreview = () => {
    preview.textContent = formatSkill(textarea.value, name);
  };
  textarea.addEventListener('input', updatePreview);

  const close = () => {
    if (skillModal?.el === el) skillModal = null;
    el.remove();
  };
  const save = () => {
    const value = String(textarea.value || '').trim();
    if (!value) {
      toast('The skill prompt cannot be empty. Use Reset default to restore it.', { error: true });
      textarea.focus();
      return false;
    }
    setRoleSkill(project, family, value);
    close();
    toast(`${def.name} skill profile saved.`);
    return true;
  };
  const reset = () => {
    resetRoleSkill(project, family);
    close();
    toast(`${def.name} skill profile restored to the default.`);
    return true;
  };

  el.querySelector('#skill-save').onclick = (e) => {
    e.preventDefault();
    save();
  };
  el.querySelector('#skill-reset').onclick = (e) => {
    e.preventDefault();
    reset();
  };
  el.querySelector('#skill-cancel').onclick = close;
  el.querySelector('form').onsubmit = (e) => {
    e.preventDefault();
    save();
  };
  el.onkeydown = (e) => {
    if (e.key === 'Escape') {
      close();
      e.preventDefault();
      e.stopPropagation();
    }
  };
  el.onclick = (e) => {
    if (e.target === el) close();
  };

  skillModal = { el, family, textarea, preview, save, reset, close, updatePreview };
  textarea.focus();
  return skillModal;
}

// Dogwatch: the team button lights up while any agent waits for an answer.
function showWaiting(project, count) {
  waitingByProject.set(project, count);
  const total = [...waitingByProject.values()].reduce((a, b) => a + b, 0);
  const btn = $('#agent-team');
  btn?.classList.toggle('attention', total > 0);
  if (btn) btn.title = total > 0 ? `${total} agent(s) waiting for an answer` : 'Manage the agent team (PM, Dev1, Dev2, QA, Doc, Generic)';
}

// ── Needs You: pending dogwatch prompts ──────────────────────
// The watcher reports a flat { target, prompt_type, question, options } entry;
// an inspection reports the prompt on its own. Both shapes feed the same card.

export function needsYouEntries(pending = []) {
  return (pending || [])
    .map((entry) => (entry?.prompt ? { target: entry.target, ...entry.prompt } : entry))
    .filter((entry) => entry?.target);
}

function roleBadgeClass(name) {
  const family = skillFamily(name);
  return `tp-role-${family || 'generic'}`;
}

function isYesNoPrompt(entry) {
  if (entry.prompt_type === 'confirmation' || entry.prompt_type === 'permission') return true;
  const options = (entry.options || []).map((o) => String(o).toLowerCase());
  return options.includes('yes') && options.includes('no');
}

function needsYouCard(entry) {
  const target = entry.target;
  const question = entry.question || 'Waiting for answer';
  const quick = isYesNoPrompt(entry)
    ? `<button class="tp-needs-btn yes" data-act="dw-answer" data-target="${esc(target)}" data-answer="y">✓ Procedi (Sì)</button>
       <button class="tp-needs-btn no" data-act="dw-answer" data-target="${esc(target)}" data-answer="n">✕ Annulla (No)</button>`
    : '';
  return `
    <div class="tp-needs-card" data-needs-target="${esc(target)}">
      <div class="tp-needs-head">
        <span class="tp-status-dot waiting"></span>
        <span class="tp-role-badge ${roleBadgeClass(target)}">[${esc(String(target).toUpperCase())}]</span>
        <span class="tp-needs-type">${esc(entry.prompt_type || 'question')}</span>
        ${entry.relayed_to_pm ? '<span class="tp-needs-relay" title="The PM has this question">Relayed to PM</span>' : ''}
        <div class="spacer"></div>
        <button class="icon-btn tp-act-btn" data-act="dw-focus" data-target="${esc(target)}" title="Open the ${esc(target)} terminal">→</button>
      </div>
      <div class="tp-needs-question">${esc(question)}</div>
      <div class="tp-needs-actions">
        ${quick}
        <form class="tp-needs-form" data-dw-form data-target="${esc(target)}">
          <input class="tp-input tp-needs-input" data-dw-input name="answer" type="text" autocomplete="off" spellcheck="false" placeholder="Custom answer…" aria-label="Custom answer for ${esc(target)}">
          <button type="submit" class="tp-needs-btn send">Invia</button>
        </form>
      </div>
    </div>`;
}

export function needsYouHtml(pending = []) {
  const entries = needsYouEntries(pending);
  if (!entries.length) return '';
  return `
    <div class="tp-section tp-needs-you" data-needs-you>
      <div class="tp-section-head">
        <span>🔔 Richiede Attenzione / Needs You</span>
        <span class="tp-needs-count">${entries.length}</span>
      </div>
      ${entries.map(needsYouCard).join('')}
    </div>`;
}

// The quick buttons and the custom form share this path: the answer is typed
// literally into the target window, then the card is dropped at once instead
// of waiting for the next watcher tick.
export async function answerNeedsYou(project, target, text) {
  if (!project?.path || !target) return null;
  const known = pendingByProject.get(project.path);
  const session = known?.session || (await tmuxSessionFor(project).catch(() => null));
  if (!session) throw new Error('No tmux session for this project.');
  await work.dogwatch.answer(session, target, text);
  const current = pendingByProject.get(project.path) || { session, pending: [] };
  pendingByProject.set(project.path, {
    session,
    pending: current.pending.filter((p) => p.target !== target),
  });
  showWaiting(project.path, pendingByProject.get(project.path).pending.length);
  return session;
}

export function ledState(live, waiting) {
  if (!live) return 'off';
  return waiting > 0 ? 'escalation' : 'live';
}

const LED_TITLES = {
  off: () => 'Dogwatch off: no tmux session for this project',
  live: () => 'Dogwatch live: watching the agents of this project',
  escalation: (n) => `Dogwatch: ${n} agent(s) waiting for an answer`,
};

// Startup race: the first dogwatch update can fire before onUpdate is
// registered, and the watcher stays silent until something changes. A project
// with no known state is asked directly; an update that lands first wins.
const probing = new Set();
async function probeLive(path) {
  probing.add(path);
  const session = await work?.tmux?.sessionForProject(path).catch(() => null);
  const inspection = session ? await work?.dogwatch?.inspect(session).catch(() => null) : null;
  probing.delete(path);
  // The startup probe also corrects the badges before the first update.
  for (const win of inspection?.windows || []) updateTerminalAgentBadge(win.name, win.agent, path);
  if (liveByProject.has(path)) return;
  liveByProject.set(path, Boolean(inspection));
  showWaiting(path, inspection?.windows.filter((w) => w.prompt).length ?? 0);
  showLiveLed();
}

// The LED follows the active project: call it after a dogwatch update or a project switch.
export function showLiveLed() {
  const led = $('#dogwatch-led');
  if (!led) return;
  const p = getProject();
  const project = p?.path;
  // Remote sessions are not inspected by the local dogwatch process.
  if (project && isRemote(p)) {
    liveByProject.set(project, false);
    waitingByProject.set(project, 0);
  } else if (project && !liveByProject.has(project) && !probing.has(project)) {
    probeLive(project);
  }
  const waiting = waitingByProject.get(project) || 0;
  const state = ledState(liveByProject.get(project) === true, waiting);
  led.dataset.state = state;
  led.title = LED_TITLES[state](waiting);
  led.querySelector('.led-label').textContent = state === 'off' ? 'Off' : 'Live';
}

export function statusBadge(states, name) {
  const entry = stateEntry(states.get(name));
  if (!entry) return '<span class="tp-badge-status active">Active</span>';
  if (entry.state === 'blocked') {
    const question = entry.prompt?.question || entry.rule || 'Waiting for answer';
    return `<span class="tp-badge-status waiting" title="${esc(question)}">Waiting for answer</span>`;
  }
  if (entry.state === 'working') {
    return '<span class="tp-badge-status working" title="Agent is working"><span class="tp-spinner" aria-hidden="true"></span>Working</span>';
  }
  if (entry.state === 'ready') {
    return '<span class="tp-badge-status ready" title="In the team, waiting for a task">Ready</span>';
  }
  return '<span class="tp-badge-status idle" title="Agent is idle">Idle</span>';
}

// Accept both the new { state, prompt } records and a bare prompt object.
function stateEntry(entry) {
  if (!entry) return null;
  if (entry.state) return entry;
  return entry.prompt_type ? { state: 'blocked', prompt: entry } : null;
}

const dotClass = (states, name) => {
  const state = stateEntry(states.get(name))?.state;
  return state === 'blocked' ? 'waiting' : state === 'working' ? 'working' : 'idle';
};

// The CLI really running in the window (OpenCode, Claude Code…) instead of the
// default hardcoded in the role. `agents` maps window name -> agent id.
export function agentLabel(agents, name) {
  const badge = agentBadgeFor(agents?.get?.(name));
  return badge?.name || null;
}

function roleDescription(agents, name, fallback) {
  const agent = agentLabel(agents, name);
  return `<div class="tp-desc">${agent ? `<span class="tp-agent-name">${esc(agent)}</span> · ` : ''}${fallback} · Click to view</div>`;
}

// The Plane ticket a window is working on, as the plane dogwatch delegated it.
export function ticketLine(assignments, name) {
  const a = assignments.find((x) => x.window === name);
  if (!a) return '';
  return `<div class="tp-ticket" title="${esc(a.name)}">Ticket [${esc(a.issue ?? '?')}]: ${esc(a.state)}</div>`;
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

const ANOMALY_LABELS = { orphan_ticket: 'Orphan ticket', frozen_working: 'Frozen', long_blocked: 'Long wait' };

// How long the window has been in its state, the last line it printed and
// the watchdog anomalies, from the shared .claude/work.db snapshot.
export function activityLine(snapshot, name, now = Date.now() / 1000) {
  const win = snapshot?.windows?.find((w) => w.name === name);
  const anomalies = (snapshot?.anomalies ?? []).filter((a) => a.window_name === name);
  if (!win && !anomalies.length) return '';
  const badges = anomalies
    .map((a) => `<span class="tp-anomaly" title="${esc(a.message)}">⚠ ${esc(ANOMALY_LABELS[a.kind] ?? a.kind)}</span>`)
    .join('');
  const since = win?.state_changed_at != null
    ? `<span class="tp-duration" data-since="${Number(win.state_changed_at)}">for ${formatDuration(now - win.state_changed_at)}</span>`
    : '';
  const line = win?.last_activity_line
    ? `<span class="tp-last-line" title="${esc(win.last_activity_line)}">${esc(win.last_activity_line)}</span>`
    : '';
  return `<div class="tp-activity">${badges}${since}${since && line ? ' · ' : ''}${line}</div>`;
}

// Durations move every second from the start time each span carries: no IPC
// and no re-render, so a half-typed field or the MCP probe are left alone.
export function tickDurations(root, now = Date.now() / 1000) {
  for (const el of root?.querySelectorAll?.('[data-since]') ?? []) {
    el.textContent = `for ${formatDuration(now - Number(el.dataset.since))}`;
  }
}
let durationTicker = null;

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
    'Multi-project controls from your single Telegram chat:',
    '• Reply to any message: routes directly to the PM of that project.',
    '• @project <message>: sends directly to that project\'s PM.',
    '• /projects: lists all open projects in Work.',
    '• /use <project>: locks the channel to a project (/use auto to follow Work\'s UI).',
    '• /status: checks current bot mode and target session.',
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
  const targetLabel = status?.targetProject || status?.activeProject || status?.project || 'active project';
  const modeInfo = status?.isPinned
    ? `Target: <b>${esc(targetLabel)}</b> (pinned)`
    : `Target: <b>${esc(targetLabel)}</b> (auto)`;
  return `
    <div class="tp-telegram">
      <div class="tp-telegram-head">
        <span class="tp-telegram-title">✈️ Telegram Bot</span>
        <span class="tp-badge-status ${connected ? 'active' : ''}">${esc(telegramLabel(status))}</span>
        <div class="spacer"></div>
        <button class="icon-btn tp-act-btn" data-act="telegram-info" title="Guide: create the bot with @BotFather">Info</button>
      </div>
      ${connected ? `
        <div class="tp-telegram-meta">Chat <b>${esc(status.chatId)}</b> · ${modeInfo}</div>
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
  if (isRemote(project)) {
    toast('Telegram is available for local projects only.', { error: true });
    return;
  }
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
  lastMcpHtml = mcpSection(await work.mcp?.status().catch(() => null));
  body.innerHTML = lastMcpHtml;
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

export function initTeam({ activeProject, saveProjects = null }) {
  getProject = activeProject;
  persistProjects = saveProjects;
  if (!durationTicker) {
    durationTicker = setInterval(() => pop && tickDurations(pop), 1000);
    durationTicker?.unref?.();
  }
  work?.dogwatch?.onUpdate((project, session, pending = [], live, windows = []) => {
    liveByProject.set(project, live === true);
    pendingByProject.set(project, { session, pending: pending || [] });
    showWaiting(project, pending.length);
    // The real agent detected in each pane wins over the static role default.
    for (const win of windows || []) updateTerminalAgentBadge(win.name, win.agent, project);
    showLiveLed();
    // Open popover: badges and count follow, without probing MCP again or
    // interrupting the agent picker or a half-typed field. The graph has no
    // inputs, so it always repaints to keep nodes and particles live.
    const typing = document.activeElement?.tagName === 'INPUT';
    if (pop && project === getProject()?.path) {
      if (viewState.mode === 'graph') renderPopContent(false);
      else if (viewState.mode === 'main' && !typing) renderPopContent(false);
    }
  });
  work?.planeDogwatch?.onUpdate((report) => {
    const typing = document.activeElement?.tagName === 'INPUT';
    if (pop && report.project === getProject()?.path) {
      if (viewState.mode === 'graph' || !typing) renderPopContent(false);
    }
  });
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
  closeSkillEditor();
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
  // Clicks inside the skill editor belong to its modal, not to the popover.
  if (e.target?.closest?.('.modal')) return;
  if (pop && !pop.contains(e.target) && !$('#agent-team')?.contains(e.target)) {
    closeTeamMenu();
  }
}

function onKey(e) {
  if (!pop) return;
  // The editor owns Escape while it is open.
  if (skillModal) return;
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

  const isTmux = await tmuxReady(project);
  if (isTmux) {
    const session = await tmuxSessionFor(project).catch(() => null);
    if (session) {
      const windows = await work.tmux.listWindows(session, project.remote || null).catch(() => []);
      const win = windows.find((w) => w.name === roleName);
      if (win) {
        const roleDef = roleFor(roleName);
        return openTerminal(project, {
          cwd: win.path || project.path,
          title: win.name,
          tmuxSession: session,
          tmuxWindow: win.id,
          tmuxName: win.name,
          role: roleName,
          agentId: agentIdFromCommand(win.startCommand, win.currentCommand) || roleDef?.agentId || null,
          command: roleDef?.command || null,
        });
      }
    }
  }
  return null;
}

// Terminates a team role window and closes its UI pane
// The shared .claude/work.db learns about a teammate at once, not at the next
// dogwatch look: added as ready, removed with what was open for it. Remote
// projects keep no local database.
export function registerMember(project, session, name, windowId, agentId, command) {
  if (!project || isRemote(project) || !work?.state?.registerMember) return Promise.resolve();
  const model = /(?:^|\s)(?:--model|-m)(?:=|\s+)["']?([^\s"']+)/.exec(command || '')?.[1] || null;
  return work.state
    .registerMember(project.path, session || '', name, windowId || null, skillFamily(name) || 'generic', agentId || 'generic', command || null, model)
    .catch(() => {});
}

export function removeMember(project, name) {
  if (!project || isRemote(project) || !work?.state?.removeMember) return Promise.resolve();
  return work.state.removeMember(project.path, name).catch(() => {});
}

export async function killTeamRole(project, roleName) {
  if (!project || !roleName) return;
  removeMember(project, roleName);
  const isTmux = await tmuxReady(project);
  if (isTmux) {
    const session = await tmuxSessionFor(project).catch(() => null);
    if (session) {
      const windows = await work.tmux.listWindows(session, project.remote || null).catch(() => []);
      const win = windows.find((w) => w.name === roleName);
      if (win) {
        await work.tmux.killWindow(session, win.id, project.remote || null).catch(() => {});
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
  const isTmux = await tmuxReady(project);

  if (isTmux) {
    const session = await tmuxSessionFor(project).catch(() => null);
    if (session) {
      await work.tmux.ensureSession(session, project.remote?.remotePath || project.path, project.remote || null).catch(() => {});
      const windows = await work.tmux.listWindows(session, project.remote || null).catch(() => []);
      const existingWin = windows.find((w) => w.name === roleName);
      if (existingWin) {
        await work.tmux.killWindow(session, existingWin.id, project.remote || null).catch(() => {});
      }
      const existingPane = terminalsOf(project).find((t) => t.tmuxName === roleName || t.title === roleName);
      if (existingPane) {
        closeTerminal(existingPane.id);
      }
      const newWinId = await work.tmux.newWindow(session, roleName, project.remote?.remotePath || project.path, cmd, project.remote || null);
      registerMember(project, session, roleName, newWinId, agent.id, cmd);
      const pane = await openTerminal(project, {
        cwd: project.remote?.remotePath || project.path,
        title: roleName,
        tmuxSession: session,
        tmuxWindow: newWinId || roleName,
        tmuxName: roleName,
        role: roleName,
        agentId: agent.id,
        command: cmd,
      });
      // The profile is sent once the TUI is up: a new teammate starts with
      // its role instructions already in the prompt.
      injectInitPrompt(project, roleName, session).catch(() => {});
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
    cwd: project.remote?.remotePath || project.path,
    title: roleName,
    command: cmd,
    tmuxName: roleName,
    role: roleName,
    agentId: agent.id,
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

  const isTmux = await tmuxReady(project);
  let session = null;
  let tmuxWindows = [];
  if (isTmux) {
    session = await tmuxSessionFor(project).catch(() => null);
    if (session) {
      tmuxWindows = await work.tmux.listWindows(session, project.remote || null).catch(() => []);
      tmuxWindows.forEach((w) => {
        if (w.name) names.add(w.name);
      });
    }
  }

  const inspection = session && !isRemote(project)
    ? await work.dogwatch?.inspect(session).catch(() => null)
    : null;
  const windows = inspection?.windows ?? [];
  // The PM answers escalations: show its state, but do not count its own
  // prompt as an agent waiting for the PM.
  const prompts = new Map(windows.filter((w) => w.prompt && w.name !== 'pm').map((w) => [w.name, w.prompt]));
  const states = new Map(windows.map((w) => [w.name, w]));
  // Dogwatch wins; an open pane covers remote projects and the first tick.
  const agents = new Map(openPanes.filter((p) => p.tmuxName && p.agentId).map((p) => [p.tmuxName, p.agentId]));
  for (const w of windows) if (w.agent) agents.set(w.name, w.agent);

  return { isTmux, session, tmuxWindows, openPanes, prompts, states, agents, names: [...names] };
}

// Visible switch between the classic list and the Mission Control canvas.
export function viewToggle(mode) {
  return `
    <div class="tp-view-toggle" role="tablist" aria-label="Team view">
      <button class="tp-view-btn${mode === 'main' ? ' active' : ''}" data-act="view-main" role="tab" aria-selected="${mode === 'main'}">☰ Team</button>
      <button class="tp-view-btn${mode === 'graph' ? ' active' : ''}" data-act="view-graph" role="tab" aria-selected="${mode === 'graph'}">🛰 Mission Control</button>
    </div>`;
}

// Renders the popover content based on current viewState. `probeMcp: false`
// keeps the last MCP result instead of probing again.
let lastMcpHtml = null;
async function renderPopContent(probeMcp = true) {
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

  // Mission Control: same snapshot as the list, drawn as a live node canvas.
  if (viewState.mode === 'graph') {
    const { isTmux, session, states, agents, names } = await getExistingNames(p);
    const plane = await work?.planeDogwatch?.status().catch(() => null);
    const assignments = plane?.projects?.find((r) => r.project === p.path)?.assignments ?? [];
    const graph = buildAgentGraph({ names, states, agents, assignments });
    pop.innerHTML = `
      <header class="tp-head">
        <div class="tp-title">
          <span>🛰 Mission Control</span>
          <button class="icon-btn" data-act="close" title="Close (Esc)">✕</button>
        </div>
        <div class="tp-sub">
          ${names.length} agent(s) · live graph${isTmux ? ` · tmux <b>${esc(session || 'inactive')}</b>` : ''} · click a node to open its terminal
        </div>
        ${viewToggle('graph')}
      </header>
      <div class="tp-graph-wrap">${agentGraphSvg(graph)}</div>
      <div class="tp-graph-legend">
        <span><i class="ag-legend-dot idle"></i>Idle</span>
        <span><i class="ag-legend-dot working"></i>Working</span>
        <span><i class="ag-legend-dot blocked"></i>Needs You</span>
      </div>
      <div class="tp-actions">
        <button class="tp-btn-secondary" data-act="sync-team" style="flex:1;">↻ Sync tmux windows</button>
      </div>`;
    return;
  }

  // Main squad view
  const { isTmux, session, tmuxWindows, prompts, states, agents, names } = await getExistingNames(p);
  const pending = pendingByProject.get(p.path)?.pending
    ?? [...prompts].map(([target, prompt]) => ({ target, ...prompt }));
  // The first render can happen before the watcher ticks: remember what the
  // inspection saw so answerNeedsYou has a session and the card is reactive.
  if (!pendingByProject.has(p.path)) pendingByProject.set(p.path, { session, pending });

  const pmActive = hasPm(names);
  const devList = getDevMembers(names);
  const qaList = getQaMembers(names);
  const docList = getDocMembers(names);
  const agentList = getAgentMembers(names);

  const nextDev = nextDevName(names);
  const nextQa = nextQaName(names);
  const nextDoc = nextDocName(names);
  const nextAgent = nextAgentName(names);
  const telegram = pmActive && work?.telegram?.status ? await work.telegram.status().catch(() => null) : null;
  const plane = await work?.planeDogwatch?.status().catch(() => null);
  const assignments = plane?.projects.find((r) => r.project === p.path)?.assignments ?? [];
  const snapshot = isRemote(p) ? null : await work?.state?.snapshot(p.path).catch(() => null);
  // Only the shared database knows "ready": tmux alone sees an idle prompt.
  for (const w of snapshot?.windows ?? []) {
    if (w.state === 'ready' && states.get(w.name)?.state === 'idle') states.set(w.name, { ...states.get(w.name), state: 'ready' });
  }

  pop.innerHTML = `
    <header class="tp-head">
      <div class="tp-title">
        <span>👥 Agent Team</span>
        <button class="icon-btn" data-act="close" title="Close (Esc)">✕</button>
      </div>
      <div class="tp-sub">
        ${isTmux ? `tmux session: <b>${esc(session || 'inactive')}</b> · ${tmuxWindows.length} windows${pending.length ? ` · <b class="tp-waiting">${pending.length} waiting for an answer</b>` : ''}` : 'Standard terminal mode (tmux not available)'}
      </div>
      ${viewToggle('main')}
    </header>

    <div class="tp-list">
      ${needsYouHtml(pending)}
      <!-- PM section: only one -->
      <div class="tp-section">
        <div class="tp-section-head">
          <span>👑 Project Manager (PM - 1 only)</span>
          <span class="tp-head-right">
            <span style="font-size:10px;font-weight:normal;color:var(--text-2);">${pmActive ? 'Assigned' : 'Not configured'}</span>
            <button class="tp-skill-btn tp-info-btn" data-act="edit-skill" data-family="pm" title="View and edit the PM skill prompt">Skill</button>
          </span>
        </div>
        ${pmActive ? `
          <div class="tp-row" data-focus-role="pm" title="Click to open the PM terminal">
            <span class="tp-status-dot ${dotClass(states, 'pm')}"></span>
            <span class="tp-role-badge tp-role-pm">[PM]</span>
            <div class="tp-info">
              <div class="tp-name">
                <span>pm</span>
                ${statusBadge(states, 'pm')}
              </div>
              ${roleDescription(agents, 'pm', 'Senior PM &amp; Architect')}
              ${activityLine(snapshot, 'pm')}
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
          <button class="tp-skill-btn tp-info-btn" data-act="edit-skill" data-family="dev" title="View and edit the DEV skill prompt">Skill</button>
        </div>
        ${devList.map((devName) => `
          <div class="tp-row" data-focus-role="${esc(devName)}" title="Click to open the ${esc(devName)} terminal">
            <span class="tp-status-dot ${dotClass(states, devName)}"></span>
            <span class="tp-role-badge tp-role-dev">[${esc(devName.toUpperCase())}]</span>
            <div class="tp-info">
              <div class="tp-name">
                <span>${esc(devName)}</span>
                ${statusBadge(states, devName)}
              </div>
              ${roleDescription(agents, devName, 'Developer')}
              ${ticketLine(assignments, devName)}
              ${activityLine(snapshot, devName)}
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
          <button class="tp-skill-btn tp-info-btn" data-act="edit-skill" data-family="qa" title="View and edit the QA skill prompt">Skill</button>
        </div>
        ${qaList.map((qaName) => `
          <div class="tp-row" data-focus-role="${esc(qaName)}" title="Click to open the ${esc(qaName)} terminal">
            <span class="tp-status-dot ${dotClass(states, qaName)}"></span>
            <span class="tp-role-badge tp-role-qa">[${esc(qaName.toUpperCase())}]</span>
            <div class="tp-info">
              <div class="tp-name">
                <span>${esc(qaName)}</span>
                ${statusBadge(states, qaName)}
              </div>
              ${roleDescription(agents, qaName, 'QA Engineer')}
              ${ticketLine(assignments, qaName)}
              ${activityLine(snapshot, qaName)}
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

      <!-- Documentation section: between QA and Generic -->
      <div class="tp-section">
        <div class="tp-section-head">
          <span>📝 Documentation (${docList.length} active)</span>
          <button class="tp-skill-btn tp-info-btn" data-act="edit-skill" data-family="doc" title="View and edit the DOC skill prompt">Skill</button>
        </div>
        ${docList.map((docName) => `
          <div class="tp-row" data-focus-role="${esc(docName)}" title="Click to open the ${esc(docName)} terminal">
            <span class="tp-status-dot ${dotClass(states, docName)}"></span>
            <span class="tp-role-badge tp-role-doc">[${esc(docName.toUpperCase())}]</span>
            <div class="tp-info">
              <div class="tp-name">
                <span>${esc(docName)}</span>
                ${statusBadge(states, docName)}
              </div>
              ${roleDescription(agents, docName, 'Documentation Specialist')}
              ${ticketLine(assignments, docName)}
              ${activityLine(snapshot, docName)}
            </div>
            <div class="tp-row-actions">
              <button class="icon-btn tp-act-btn" data-act="kill-role" data-role="${esc(docName)}" title="Terminate window ${esc(docName)}">✕</button>
            </div>
          </div>
        `).join('')}
        <button class="tp-add-btn doc" data-act="add-doc" data-next="${esc(nextDoc)}">
          ＋ Add Doc (${esc(nextDoc)})
        </button>
      </div>

      <!-- Generic section: ad-hoc members (agent1, agent2...) with a CLI agent of choice -->
      <div class="tp-section">
        <div class="tp-section-head">
          <span>🤖 Generic (${agentList.length} active)</span>
          <button class="tp-skill-btn tp-info-btn" data-act="edit-skill" data-family="generic" title="View and edit the generic agent skill prompt">Skill</button>
        </div>
        ${agentList.map((agentName) => `
          <div class="tp-row" data-focus-role="${esc(agentName)}" title="Click to open the ${esc(agentName)} terminal">
            <span class="tp-status-dot ${dotClass(states, agentName)}"></span>
            <span class="tp-role-badge tp-role-generic">[${esc(agentName.toUpperCase())}]</span>
            <div class="tp-info">
              <div class="tp-name">
                <span>${esc(agentName)}</span>
                ${statusBadge(states, agentName)}
              </div>
              ${roleDescription(agents, agentName, 'Generic agent')}
              ${ticketLine(assignments, agentName)}
              ${activityLine(snapshot, agentName)}
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
        <div class="tp-mcp-body">${(!probeMcp && lastMcpHtml) || '<div class="tp-desc">Checking…</div>'}</div>
      </div>
    </div>

    <div class="tp-actions">
      <button class="tp-btn-secondary" data-act="sync-team" style="flex:1;">
        ↻ Sync tmux windows
      </button>
    </div>
  `;
  if (probeMcp || !lastMcpHtml) refreshMcp();
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
    if (act === 'view-graph' || act === 'view-main') {
      viewState.mode = act === 'view-graph' ? 'graph' : 'main';
      await renderPopContent();
      return;
    }
    if (act === 'sync-team') {
      const reattached = await syncProjectTerminals(p);
      toast(reattached.length ? `Reattached ${reattached.length} tmux windows.` : 'All windows are already in sync.');
      await renderPopContent();
      return;
    }

    if (act === 'dw-answer') {
      const data = e.target.closest('[data-target]')?.dataset;
      const target = data?.target;
      if (!target) return;
      try {
        await answerNeedsYou(p, target, data.answer ?? '');
        await renderPopContent(false);
        toast(`Answer sent to ${target}.`);
      } catch (err) {
        toast(err?.message || String(err), { error: true });
      }
      return;
    }

    if (act === 'dw-focus') {
      const target = e.target.closest('[data-target]')?.dataset.target;
      if (!target) return;
      closeTeamMenu();
      await openOrFocusRole(p, target);
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

    if (act === 'edit-skill') {
      const family = e.target.closest('[data-family]')?.dataset.family;
      if (family) openSkillEditor(p, family);
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

    if (act === 'add-doc') {
      const { names } = await getExistingNames(p);
      const docName = nextDocName(names);
      viewState = {
        mode: 'select-agent',
        targetRoleName: docName,
        targetRoleLabel: `Choose which CLI agent to activate for documentation specialist ${docName.toUpperCase()}:`,
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

    // Mission Control node: jump straight to the agent's terminal.
    const graphNode = e.target.closest?.('[data-graph-node]');
    if (graphNode) {
      const roleName = graphNode.dataset.graphNode;
      if (!roleName) return;
      closeTeamMenu();
      await openOrFocusRole(p, roleName);
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

  // Keyboard users get the same jump-to-terminal behaviour as a click.
  pop.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const graphNode = e.target?.closest?.('[data-graph-node]');
    if (!graphNode) return;
    e.preventDefault();
    const roleName = graphNode.dataset.graphNode;
    if (!roleName) return;
    closeTeamMenu();
    await openOrFocusRole(p, roleName);
  });

  // The Needs You custom form and the PM connection form both submit here.
  pop.addEventListener('submit', async (e) => {
    const needsForm = e.target.closest?.('[data-dw-form]');
    if (needsForm) {
      e.preventDefault();
      const target = needsForm.dataset.target;
      const input = e.target.querySelector('[data-dw-input]');
      const text = String(input?.value ?? '').trim();
      if (!text) {
        input?.focus?.();
        return;
      }
      try {
        await answerNeedsYou(p, target, text);
        await renderPopContent(false);
        toast(`Answer sent to ${target}.`);
      } catch (err) {
        toast(err?.message || String(err), { error: true });
      }
      return;
    }
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

  const isTmux = await tmuxReady(project);
  if (isTmux) {
    const session = await tmuxSessionFor(project).catch(() => null);
    if (session) {
      const windows = await work.tmux.listWindows(session, project.remote || null).catch(() => []);
      const win = windows.find((w) => w.name === role.name);
      const roleDef = roleFor(role.name);
      const detectedAgentId = agentIdFromCommand(win?.startCommand, win?.currentCommand);
      const meta = {
        role: role.name,
        agentId: detectedAgentId || role.agentId || roleDef?.agentId || null,
        command: role.command || roleDef?.command || null,
      };
      if (win) {
        return openTerminal(project, {
          cwd: win.path || project.path,
          title: win.name,
          tmuxSession: session,
          tmuxWindow: win.id,
          tmuxName: win.name,
          ...meta,
        });
      } else {
        await work.tmux.newWindow(session, role.name, project.remote?.remotePath || project.path, role.command, project.remote || null);
        const updated = await work.tmux.listWindows(session, project.remote || null).catch(() => []);
        const newWin = updated.find((w) => w.name === role.name);
        registerMember(project, session, role.name, newWin?.id, meta.agentId, role.command);
        const pane = await openTerminal(project, {
          cwd: project.remote?.remotePath || project.path,
          title: role.name,
          tmuxSession: session,
          tmuxWindow: newWin ? newWin.id : null,
          tmuxName: role.name,
          ...meta,
        });
        injectInitPrompt(project, role.name, session).catch(() => {});
        return pane;
      }
    }
  }

  // Fallback without tmux
  return openTerminal(project, {
    cwd: project.remote?.remotePath || project.path,
    title: role.name,
    command: role.command,
    tmuxName: role.name,
    role: role.name,
    agentId: role.agentId || roleFor(role.name)?.agentId || null,
  });
}

// Initializes the entire squad: pm, dev1, dev2, qa
export async function initializeTeam(project) {
  if (!project) return [];
  const isTmux = await tmuxReady(project);
  const panes = [];

  if (isTmux) {
    const session = await tmuxSessionFor(project).catch(() => null);
    if (session) {
      const windows = await work.tmux.listWindows(session, project.remote || null).catch(() => []);
      for (const role of TEAM_ROLES) {
        const exists = windows.some((w) => w.name === role.name);
        if (!exists) {
          const winId = await work.tmux.newWindow(session, role.name, project.remote?.remotePath || project.path, role.command, project.remote || null);
          registerMember(project, session, role.name, winId, role.agentId, role.command);
          injectInitPrompt(project, role.name, session).catch(() => {});
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

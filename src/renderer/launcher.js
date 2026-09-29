// "✦ Agente" menu: launch any installed agent CLI in the active project.
import { $, esc, leave } from './ui.js';
import { openTerminal, sendInput } from './terminals.js';

const { work } = window;

let installed = null; // Set of available binaries

// Each agent that has a "skip every confirmation" switch can be started with
// it: a flag next to its name in the menu, remembered per agent. Claude Code
// starts with it on (user preference); the others start off.
const BYPASS_DEFAULT = { claude: true };

export const AGENTS = [
  { id: 'claude', name: 'Claude Code', by: 'Anthropic', desc: 'Agente di coding nel terminale', mono: 'C', tint: ['#e08a67', '#c2573a'], bin: 'claude', command: 'claude', bypass: '--dangerously-skip-permissions', install: 'curl -fsSL https://claude.ai/install.sh | bash', continueCommand: 'claude --continue' },
  { id: 'codex', name: 'Codex', by: 'OpenAI', desc: 'Agente CLI di OpenAI', mono: 'Cx', tint: ['#5b6272', '#2b2f38'], bin: 'codex', command: 'codex', bypass: '--dangerously-bypass-approvals-and-sandbox', install: 'npm i -g @openai/codex' },
  { id: 'gemini', name: 'Gemini CLI', by: 'Google', desc: 'Agente open source di Google', mono: 'G', tint: ['#5b8cff', '#8a5cf6'], bin: 'gemini', command: 'gemini', bypass: '--yolo', install: 'npm i -g @google/gemini-cli' },
  { id: 'copilot', name: 'Copilot CLI', by: 'GitHub', desc: 'Copilot nel terminale', mono: 'Co', tint: ['#a371f7', '#6e40c9'], bin: 'copilot', command: 'copilot', bypass: '--allow-all-tools', install: 'npm i -g @github/copilot' },
  { id: 'opencode', name: 'OpenCode', by: 'Open source', desc: 'Agente multi-modello', mono: 'OC', tint: ['#4fb3bf', '#2d6f86'], bin: 'opencode', command: 'opencode', install: 'npm i -g opencode-ai' },
  { id: 'aider', name: 'Aider', by: 'Open source', desc: 'Pair programming con git', mono: 'Ai', tint: ['#4cc38a', '#23875a'], bin: 'aider', command: 'aider', bypass: '--yes-always', install: 'pipx install aider-chat' },
  { id: 'cursor-agent', name: 'Cursor Agent', by: 'Cursor', desc: "L'agente di Cursor da terminale", mono: 'Cu', tint: ['#6f7480', '#1c1e24'], bin: 'cursor-agent', command: 'cursor-agent', bypass: '--force', install: 'curl https://cursor.com/install -fsS | bash' },
  { id: 'amp', name: 'Amp', by: 'Sourcegraph', desc: 'Agente di coding di Sourcegraph', mono: 'A', tint: ['#ff6b6b', '#c92a5a'], bin: 'amp', command: 'amp', bypass: '--dangerously-allow-all', install: 'npm i -g @sourcegraph/amp' },
  { id: 'qwen', name: 'Qwen Code', by: 'Alibaba', desc: 'Agente basato su Qwen', mono: 'Q', tint: ['#7c83ff', '#4b3fd6'], bin: 'qwen', command: 'qwen', bypass: '--yolo', install: 'npm i -g @qwen-code/qwen-code' },
  { id: 'goose', name: 'Goose', by: 'Block', desc: 'Agente open source estendibile', mono: 'Go', tint: ['#f5b53d', '#c47a12'], bin: 'goose', command: 'goose session', install: 'curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | bash' },
];

let bypassState = {};
try {
  bypassState = JSON.parse(localStorage.getItem('work.agent.bypass') || '{}') || {};
} catch {
  // no storage: defaults only, kept in memory
}

export function bypassOn(a) {
  if (!a.bypass) return false;
  return bypassState[a.id] ?? !!BYPASS_DEFAULT[a.id];
}

export function setBypass(a, on) {
  bypassState[a.id] = on;
  try {
    localStorage.setItem('work.agent.bypass', JSON.stringify(bypassState));
  } catch {
    // no storage: the choice lasts until Work closes
  }
}

// The command an agent starts with, with its bypass flag when switched on.
export function commandFor(a, base = a.command) {
  return bypassOn(a) ? `${base} ${a.bypass}` : base;
}

const badgeFor = (a) => (bypassOn(a) ? { text: 'bypass permessi', title: `Avviato con ${a.bypass}: nessuna richiesta di conferma` } : null);

let getProject = () => null;

function lastUsed() {
  try {
    return localStorage.getItem('work.agent') || 'claude';
  } catch {
    return 'claude';
  }
}
function remember(id) {
  try {
    localStorage.setItem('work.agent', id);
  } catch {
    // no storage: default stays Claude Code
  }
}

// The menu must open instantly: start from the last known list (cached) and
// refresh it in the background through a login shell (~1 s).
try {
  const cached = JSON.parse(localStorage.getItem('work.agents.installed') || 'null');
  if (Array.isArray(cached)) installed = new Set(cached);
} catch {
  // no cache yet
}
let pending = null;
function refreshInstalled() {
  pending ??= work.agents.available([...new Set(AGENTS.map((a) => a.bin))]).then((list) => {
    installed = new Set(list);
    pending = null;
    try {
      localStorage.setItem('work.agents.installed', JSON.stringify(list));
    } catch {
      // cache is optional
    }
  });
  return pending;
}

export function initLauncher({ activeProject }) {
  getProject = activeProject;
  refreshInstalled();
  $('#new-agent').onpointerdown = (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (pop) closePop();
    else openMenu();
  };
}

export function launch(agent, project = getProject(), extra = {}) {
  if (!project) return;
  remember(agent.id);
  return openTerminal(project, {
    command: commandFor(agent),
    title: agent.name,
    kind: 'agent',
    badge: badgeFor(agent),
    ...extra,
  });
}

// Ctrl+Shift+A: start the agent used last time without opening the menu.
export function launchDefault() {
  const a = AGENTS.find((x) => x.id === lastUsed()) || AGENTS[0];
  if (installed && !installed.has(a.bin)) return openMenu();
  launch(a);
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Resume a Claude Code session from the agents list. The id is interpolated
// into a shell command, so it must be a plain UUID.
export function resumeClaude(project, cwd, sessionId, title) {
  if (!SESSION_ID.test(sessionId)) throw new Error(`ID di sessione non valido: ${sessionId}`);
  const claude = AGENTS[0];
  return openTerminal(project, {
    cwd,
    command: commandFor(claude, `claude --resume ${sessionId}`),
    title,
    kind: 'agent',
    badge: badgeFor(claude),
  });
}

// ── Popover ──────────────────────────────────────────────────
let pop = null;
let hi = 0; // highlighted row (shared by pointer and keyboard)

function closePop() {
  if (!pop) return;
  const el = pop;
  pop = null;
  $('#new-agent').classList.remove('open');
  removeEventListener('keydown', onKey, true);
  removeEventListener('pointerdown', onOutside, true);
  leave(el, () => el.remove());
}

function onOutside(e) {
  if (pop && !pop.contains(e.target) && !$('#new-agent').contains(e.target)) closePop();
}

function rows() {
  return pop ? [...pop.querySelectorAll('.ap-row:not(.missing)')] : [];
}

function highlight(i) {
  const list = rows();
  if (!list.length) return;
  hi = (i + list.length) % list.length;
  list.forEach((r, k) => r.classList.toggle('hi', k === hi));
  list[hi].scrollIntoView({ block: 'nearest' });
}

function onKey(e) {
  if (!pop) return;
  const list = rows();
  const act = {
    ArrowDown: () => highlight(hi + 1),
    ArrowUp: () => highlight(hi - 1),
    Enter: () => list[hi]?.click(),
    Escape: () => closePop(),
    b: () => list[hi]?.querySelector('[data-bypass]')?.click(),
  }[e.key.length === 1 ? e.key.toLowerCase() : e.key];
  if (act) {
    act();
  } else if (/^[1-9]$/.test(e.key) && list[Number(e.key) - 1]) {
    list[Number(e.key) - 1].click();
  } else return;
  e.preventDefault();
  e.stopPropagation();
}

function tile(a) {
  return `<span class="ap-tile" style="--t1:${a.tint[0]};--t2:${a.tint[1]}">${esc(a.mono)}</span>`;
}

// The flag next to an agent's name: a small toggle, orange when on.
function flag(a) {
  if (!a.bypass) return '';
  const on = bypassOn(a);
  return `<button class="ap-flag${on ? ' on' : ''}" data-bypass aria-pressed="${on}" title="${esc(flagTitle(a, on))}"><i></i>bypass</button>`;
}
const flagTitle = (a, on) => `${on ? 'Parte senza chiedere conferme' : 'Chiede conferma prima di agire'} (${a.bypass}) · B`;

function paintFlag(el, a) {
  const on = bypassOn(a);
  el.classList.toggle('on', on);
  el.setAttribute('aria-pressed', String(on));
  el.title = flagTitle(a, on);
}

function installIn(a) {
  const project = getProject();
  closePop();
  // Pre-type the install command without running it: the user reviews and presses Enter.
  openTerminal(project, { title: `Installa ${a.name}` }).then((t) => {
    setTimeout(() => sendInput(t.id, a.install), 600);
  });
}

async function openMenu() {
  const project = getProject();
  if (!project) return;
  // "Continua" only where there is a conversation to continue: otherwise
  // claude --continue exits at once with "No conversation found to continue".
  const [canContinue] = await Promise.all([work.agents.hasHistory(project.path), installed || refreshInstalled()]);
  if (pop) return; // a second press while waiting: one menu is enough
  const last = lastUsed();
  const avail = AGENTS.filter((a) => installed.has(a.bin));
  const missing = AGENTS.filter((a) => !installed.has(a.bin));
  const branch = project.gitStatus?.branch.name;

  const row = (a, i) => `
    <div class="ap-row" role="option" data-id="${a.id}">
      ${tile(a)}
      <div class="ap-text">
        <div class="ap-name">${esc(a.name)}${flag(a)}</div>
        <div class="ap-desc">${esc(a.by)} · ${esc(a.desc)}</div>
      </div>
      <div class="ap-side">
        ${a.continueCommand && canContinue ? '<button class="ap-sec" data-continue title="Continua l\'ultima sessione in questa cartella">Continua</button>' : ''}
        ${a.id === last ? '<span class="ap-last">Ultimo</span>' : ''}
        ${i < 9 ? `<kbd>${i + 1}</kbd>` : ''}
      </div>
    </div>`;
  const missingRow = (a) => `
    <div class="ap-row missing" data-id="${a.id}">
      ${tile(a)}
      <div class="ap-text">
        <div class="ap-name">${esc(a.name)}</div>
        <div class="ap-desc mono">${esc(a.install)}</div>
      </div>
      <div class="ap-side"><button class="ap-sec" data-install>Installa</button></div>
    </div>`;

  pop = document.createElement('div');
  pop.className = 'agent-pop';
  pop.setAttribute('role', 'dialog');
  pop.innerHTML = `
    <header class="ap-head">
      <div class="ap-title">Avvia un agente</div>
      <div class="ap-sub">in <b>${esc(project.name)}</b>${branch ? ` <span class="ap-branch">${esc(branch)}</span>` : ''}</div>
    </header>
    <div class="ap-list" role="listbox">
      ${avail.map(row).join('') || '<div class="ap-empty">Nessun agente trovato nel PATH.</div>'}
      ${missing.length ? `
        <button class="ap-more"><span class="ap-more-chev">›</span>${missing.length} non installati</button>
        <div class="ap-missing" hidden>${missing.map(missingRow).join('')}</div>` : ''}
    </div>
    <footer class="ap-foot">
      <span><kbd>↑</kbd><kbd>↓</kbd> scegli</span><span><kbd>↵</kbd> avvia</span><span><kbd>1</kbd>–<kbd>9</kbd> rapido</span><span><kbd>B</kbd> bypass</span>
      <div class="spacer"></div>
      <button class="ap-rescan" title="Cerca di nuovo gli agenti installati">↻</button>
    </footer>`;
  document.body.appendChild(pop);

  // Anchor under the trigger, right-aligned; grow out of the button.
  const b = $('#new-agent').getBoundingClientRect();
  pop.style.top = `${b.bottom + 8}px`;
  pop.style.right = `${Math.max(8, innerWidth - b.right)}px`;
  pop.style.transformOrigin = `calc(100% - ${b.width / 2}px) -8px`;
  $('#new-agent').classList.add('open');

  pop.addEventListener('click', (e) => {
    const r = e.target.closest('.ap-row');
    if (e.target.closest('.ap-more')) {
      const box = pop.querySelector('.ap-missing');
      box.hidden = !box.hidden;
      pop.querySelector('.ap-more').classList.toggle('open', !box.hidden);
      return;
    }
    if (e.target.closest('.ap-rescan')) {
      refreshInstalled().then(() => {
        if (!pop) return; // closed meanwhile: don't bring it back
        closePop();
        openMenu();
      });
      return;
    }
    if (!r) return;
    const a = AGENTS.find((x) => x.id === r.dataset.id);
    if (e.target.closest('[data-install]')) return installIn(a);
    if (r.classList.contains('missing')) return;
    const f = e.target.closest('[data-bypass]');
    if (f) {
      // Flip the flag in place: the menu stays open, nothing starts.
      setBypass(a, !bypassOn(a));
      paintFlag(f, a);
      return;
    }
    closePop();
    if (e.target.closest('[data-continue]')) launch({ ...a, command: a.continueCommand });
    else launch(a);
  });
  pop.addEventListener('pointermove', (e) => {
    const r = e.target.closest('.ap-row:not(.missing)');
    if (r) highlight(rows().indexOf(r));
  });

  highlight(Math.max(0, avail.findIndex((a) => a.id === last)));
  addEventListener('keydown', onKey, true);
  addEventListener('pointerdown', onOutside, true);
}

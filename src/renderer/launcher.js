// Agent menu: launch any installed agent CLI in the active project.
import { $, esc, leave } from './ui.js';
import { openTerminal, sendInput } from './terminals.js';
import { AGENTS } from './agentcatalog.js';

export { AGENTS } from './agentcatalog.js';

const { work } = window;

let installed = null; // Set of available binaries

// Each agent that has a "skip every confirmation" switch can be started with
// it: a flag next to its name in the menu, remembered per agent. Claude Code
// starts with it on (user preference); the others start off.
const BYPASS_DEFAULT = { claude: true };


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

const badgeFor = (a) => (bypassOn(a) ? { text: 'bypass permissions', title: `Started with ${a.bypass}: no confirmation prompts` } : null);

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
}

export function toggleMenu() {
  if (pop) closePop();
  else openMenu();
}

export function launch(agent, project = getProject(), extra = {}) {
  if (!project) return;
  remember(agent.id);
  return openTerminal(project, {
    command: commandFor(agent),
    title: agent.name,
    kind: 'agent',
    badge: badgeFor(agent),
    agentId: agent.id,
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
  if (!SESSION_ID.test(sessionId)) throw new Error(`Invalid session ID: ${sessionId}`);
  const claude = AGENTS[0];
  return openTerminal(project, {
    cwd,
    command: commandFor(claude, `claude --resume ${sessionId}`),
    title,
    kind: 'agent',
    badge: badgeFor(claude),
    agentId: claude.id,
    sessionRef: sessionId,
  });
}

// ── Popover ──────────────────────────────────────────────────
let pop = null;
let hi = 0; // highlighted row (shared by pointer and keyboard)
// The topbar button the menu grows out of (the agent button is gone: the squad one).
const anchor = () => $('#agent-team');

function closePop() {
  if (!pop) return;
  const el = pop;
  pop = null;
  removeEventListener('keydown', onKey, true);
  removeEventListener('pointerdown', onOutside, true);
  leave(el, () => el.remove());
}

function onOutside(e) {
  if (pop && !pop.contains(e.target)) closePop();
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
const flagTitle = (a, on) => `${on ? 'Starts without asking for confirmation' : 'Asks for confirmation before acting'} (${a.bypass}) · B`;

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
  openTerminal(project, { title: `Install ${a.name}` }).then((t) => {
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
        ${a.continueCommand && canContinue ? '<button class="ap-sec" data-continue title="Continue the last session in this folder">Continue</button>' : ''}
        ${a.id === last ? '<span class="ap-last">Last</span>' : ''}
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
      <div class="ap-side"><button class="ap-sec" data-install>Install</button></div>
    </div>`;

  pop = document.createElement('div');
  pop.className = 'agent-pop';
  pop.setAttribute('role', 'dialog');
  pop.innerHTML = `
    <header class="ap-head">
      <div class="ap-title">Start an agent</div>
      <div class="ap-sub">in <b>${esc(project.name)}</b>${branch ? ` <span class="ap-branch">${esc(branch)}</span>` : ''}</div>
    </header>
    <div class="ap-list" role="listbox">
      ${avail.map(row).join('') || '<div class="ap-empty">No agents found in PATH.</div>'}
      ${missing.length ? `
        <button class="ap-more"><span class="ap-more-chev">›</span>${missing.length} not installed</button>
        <div class="ap-missing" hidden>${missing.map(missingRow).join('')}</div>` : ''}
    </div>
    <footer class="ap-foot">
      <span><kbd>↑</kbd><kbd>↓</kbd> choose</span><span><kbd>↵</kbd> start</span><span><kbd>1</kbd>–<kbd>9</kbd> quick</span><span><kbd>B</kbd> bypass</span>
      <div class="spacer"></div>
      <button class="ap-rescan" title="Rescan installed agents">↻</button>
    </footer>`;
  document.body.appendChild(pop);

  // Anchor under the trigger, right-aligned; grow out of the button.
  const b = anchor()?.getBoundingClientRect();
  if (b) {
    pop.style.top = `${b.bottom + 8}px`;
    pop.style.right = `${Math.max(8, innerWidth - b.right)}px`;
    pop.style.transformOrigin = `calc(100% - ${b.width / 2}px) -8px`;
  }

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

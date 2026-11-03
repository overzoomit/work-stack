// Terminal panes. Each project owns its panes; only the active project's
// panes are laid out, the others keep running in the background.
import { Terminal } from './vendor/xterm.mjs';
import { FitAddon } from './vendor/addon-fit.mjs';
import { WebLinksAddon } from './vendor/addon-web-links.mjs';
import { $, esc, setHtml, afterExit } from './ui.js';
import { DEFAULTS, FONT_MIN, FONT_MAX, themeById, xtermTheme } from './themes.js';
import { tildify } from './paths.js';
import { roleFor } from './teamroles.js';
import { agentBadgeFor } from './agentcatalog.js';

const { work } = window;

// Appearance shared by every pane (theme, font size, cursor). `preview` is a
// temporary theme shown while hovering a swatch; `settings` is the committed one.
let settings = loadSettings();
let preview = null;

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('work.terminal') || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export const getAppearance = () => ({ ...settings });

export function setAppearance(patch, { persist = true } = {}) {
  settings = { ...settings, ...patch };
  settings.fontSize = Math.min(FONT_MAX, Math.max(FONT_MIN, settings.fontSize));
  if (persist) {
    try {
      localStorage.setItem('work.terminal', JSON.stringify(settings));
    } catch {
      // not persisted: applies to this session only
    }
  }
  applyAppearance();
}

export function previewTheme(id) {
  preview = id;
  applyAppearance();
}

function styleFor(t) {
  const theme = themeById(preview || settings.theme);
  t.term.options.theme = xtermTheme(theme);
  t.term.options.fontSize = settings.fontSize;
  t.term.options.cursorStyle = settings.cursorStyle;
  t.term.options.cursorBlink = settings.cursorBlink;
  t.el.style.setProperty('--term-bg', theme.bg);
  t.el.classList.toggle('term-light', !theme.dark);
  t.el.classList.toggle('term-glass', !!theme.glass);
}

function applyAppearance() {
  for (const t of [...all.values(), ...pending]) styleFor(t);
  requestAnimationFrame(fitAll);
}


const all = new Map(); // pty id -> pane
const early = new Map(); // output that arrives before a pane registers its id
const closedIds = new Set(); // output may still arrive after a pane is closed

// Acknowledged once xterm has parsed it: the main process pauses a shell that
// gets too far ahead of its terminal (flow control).
function writeOutput(t, data) {
  t.term.write(data, () => work.pty.ack(t.id, data.length));
  t.onOutput?.(data);
}
let home = '';
let active = null; // active project
let onChange = () => {};
let counter = 0;

let onLook = () => {};
let onActivity = () => {};
let onMenu = () => {};
let onDropOnTab = () => false;

export function initTerminals({ homeDir, changed, openAppearance, activity, menu, dropOnTab }) {
  home = homeDir;
  onChange = changed;
  onLook = openAppearance || onLook;
  onActivity = activity || onActivity;
  onMenu = menu || onMenu;
  onDropOnTab = dropOnTab || onDropOnTab;
  // Refit once the grid stops changing size: a splitter drag or a panel
  // transition resizes it every frame, and each fit reflows the scrollback.
  let fitTimer = 0;
  new ResizeObserver(() => {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(fitAll, 80);
  }).observe($('#terminals'));

  work.pty.onData((id, data) => {
    const t = all.get(id);
    if (t) {
      writeOutput(t, data);
      onActivity(t);
    } else if (closedIds.has(id)) {
      work.pty.ack(id, data.length); // last words of a closed pane
    } else {
      if (!early.has(id)) early.set(id, []);
      early.get(id).push(data);
    }
  });
  work.pty.onExit((id, code) => {
    const t = all.get(id);
    if (!t) return;
    t.exited = true;
    t.term.write(`\r\n\x1b[90m── process exited${code ? ` (code ${code})` : ''} ──\x1b[0m\r\n`);
    paintHead(t);
    t.onExit?.(code);
  });
}

const pending = new Set(); // panes waiting for their pty id
// Grid order is DOM order, so reordering a pane is just moving its element.
const panesOf = (project) => [...$('#terminals').children].filter((el) => el._t?.project === project).map((el) => el._t);

export function showProject(project) {
  active = project;
  for (const t of [...all.values(), ...pending]) t.el.classList.toggle('off', t.project !== project);
  relayout();
  const f = focused();
  if (f) requestAnimationFrame(() => f.term.focus());
}

export function focused() {
  return active ? all.get(active.focusedId) : null;
}

// Open panes only: a closed pane stays in the grid while its exit animation runs.
export function terminalsOf(project) {
  return panesOf(project).filter((t) => all.has(t.id));
}

function relayout() {
  const panes = active ? panesOf(active) : [];
  const grid = $('#terminals');
  const n = panes.length;
  $('#term-empty').hidden = n > 0 || !active;
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  const rows = Math.max(1, Math.ceil(n / cols));
  grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  grid.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
  // The last pane stretches over the empty cells of its row.
  panes.forEach((t, i) => {
    t.el.style.gridColumn = i === n - 1 && n % cols ? `span ${cols - (n % cols) + 1}` : '';
  });
  requestAnimationFrame(fitAll);
}

function fitAll() {
  for (const t of all.values()) {
    if (t.el.offsetParent === null) continue;
    try {
      t.fit.fit();
    } catch {
      // not measurable yet
    }
  }
}

export function roleBadgeFor(name) {
  if (!name) return null;
  const n = String(name).toLowerCase();
  if (n === 'pm') return { text: 'PM', title: 'Senior PM & Architect', role: 'pm' };
  if (n === 'dev1') return { text: 'DEV1', title: 'Senior Developer #1', role: 'dev1' };
  if (n === 'dev2') return { text: 'DEV2', title: 'Senior Developer #2', role: 'dev2' };
  if (n === 'qa') return { text: 'QA', title: 'QA Engineer', role: 'qa' };
  const devMatch = n.match(/^dev(\d+)?$/);
  if (devMatch) {
    const num = devMatch[1] || '';
    return { text: num ? `DEV${num}` : 'DEV', title: num ? `Developer #${num}` : 'Developer', role: 'dev' };
  }
  const qaMatch = n.match(/^qa(\d+)?$/);
  if (qaMatch) {
    const num = qaMatch[1] || '';
    return { text: num ? `QA${num}` : 'QA', title: num ? `QA Engineer #${num}` : 'QA Engineer', role: 'qa' };
  }
  const docMatch = n.match(/^doc(\d+)?$/);
  if (docMatch) {
    const num = docMatch[1] || '';
    return { text: num ? `DOC${num}` : 'DOC', title: num ? `Documentation Specialist #${num}` : 'Documentation Specialist', role: 'doc' };
  }
  const agentMatch = n.match(/^agent(\d+)$/);
  if (agentMatch) return { text: `AGENT${agentMatch[1]}`, title: `Generic agent #${agentMatch[1]}`, role: 'agent' };
  return null;
}

// `container`: mount somewhere other than the terminal grid (e.g. the Run
// console). Such panes stay out of the grid, the terminal list and drag.
export async function openTerminal(project, { cwd, command, title, kind = 'shell', badge = null, onOutput, onExit, focus: takeFocus = true, container = null, tmuxSession = null, tmuxWindow = null, tmuxName = null, role = null, agentId = null, sessionRef = null } = {}) {
  const remote = project?.remote || null;
  const effectiveBadge = badge || roleBadgeFor(tmuxName || title);
  // An explicit agent wins; otherwise a team role falls back to its default
  // agent (PM -> Antigravity, DEV* -> OpenCode/Ollama, QA* -> Codex).
  const effectiveAgent = agentBadgeFor(agentId || roleFor(role || tmuxName || title)?.agentId);
  const el = document.createElement('div');
  el.className = container ? 'pane console' : 'pane';
  el.innerHTML = `
    <div class="pane-head">
      <span class="dot"></span>
      <span class="pane-title"></span>
      ${effectiveBadge ? `<span class="pane-badge${effectiveBadge.role ? ' role-' + effectiveBadge.role : ''}" data-role="${effectiveBadge.role || ''}" title="${esc(effectiveBadge.title || '')}">${esc(effectiveBadge.text)}</span>` : ''}
      ${effectiveAgent ? `<span class="pane-badge pane-agent-badge" data-agent="${esc(effectiveAgent.id)}" title="${esc(effectiveAgent.name)}" style="--agent-tint-1:${esc(effectiveAgent.tint[0])};--agent-tint-2:${esc(effectiveAgent.tint[1])}">${esc(effectiveAgent.text)}</span>` : ''}
      <span class="pane-cwd"></span>
      <div class="spacer"></div>
      <button class="icon-btn pane-aa" data-act="look" title="Terminal appearance">Aa</button>
      <button class="icon-btn" data-act="max" title="Maximize (Ctrl+Shift+M)">⤢</button>
      <button class="icon-btn" data-act="close" title="Close (Ctrl+Shift+W)">✕</button>
    </div>
    <div class="pane-body"></div>`;
  (container || $('#terminals')).appendChild(el);
  if (project !== active) el.classList.add('off');

  const term = new Terminal({
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono'),
    fontSize: settings.fontSize,
    lineHeight: 1.15,
    cursorBlink: settings.cursorBlink,
    cursorStyle: settings.cursorStyle,
    allowTransparency: true,
    // Option stays Option, as in Terminal.app: Italian and other layouts type @ # [ ] with it.
    macOptionIsMeta: false,
    scrollback: kind === 'run' ? 3000 : 10000, // Run logs are verbose and rerun often
    theme: xtermTheme(themeById(preview || settings.theme)),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((_e, uri) => work.app.openExternal(uri)));
  term.open(el.querySelector('.pane-body'));

  const t = {
    id: null, project, term, fit, el, kind, title: title || `Terminal ${++counter}`, cwd: cwd || remote?.remotePath || project.path, exited: false, onOutput, onExit,
    tmuxSession, tmuxWindow, tmuxName: tmuxName || title,
    role: role || roleFor(tmuxName || title)?.name || null,
    agentId: agentId || null, agent: effectiveAgent, command: command || null, sessionRef: sessionRef || null,
  };
  el._t = t;
  t.console = !!container;
  pending.add(t);
  styleFor(t);
  relayout();
  try {
    fit.fit();
  } catch {
    // hidden (background project): default size until shown
  }

  let ptyOpts = { cwd: t.cwd, cols: term.cols, rows: term.rows, command };
  if (remote) ptyOpts.remote = remote;
  if (!container && work?.tmux) {
    // A remote project uses tmux on the server even when the local machine has none.
    const isTmux = remote ? true : await work.tmux.isAvailable().catch(() => false);
    if (isTmux && project?.path) {
      const session = tmuxSession || (await work.tmux.sessionForProject(project.path, remote).catch(() => null));
      if (session) {
        ptyOpts.tmux_session = session;
        if (tmuxWindow) ptyOpts.tmux_window = tmuxWindow;
        if (tmuxName || title) ptyOpts.tmux_name = tmuxName || title;
        if (t.role) ptyOpts.role = t.role;
        if (t.agentId) ptyOpts.agent_id = t.agentId;
        if (t.sessionRef) ptyOpts.session_ref = t.sessionRef;
        t.tmuxSession = session;
      }
    }
  }

  const id = await work.pty.create(ptyOpts);
  pending.delete(t);
  t.id = id;
  all.set(id, t);
  for (const chunk of early.get(id) || []) writeOutput(t, chunk);
  early.delete(id);

  term.onData((d) => !t.exited && work.pty.write(id, d));
  // The view reflows live, but the shell only hears about the final size:
  // a stream of SIGWINCH during a drag makes bash redraw its prompt over itself.
  let resizeTimer = null;
  term.onResize(({ cols, rows }) => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => !t.exited && work.pty.resize(id, cols, rows), 150);
  });
  term.onTitleChange((s) => {
    t.procTitle = s;
    paintHead(t);
  });
  term.textarea.addEventListener('focus', () => focus(id));
  el.addEventListener('pointerdown', () => focus(id));
  el.querySelector('[data-act="close"]').onclick = () => closeTerminal(id);
  el.querySelector('[data-act="max"]').onclick = () => toggleMax(id);
  // Files dropped on a terminal type their paths, quoted, as in Terminal.app.
  el.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  });
  el.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    const paths = files.map((f) => work.app.pathForFile(f)).filter(Boolean);
    if (paths.length && !t.exited) work.pty.write(id, `${paths.map(shellQuote).join(' ')} `);
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    focus(id);
    onMenu(t, e.clientX, e.clientY);
  });
  if (!container) el.querySelector('.pane-head').addEventListener('pointerdown', (e) => startPaneDrag(t, e));
  el.querySelector('.pane-head').addEventListener('dblclick', (e) => {
    if (!e.target.closest('button')) toggleMax(id);
  });
  el.querySelector('[data-act="look"]').onpointerdown = (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onLook(e.currentTarget);
  };
  if (t.tmuxSession && !t.tmuxWindow) t.tmuxWindow = await work.pty.tmuxWindow(id).catch(() => null);

  paintHead(t);
  if (project === active && takeFocus) {
    focus(id);
    term.focus();
  }
  onChange();
  return t;
}

function paintHead(t) {
  t.el.querySelector('.pane-title').textContent = t.title;
  t.el.querySelector('.pane-cwd').innerHTML = `<bdi>${esc(t.procTitle || tildify(t.cwd, home))}</bdi>`;
  t.el.querySelector('.dot').className = `dot ${dotClass(t)}`;
  t.el.classList.toggle('exited', t.exited);
  onChange();
}

const shellQuote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

const dotClass = (t) => (t.exited ? 'exited' : t.kind === 'agent' ? 'working' : t.kind === 'run' ? 'running' : 'shell');

export function sendInput(id, data) {
  if (all.has(id)) work.pty.write(id, data);
}

export function killTerminal(id) {
  if (all.has(id)) work.pty.kill(id);
}

export function flash(id) {
  const t = all.get(id);
  if (!t) return;
  if (t.project.maximizedId && t.project.maximizedId !== id) toggleMax(id);
  focus(id);
  t.el.classList.remove('flash');
  void t.el.offsetWidth;
  t.el.classList.add('flash');
}

export function focus(id) {
  const t = all.get(id);
  if (!t || t.console || t.project.focusedId === id) return;
  t.project.focusedId = id;
  for (const x of terminalsOf(t.project)) x.el.classList.toggle('focused', x.id === id);
  onChange();
}

export function closeTerminal(id) {
  const t = all.get(id);
  if (!t) return;
  if (!t.exited) work.pty.kill(id);
  all.delete(id);
  closedIds.add(id);
  const p = t.project;
  if (p.maximizedId === id) p.maximizedId = null;
  t.el.classList.add('closing');
  afterExit(t.el, () => {
    t.term.dispose();
    t.el.remove();
    relayout();
  });
  if (p.focusedId === id) {
    p.focusedId = null;
    const next = terminalsOf(p).pop();
    if (next) {
      focus(next.id);
      if (p === active) next.term.focus();
    }
  }
  onChange();
}

// Every pane of the project, including consoles mounted outside the grid.
export function closeProjectTerminals(project) {
  for (const t of [...all.values()].filter((x) => x.project === project)) closeTerminal(t.id);
}

export function toggleMax(id) {
  const t = all.get(id);
  if (!t) return;
  const p = t.project;
  p.maximizedId = p.maximizedId === id ? null : id;
  for (const x of terminalsOf(p)) x.el.classList.toggle('maximized', x.id === p.maximizedId);
  requestAnimationFrame(fitAll);
  t.term.focus();
}

export function renderTermList(project) {
  const list = $('#term-list');
  const panes = project ? terminalsOf(project) : [];
  $('#term-count').textContent = panes.length;
  const changed = setHtml(list, panes.map((t) => `
    <li data-id="${t.id}" class="${t.id === project.focusedId ? 'active' : ''}">
      <span class="dot ${dotClass(t)}"></span>
      <div class="li-main">
        <div class="li-title">${esc(t.title)}</div>
        <div class="li-sub"><code>${esc(tildify(t.cwd, home))}</code></div>
      </div>
    </li>`).join(''));
  if (changed) for (const li of list.children) {
    li.oncontextmenu = (e) => {
      e.preventDefault();
      const t = all.get(Number(li.dataset.id));
      if (t) onMenu(t, e.clientX, e.clientY);
    };
    li.onpointerdown = (e) => {
      if (e.button !== 0) return;
      const t = all.get(Number(li.dataset.id));
      focus(t.id);
      if (project.maximizedId && project.maximizedId !== t.id) toggleMax(t.id);
      requestAnimationFrame(() => t.term.focus());
    };
  }
}

// Keep each focused terminal's cwd fresh (shown in its header).
export async function pollCwd(t = focused()) {
  if (!t || t.exited) return;
  const cwd = await work.pty.cwd(t.id);
  if (cwd && cwd !== t.cwd) {
    t.cwd = cwd;
    paintHead(t);
  }
}

// ── Pane actions (context menu) ──────────────────────────────

export function copySelection(t) {
  const text = t.term.getSelection();
  if (text) work.app.copy(text);
  return !!text;
}

export async function pasteInto(t) {
  const text = await work.app.paste();
  if (text && !t.exited) t.term.paste(text); // bracketed paste when the shell supports it
  t.term.focus();
}

export function renameTerminal(t, title) {
  t.title = title;
  paintHead(t);
}

export function moveToProject(t, project) {
  if (t.project === project) return;
  const from = t.project;
  if (from.maximizedId === t.id) {
    from.maximizedId = null;
    t.el.classList.remove('maximized');
  }
  t.project = project;
  t.el.classList.toggle('off', project !== active);
  t.el.classList.remove('focused');
  $('#terminals').appendChild(t.el); // last in the destination's grid
  // focus() also moves the highlight; an empty destination focuses the newcomer.
  if (from.focusedId === t.id) {
    from.focusedId = null;
    const next = terminalsOf(from)[0];
    if (next) focus(next.id);
  }
  if (!all.has(project.focusedId)) focus(t.id);
  relayout();
  onChange();
}

// ── Drag to reorder panes (or drop on a project tab to move it) ──
// Follows the pointer 1:1 from where the header was grabbed, after a small
// threshold; on release the grid re-flows and every pane glides from where
// it was on screen to its new slot (FLIP), the dragged one included.

const DRAG_THRESHOLD = 6;
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function flip(els, mutate) {
  const first = new Map(els.map((el) => [el, el.getBoundingClientRect()]));
  mutate();
  if (reduced()) return;
  for (const el of els) {
    if (!el.isConnected || el.offsetParent === null) continue;
    const f = first.get(el);
    const l = el.getBoundingClientRect();
    const dx = f.left - l.left;
    const dy = f.top - l.top;
    const sx = f.width / l.width;
    const sy = f.height / l.height;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) continue;
    el.animate([
      { transformOrigin: '0 0', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
      { transformOrigin: '0 0', transform: 'none' },
    ], { duration: 340, easing: EASE });
  }
}

function startPaneDrag(t, e) {
  if (e.button !== 0 || e.target.closest('button') || t.project.maximizedId) return;
  const head = e.currentTarget;
  const el = t.el;
  const x0 = e.clientX;
  const y0 = e.clientY;
  let dragging = false;
  let target = null; // { kind: 'pane', el, after } | { kind: 'tab', el }
  let zones = []; // drop zones measured once: the grid doesn't move during a drag

  const measure = () => [
    ...[...document.querySelectorAll('.ptab:not(.active)')].map((x) => ({ kind: 'tab', el: x, r: x.getBoundingClientRect() })),
    ...panesOf(t.project).filter((x) => x.el !== el && !x.el.classList.contains('off'))
      .map((x) => ({ kind: 'pane', el: x.el, r: x.el.getBoundingClientRect() })),
  ];

  const mark = (next) => {
    if (next?.el === target?.el && next?.after === target?.after) return; // same spot: no DOM work
    target?.el.classList.remove('drop-before', 'drop-after', 'drop-tab');
    target = next;
    if (target) target.el.classList.add(target.kind === 'tab' ? 'drop-tab' : target.after ? 'drop-after' : 'drop-before');
  };

  const move = (ev) => {
    const dx = ev.clientX - x0;
    const dy = ev.clientY - y0;
    if (!dragging) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      dragging = true;
      try {
        head.setPointerCapture(ev.pointerId);
      } catch {
        // pointer already released
      }
      zones = measure();
      el.classList.add('dragging');
      document.body.classList.add('pane-dragging');
    }
    el.style.transform = `translate(${dx}px, ${dy}px) scale(0.98)`;
    const { clientX: x, clientY: y } = ev;
    const zone = zones.find(({ r }) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
    if (!zone) return mark(null);
    if (zone.kind === 'tab') return mark({ kind: 'tab', el: zone.el });
    const { r } = zone;
    const after = r.width > r.height * 1.2 ? x > r.left + r.width / 2 : y > r.top + r.height / 2;
    mark({ kind: 'pane', el: zone.el, after });
  };

  const end = (ev) => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', end);
    removeEventListener('pointercancel', end);
    removeEventListener('keydown', esc, true);
    if (!dragging) return;
    document.body.classList.remove('pane-dragging');
    const drop = target;
    mark(null);
    const cancelled = ev?.type === 'keydown' || ev?.type === 'pointercancel';
    if (!cancelled && drop?.kind === 'tab' && onDropOnTab(t, drop.el)) {
      el.classList.remove('dragging');
      el.style.transform = '';
      return;
    }
    const panes = panesOf(t.project).map((x) => x.el);
    flip(panes, () => {
      el.classList.remove('dragging');
      el.style.transform = '';
      if (!cancelled && drop?.kind === 'pane') {
        drop.el.parentNode.insertBefore(el, drop.after ? drop.el.nextSibling : drop.el);
        relayout();
        onChange();
      }
    });
    requestAnimationFrame(fitAll);
  };
  const esc = (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      end(ev);
    }
  };

  // On window, not the header: a release anywhere (even before the drag
  // threshold, outside the header) always ends the gesture.
  addEventListener('pointermove', move);
  addEventListener('pointerup', end);
  addEventListener('pointercancel', end);
  addEventListener('keydown', esc, true);
}

// A pane's resume identity is only written when it has one: plain shells keep
// the four-field shape older state.json files already use.
function savedTerminal(t) {
  const saved = { title: t.title, tmuxWindow: t.tmuxWindow || null, tmuxName: t.tmuxName || null, cwd: t.cwd || null };
  if (t.role) saved.role = t.role;
  if (t.agentId) saved.agentId = t.agentId;
  if (t.command) saved.command = t.command;
  if (t.sessionRef) saved.sessionRef = t.sessionRef;
  return saved;
}

// What a restart reopens: the panes open now, in grid order, plus any saved
// agent entries that could not be resumed yet (a transient tmux failure must
// not let a state.json write erase them). A project not shown yet this session
// keeps the list it was saved with.
export function terminalLayout(project) {
  const open = terminalsOf(project);
  if (!open.length) return project.savedTerminals ?? null;
  const saved = Array.isArray(project.savedTerminals) ? project.savedTerminals : [];
  const pending = saved.filter((s) => !open.some((t) =>
    t.tmuxWindow === s.tmuxWindow
    || (s.tmuxName && (t.tmuxName === s.tmuxName || t.title === s.tmuxName))
    || (s.title && t.title === s.title)));
  return [...open.map(savedTerminal), ...pending];
}

// A project with no panes gets back the tmux windows it had open when Work
// closed (`savedTerminals`), or every window of its session the first time.
// A squad window that vanished with the tmux server is recreated from its
// saved role/command (agent resume); without anything, one plain shell.
export async function ensureInitialTerminal(project) {
  if (!project || terminalsOf(project).length > 0) return [];
  const saved = Array.isArray(project.savedTerminals) ? project.savedTerminals : null;
  // A new remote project opens its SSH terminal straight away: waiting for a
  // tmux round trip before the first pane would make an offline host look
  // like a frozen app. The PTY itself reports the connection error.
  if (project.remote && !saved?.length) {
    project.savedTerminals = [];
    return [await openTerminal(project)];
  }
  const { reattached, ok, pending = [] } = await syncProjectTerminalsResult(project, saved, { resume: true });

  if (reattached.length) {
    // Restored once: closing every pane later must not bring the windows back.
    // Entries that could not be resumed yet stay saved for the next attempt.
    project.savedTerminals = pending;
    return reattached;
  }
  // tmux did not answer (socket still coming up, server restarting, session
  // gone). Keep the saved layout and skip the fallback shell: that shell would
  // be written straight over state.json, losing the agent windows for good.
  // The next activation retries the realignment.
  if (!ok && saved?.length) return [];
  // A saved agent could not be relaunched (tmux refused the new window): keep
  // its resume metadata rather than replacing it with an anonymous shell.
  if (pending.length) return [];

  project.savedTerminals = [];
  return [await openTerminal(project)];
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The command that brings a saved team window back. A stored command wins; a
// Claude session id turns it into `--resume <id>`, while a Claude pane with no
// id continues the folder's latest conversation when there is one. Roles
// without stored metadata fall back to TEAM_ROLES.
async function resumeCommandFor(entry, project) {
  const role = roleFor(entry.role || entry.tmuxName || entry.title);
  const base = entry.command || role?.command || null;
  if (!base) return null;
  const id = entry.sessionRef;
  if (id && SESSION_ID.test(id) && /\bclaude\b/.test(base) && !/--resume\b/.test(base)) {
    return `${base} --resume ${id}`;
  }
  if (!id && entry.agentId === 'claude' && /\bclaude\b/.test(base) && !/--continue\b/.test(base) && !project.remote) {
    const hasHistory = await work.agents?.hasHistory?.(entry.cwd || project.path).catch(() => false);
    if (hasHistory) return `${base} --continue`;
  }
  return base;
}

const resumable = (entry) => !!(entry.role || entry.sessionRef);

// One re-attach pass. `ok` tells whether tmux actually answered: on a
// transient failure an empty result means "unknown", not "nothing to restore".
async function syncProjectTerminalsResult(project, saved = null, { resume = false } = {}) {
  const failed = { reattached: [], ok: false, pending: [] };
  if (!project || !work?.tmux) return failed;

  const remote = project.remote || null;
  const cwd = remote?.remotePath || project.path;
  const available = remote ? true : await work.tmux.isAvailable().catch(() => false);
  if (!available) return failed;

  const session = await work.tmux.sessionForProject(project.path, remote).catch(() => null);
  if (!session) return failed;

  // Right after launch the tmux daemon or the project session may not exist
  // yet: ensure it before listing, or list-windows races the socket.
  if (work.tmux.ensureSession) {
    const ensured = await work.tmux.ensureSession(session, cwd, remote).then(() => true).catch(() => false);
    if (!ensured) return failed;
  }

  const windows = await work.tmux.listWindows(session, remote).catch(() => null);
  if (!Array.isArray(windows)) return failed;

  const wanted = [];
  const missing = [];
  if (saved) {
    for (const s of saved) {
      // A tmux restart renumbers windows (@15 becomes @0): follow a saved
      // window by its name too, not only by the id it had last time.
      const win = windows.find((w) =>
        w.id === s.tmuxWindow
        || (s.tmuxName && w.name === s.tmuxName)
        || (s.title && w.name === s.title));
      if (win) wanted.push({ ...win, title: s.title || win.name, saved: s });
      else if (resume && resumable(s)) missing.push(s);
    }
  } else {
    for (const w of windows) wanted.push({ ...w, title: w.name, saved: null });
  }

  const existingPanes = terminalsOf(project);
  const reattached = [];
  const pending = [];

  for (const win of wanted) {
    // Remember the id the window has now, so the saved layout stops pointing
    // at the dead one even before the next state.json write.
    if (win.saved) win.saved.tmuxWindow = win.id;
    const alreadyOpen = existingPanes.find((p) =>
      p.tmuxWindow === win.id
      || (p.tmuxName && p.tmuxName === win.name)
      || p.title === win.name);
    if (alreadyOpen) {
      alreadyOpen.tmuxWindow = win.id;
      continue;
    }
    const role = roleFor(win.saved?.role || win.saved?.tmuxName || win.name);
    const pane = await openTerminal(project, {
      cwd: win.path || win.saved?.cwd || project.path,
      title: win.title,
      tmuxSession: session,
      tmuxWindow: win.id,
      tmuxName: win.name,
      role: win.saved?.role || role?.name || null,
      agentId: win.saved?.agentId || role?.agentId || null,
      command: win.saved?.command || role?.command || null,
      sessionRef: win.saved?.sessionRef || null,
    });
    reattached.push(pane);
  }

  // tmux was killed or rebooted: the saved squad windows are gone, so relaunch
  // each role in a fresh window with its stored agent command.
  for (const entry of missing) {
    const roleName = entry.role || entry.tmuxName || entry.title;
    const command = await resumeCommandFor(entry, project);
    if (!roleName || !command) {
      pending.push(entry);
      continue;
    }
    const cwd = entry.cwd || remote?.remotePath || project.path;
    const newId = await work.tmux.newWindow(session, roleName, cwd, command, remote).catch(() => null);
    if (!newId) {
      pending.push(entry);
      continue;
    }
    entry.tmuxWindow = newId;
    const role = roleFor(roleName);
    reattached.push(await openTerminal(project, {
      cwd,
      title: entry.title || roleName,
      tmuxSession: session,
      tmuxWindow: newId,
      tmuxName: entry.tmuxName || roleName,
      role: entry.role || roleName,
      agentId: entry.agentId || role?.agentId || null,
      command,
      sessionRef: entry.sessionRef || null,
    }));
  }

  return { reattached, ok: true, pending };
}

// Reattaches the project's tmux windows that have no pane: all of them, or
// only those in `saved` (by id or name, in saved order) when given.
export async function syncProjectTerminals(project, saved = null) {
  return (await syncProjectTerminalsResult(project, saved)).reattached;
}

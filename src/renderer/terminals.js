// Terminal panes. Each project owns its panes; only the active project's
// panes are laid out, the others keep running in the background.
import { Terminal } from './vendor/xterm.mjs';
import { FitAddon } from './vendor/addon-fit.mjs';
import { WebLinksAddon } from './vendor/addon-web-links.mjs';
import { createTerminalSearch } from './terminalsearch.js';
import { $, esc, setHtml, afterExit, toast, toastError } from './ui.js';
import { DEFAULTS, FONT_MIN, FONT_MAX, themeById, xtermTheme } from './themes.js';
import { tildify } from './paths.js';
import { roleFor } from './teamroles.js';
import { agentBadgeFor, agentIdFromCommand } from './agentcatalog.js';
import { createWebviewPane } from './webview_pane.js';

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

// ── Split layout ─────────────────────────────────────────────
// Each project owns a binary tree: leaves are panes, splits keep the direction
// ("row" = side by side, "col" = stacked) and the fraction given to the first
// child. Geometry is absolute, so pane elements stay direct children of the
// grid and the existing focus, list and drag code keeps working.
const layouts = new WeakMap();
const splitterEls = new Set();
const INSET = 8;

const leafNode = (pane) => ({ type: 'leaf', pane });
const isSplit = (node) => node?.type === 'split';

function leaves(node, out = []) {
  if (!node) return out;
  if (isSplit(node)) {
    leaves(node.a, out);
    leaves(node.b, out);
  } else {
    out.push(node);
  }
  return out;
}

const layoutFor = (project) => layouts.get(project) || null;
function setLayout(project, root) {
  if (root) layouts.set(project, root);
  else layouts.delete(project);
}

function findLeaf(node, pane) {
  if (!node) return null;
  if (!isSplit(node)) return node.pane === pane ? node : null;
  return findLeaf(node.a, pane) || findLeaf(node.b, pane);
}

function replaceNode(node, target, replacement) {
  if (node === target) return replacement;
  if (isSplit(node)) {
    node.a = replaceNode(node.a, target, replacement);
    node.b = replaceNode(node.b, target, replacement);
  }
  return node;
}

function stripPane(node, pane) {
  if (!node) return null;
  if (!isSplit(node)) return node.pane === pane ? null : node;
  const a = stripPane(node.a, pane);
  const b = stripPane(node.b, pane);
  if (!a) return b;
  if (!b) return a;
  node.a = a;
  node.b = b;
  return node;
}

function removeLeaf(project, pane) {
  const root = layoutFor(project);
  if (root) setLayout(project, stripPane(root, pane));
}

// Splits `after` (a pane) or wraps the whole tree. `before` puts the new pane
// on the left/top of the target, used by the drag gesture.
function insertLeaf(project, pane, { after = null, direction = 'horizontal', before = false } = {}) {
  const node = leafNode(pane);
  const root = layoutFor(project);
  const dir = direction === 'vertical' ? 'col' : 'row';
  if (!root) {
    setLayout(project, node);
    return;
  }
  const target = after ? findLeaf(root, after) : null;
  if (!target) {
    setLayout(project, { type: 'split', dir, ratio: 0.5, a: root, b: node });
    return;
  }
  const replacement = {
    type: 'split', dir, ratio: 0.5,
    a: before ? node : target,
    b: before ? target : node,
  };
  setLayout(project, replaceNode(root, target, replacement));
}

function moveLeaf(project, pane, target, { after = true, direction = 'horizontal' } = {}) {
  if (!pane || !target || pane === target) return;
  removeLeaf(project, pane);
  const root = layoutFor(project);
  if (!root) {
    setLayout(project, leafNode(pane));
    return;
  }
  const found = findLeaf(root, target);
  if (!found) {
    insertLeaf(project, pane, { direction });
    return;
  }
  const dir = direction === 'vertical' ? 'col' : 'row';
  setLayout(project, replaceNode(root, found, {
    type: 'split', dir, ratio: 0.5,
    a: after ? found : leafNode(pane),
    b: after ? leafNode(pane) : found,
  }));
}

function currentPaneOf(project) {
  const focused = all.get(project.focusedId);
  if (focused && focused.project === project && !focused.console) return focused;
  const list = leaves(layoutFor(project));
  return list.length ? list[list.length - 1].pane : null;
}

// A serialisable view of the tree, for tests and diagnostics.
export function layoutSnapshot(project) {
  const snap = (node) => {
    if (!node) return null;
    if (!isSplit(node)) return { pane: node.pane?.id ?? null };
    return { dir: node.dir, ratio: node.ratio, a: snap(node.a), b: snap(node.b) };
  };
  return snap(layoutFor(project));
}

// Acknowledged once xterm has parsed it: the main process pauses a shell that
// gets too far ahead of its terminal (flow control).
function writeOutput(t, data) {
  t.term.write(data, () => work.pty.ack(t.id, data.length));
  t.onOutput?.(data);
  onOutput(t, data);
}
let home = '';
let active = null; // active project
let onChange = () => {};
let counter = 0;

let onLook = () => {};
let onActivity = () => {};
let onMenu = () => {};
let onDropOnTab = () => false;
let onOutput = () => {};

export function initTerminals({ homeDir, changed, openAppearance, activity, menu, dropOnTab, output }) {
  home = homeDir;
  onChange = changed;
  onLook = openAppearance || onLook;
  onActivity = activity || onActivity;
  onMenu = menu || onMenu;
  onDropOnTab = dropOnTab || onDropOnTab;
  onOutput = output || onOutput;
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
    // A split whose command ended has nothing left to show: collapse it after
    // a moment so the surviving rectangles get the space back. A lone pane
    // keeps its final output visible.
    if (!t.console && terminalsOf(t.project).length > 1) {
      setTimeout(() => {
        if (all.has(id) && t.exited) closeTerminal(id);
      }, 1500);
    }
  });
}

const pending = new Set(); // panes waiting for their pty id
// Layout order is the tree's depth-first order, independent of the DOM.
const panesOf = (project) => leaves(layoutFor(project))
  .map((node) => node.pane)
  .filter((pane) => pane?.el?._t?.project === project);

export function showProject(project) {
  active = project;
  for (const t of [...all.values(), ...pending]) {
    const visible = t.project === project;
    t.el.classList.toggle('off', !visible);
    // The search bar follows its pane: hidden with it, restored with it.
    if (visible) t.search?.resume();
    else t.search?.suspend();
  }
  relayout();
  const f = focused();
  if (f) requestAnimationFrame(() => (f.term ? f.term.focus() : f.focus?.()));
}

export function focused() {
  return active ? all.get(active.focusedId) : null;
}

// Open panes only: a closed pane stays in the grid while its exit animation runs.
export function terminalsOf(project) {
  return panesOf(project).filter((t) => all.has(t.id));
}

function placePane(el, rect) {
  el.style.left = `calc(${(rect.x * 100).toFixed(4)}% + ${INSET}px)`;
  el.style.top = `calc(${(rect.y * 100).toFixed(4)}% + ${INSET}px)`;
  el.style.width = `calc(${(rect.w * 100).toFixed(4)}% - ${INSET * 2}px)`;
  el.style.height = `calc(${(rect.h * 100).toFixed(4)}% - ${INSET * 2}px)`;
}

function clearGeometry(el) {
  el.style.left = '';
  el.style.top = '';
  el.style.width = '';
  el.style.height = '';
}

function renderNode(project, node, rect, grid) {
  if (!isSplit(node)) {
    const t = node.pane;
    if (!t?.el) return;
    if (t.el.parentNode !== grid) grid.appendChild(t.el);
    if (project.maximizedId && project.maximizedId === t.id) clearGeometry(t.el);
    else placePane(t.el, rect);
    return;
  }
  const ratio = Math.min(0.85, Math.max(0.15, Number.isFinite(node.ratio) ? node.ratio : 0.5));
  let a;
  let b;
  if (node.dir === 'col') {
    a = { x: rect.x, y: rect.y, w: rect.w, h: rect.h * ratio };
    b = { x: rect.x, y: rect.y + rect.h * ratio, w: rect.w, h: rect.h * (1 - ratio) };
  } else {
    a = { x: rect.x, y: rect.y, w: rect.w * ratio, h: rect.h };
    b = { x: rect.x + rect.w * ratio, y: rect.y, w: rect.w * (1 - ratio), h: rect.h };
  }
  renderNode(project, node.a, a, grid);
  renderNode(project, node.b, b, grid);
  addSplitter(project, node, rect, ratio, grid);
}

let draggingNode = null;

function addSplitter(project, node, rect, ratio, grid) {
  const el = document.createElement('div');
  el.className = `pane-splitter splitter-${node.dir === 'col' ? 'col' : 'row'}`;
  if (node === draggingNode) el.classList.add('dragging');
  el.dataset.dir = node.dir;
  if (node.dir === 'col') {
    el.style.left = `calc(${(rect.x * 100).toFixed(4)}% + ${INSET}px)`;
    el.style.width = `calc(${(rect.w * 100).toFixed(4)}% - ${INSET * 2}px)`;
    el.style.top = `calc(${((rect.y + rect.h * ratio) * 100).toFixed(4)}% - 3px)`;
    el.style.height = '6px';
  } else {
    el.style.left = `calc(${((rect.x + rect.w * ratio) * 100).toFixed(4)}% - 3px)`;
    el.style.width = '6px';
    el.style.top = `calc(${(rect.y * 100).toFixed(4)}% + ${INSET}px)`;
    el.style.height = `calc(${(rect.h * 100).toFixed(4)}% - ${INSET * 2}px)`;
  }
  el.title = 'Drag to resize';
  el.addEventListener('pointerdown', (e) => startSplitDrag(e, el, node, rect, project));
  grid.appendChild(el);
  splitterEls.add(el);
}

function startSplitDrag(e, handle, node, rect, project) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  draggingNode = node;
  handle.classList.add('dragging');
  const grid = $('#terminals');
  const move = (ev) => {
    const box = grid.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const raw = node.dir === 'col'
      ? (ev.clientY - (box.top + rect.y * box.height)) / (rect.h * box.height)
      : (ev.clientX - (box.left + rect.x * box.width)) / (rect.w * box.width);
    node.ratio = Math.min(0.85, Math.max(0.15, raw));
    relayout();
  };
  const end = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', end);
    removeEventListener('pointercancel', end);
    draggingNode = null;
    relayout();
    onChange();
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', end);
  addEventListener('pointercancel', end);
}

function relayout() {
  const grid = $('#terminals');
  for (const el of [...splitterEls]) el.remove();
  splitterEls.clear();
  const root = active ? layoutFor(active) : null;
  const panes = leaves(root);
  $('#term-empty').hidden = panes.length > 0 || !active;
  if (!active) {
    for (const t of [...all.values(), ...pending]) t.el.classList.add('off');
    return;
  }
  if (root) renderNode(active, root, { x: 0, y: 0, w: 1, h: 1 }, grid);
  // One maximized pane covers the others: its CSS inset replaces the tiles and
  // the splitters would only catch gestures behind it.
  if (active.maximizedId) {
    for (const el of [...splitterEls]) el.remove();
    splitterEls.clear();
  }
  for (const t of [...all.values(), ...pending]) {
    t.el.classList.toggle('off', t.project !== active);
  }
  requestAnimationFrame(fitAll);
}

function fitAll() {
  for (const t of all.values()) {
    // Webview panes have no xterm to measure: their iframe follows the tile.
    if (!t.fit || t.el.offsetParent === null) continue;
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
export async function openTerminal(project, { cwd, command, title, kind = 'shell', badge = null, onOutput, onExit, focus: takeFocus = true, container = null, tmuxSession = null, tmuxWindow = null, tmuxName = null, role = null, agentId = null, sessionRef = null, splitDirection = null, splitFrom = null } = {}) {
  const remote = project?.remote || null;
  const effectiveBadge = badge || roleBadgeFor(tmuxName || title);
  // The command actually running in the pane wins; an explicit agent id comes
  // next; only then the role default (PM -> Antigravity, QA* -> Codex).
  const detectedAgentId = agentIdFromCommand(command);
  const effectiveAgent = agentBadgeFor(agentId || detectedAgentId || roleFor(role || tmuxName || title)?.agentId);
  const agentBadgeHtml = effectiveAgent ? `<span class="pane-badge pane-agent-badge" data-agent="${esc(effectiveAgent.id)}" title="${esc(effectiveAgent.name)}" style="--agent-tint-1:${esc(effectiveAgent.tint[0])};--agent-tint-2:${esc(effectiveAgent.tint[1])}">${esc(effectiveAgent.text)}</span>` : '';
  const el = document.createElement('div');
  el.className = container ? 'pane console' : 'pane tiled';
  el.innerHTML = `
    <div class="pane-head">
      <span class="dot"></span>
      <span class="pane-title"></span>
      ${effectiveBadge ? `<span class="pane-badge${effectiveBadge.role ? ' role-' + effectiveBadge.role : ''}" data-role="${effectiveBadge.role || ''}" title="${esc(effectiveBadge.title || '')}">${esc(effectiveBadge.text)}</span>` : ''}
      ${agentBadgeHtml}
      <span class="pane-cwd"></span>
      <div class="spacer"></div>
      <button class="icon-btn pane-aa" data-act="look" title="Terminal appearance">Aa</button>
      ${container ? '' : '<button class="icon-btn" data-act="split-h" title="Split right (Ctrl+Shift+O)">◫</button>'}
      ${container ? '' : '<button class="icon-btn" data-act="split-v" title="Split down (Ctrl+Shift+E)">⬓</button>'}
      <button class="icon-btn" data-act="max" title="Maximize (Ctrl+Shift+M)">⤢</button>
      <button class="icon-btn" data-act="close" title="Close (Ctrl+Shift+W)">✕</button>
    </div>
    <div class="pane-body"></div>`;
  (container || $('#terminals')).appendChild(el);
  if (project !== active) el.classList.add('off');
  const agentBadgeEl = effectiveAgent ? el.querySelector('.pane-agent-badge') : null;

  const term = new Terminal({
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono'),
    fontSize: settings.fontSize,
    lineHeight: 1.15,
    cursorBlink: settings.cursorBlink,
    cursorStyle: settings.cursorStyle,
    allowTransparency: true,
    // The search addon paints match decorations through registerDecoration,
    // which xterm keeps behind this proposed API flag.
    allowProposedApi: true,
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
    agentId: agentId || detectedAgentId || null, agent: effectiveAgent, agentBadgeEl, command: command || null, sessionRef: sessionRef || null,
  };
  el._t = t;
  t.console = !!container;
  t.search = createTerminalSearch({ term, pane: el, host: el });
  if (project !== active) t.search.suspend();
  if (effectiveAgent) paintAgentBadge(t, effectiveAgent);
  pending.add(t);
  styleFor(t);
  if (!container) {
    const after = splitFrom && splitFrom.project === project ? splitFrom : currentPaneOf(project);
    insertLeaf(project, t, { after, direction: splitDirection || 'horizontal' });
    // A newcomer must be visible: leave maximize before laying it out.
    if (project.maximizedId) {
      project.maximizedId = null;
      for (const x of terminalsOf(project)) x.el.classList.remove('maximized');
    }
  }
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
        let targetWindow = tmuxWindow || null;
        // A split asks tmux for a sibling window and then attaches this xterm
        // to it; a failure falls back to the backend's own new window.
        if (!targetWindow && splitDirection && splitFrom?.tmuxWindow && splitFrom.tmuxSession === session && work.tmux.splitPane) {
          const info = await work.tmux.splitPane(session, splitFrom.tmuxWindow, splitDirection, remote).catch(() => null);
          if (info?.windowId) {
            targetWindow = info.windowId;
            t.tmuxPane = info.paneId || null;
          }
        }
        if (targetWindow) {
          ptyOpts.tmux_window = targetWindow;
          t.tmuxWindow = targetWindow;
        }
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
  if (!container) {
    el.querySelector('[data-act="split-h"]').onclick = (event) => {
      event.stopPropagation();
      splitTerminal(id, 'horizontal');
    };
    el.querySelector('[data-act="split-v"]').onclick = (event) => {
      event.stopPropagation();
      splitTerminal(id, 'vertical');
    };
  }
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
  // A local tmux pane gets the time-machine scrubber; remote history stays on
  // the host and a docked console is not a task terminal.
  if (t.tmuxSession && t.tmuxWindow && !container && !remote) setupTimeMachine(t);

  paintHead(t);
  if (project === active && takeFocus) {
    focus(id);
    term.focus();
  }
  onChange();
  return t;
}

// A docked browser preview: a webview pane in the same split tree as the
// terminals, so it can sit beside one, be dragged and maximized like any pane.
export function openWebview(project, { url = null, title = 'Browser preview', splitDirection = 'horizontal', splitFrom = null } = {}) {
  if (!project) return null;
  const pane = createWebviewPane(project, { url, title });
  pane.onClose = () => closeTerminal(pane.id);
  pane.onMaximize = () => toggleMax(pane.id);
  pane.onChange = () => onChange();
  // The iframe swallows its own pointer events; its toolbar and head still
  // select the pane, so Ctrl+Shift+M/W act on the preview being looked at.
  pane.el.addEventListener('pointerdown', () => focus(pane.id));
  pane.el.querySelector('.pane-head').addEventListener('pointerdown', (e) => startPaneDrag(pane, e));
  all.set(pane.id, pane);
  if (project.maximizedId) {
    project.maximizedId = null;
    for (const x of terminalsOf(project)) x.el.classList.remove('maximized');
  }
  const after = splitFrom && splitFrom.project === project ? splitFrom : currentPaneOf(project);
  insertLeaf(project, pane, { after, direction: splitDirection });
  relayout();
  if (project === active) focus(pane.id);
  onChange();
  return pane;
}

// Splits the pane in place: a new tmux window (its own PTY) in the same
// folder, laid out to the right or below. Works for plain shells too.
export async function splitTerminal(id, direction = 'horizontal') {
  const t = all.get(id);
  if (!t || t.console || t.exited) return null;
  // A split must be visible: leave maximize before adding the new rectangle.
  if (t.project.maximizedId) {
    t.project.maximizedId = null;
    for (const x of terminalsOf(t.project)) x.el.classList.remove('maximized');
    relayout();
  }
  return openTerminal(t.project, {
    cwd: t.cwd,
    tmuxSession: t.tmuxSession,
    splitDirection: direction,
    splitFrom: t,
  });
}

// ── Time Machine ─────────────────────────────────────────────
// A scrubber under a tmux/agent terminal. The backend keeps timestamped
// snapshots of the pane's scrollback; here they are replayed over the live
// xterm (an overlay, so the running process is never interrupted), copied or
// exported as a compact delta log, and forked into a new window.
const TM_POLL_MS = 5000;
const TM_PLAY_MS = 650;

const pad2 = (n) => String(n).padStart(2, '0');

export function formatTimelineTime(ms) {
  const d = new Date(Number(ms) || 0);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// Snapshots hold the whole scrollback, so the compact log shows only the lines
// that appeared between two captures. `from`/`to` are positions in the list.
export function compactTimeline(entries, from = 0, to = entries.length - 1) {
  if (!Array.isArray(entries) || !entries.length) return '';
  const start = Math.max(0, Math.min(from, entries.length - 1));
  const end = Math.max(start, Math.min(to, entries.length - 1));
  const out = [];
  let previous = [];
  for (let i = start; i <= end; i++) {
    const entry = entries[i];
    const lines = String(entry?.text || '')
      .split('\n')
      .map((line) => line.replace(/[ \t]+$/g, ''));
    let shared = 0;
    while (shared < previous.length && shared < lines.length && previous[shared] === lines[shared]) shared++;
    const fresh = lines.slice(shared);
    while (fresh.length && !fresh[0].trim()) fresh.shift();
    if (!fresh.length) continue;
    out.push(`── ${formatTimelineTime(entry.timestamp)} ──`, ...fresh);
    previous = lines;
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function setupTimeMachine(t) {
  if (!t || t.console || t.timeMachine || !work.tmux?.getHistoryTimeline) return null;
  const head = t.el.querySelector('.pane-head');
  const toggle = document.createElement('button');
  toggle.className = 'icon-btn pane-tm';
  toggle.dataset.act = 'tm';
  toggle.title = 'Time Machine: replay the output';
  toggle.textContent = '⏱';
  const look = head.querySelector('[data-act="look"]');
  if (look?.parentNode === head) head.insertBefore(toggle, look);
  else head.appendChild(toggle);

  const bar = document.createElement('div');
  bar.className = 'pane-timebar';
  bar.hidden = true;
  bar.innerHTML = `
    <button class="icon-btn tm-rewind" title="Rewind to the start of the session">⏮</button>
    <button class="icon-btn tm-play" title="Play the replay">▶</button>
    <input class="tm-slider" type="range" min="0" max="0" step="1" value="0" title="Rewind the terminal output">
    <span class="tm-time">--:--</span>
    <span class="tm-mode">collecting…</span>
    <button class="icon-btn tm-copy" title="Copy the compact log up to this point">⧉</button>
    <button class="icon-btn tm-export" title="Export the compact log up to this point">⇩</button>
    <button class="icon-btn tm-fork" title="Fork a new session from this point">⑂</button>
    <button class="icon-btn tm-close" title="Hide the Time Machine">✕</button>`;
  t.el.appendChild(bar);

  const body = t.el.querySelector('.pane-body');
  const replay = document.createElement('div');
  replay.className = 'pane-replay';
  replay.hidden = true;
  replay.innerHTML = `
    <div class="pane-replay-head">
      <span class="pane-replay-time">--:--</span>
      <span class="pane-replay-hint">Replay · the process keeps running</span>
    </div>
    <pre class="pane-replay-text"></pre>`;
  body.appendChild(replay);

  const tm = {
    entries: [], index: 0,
    // Agent terminals show the scrubber from the start; plain shells get it
    // once a real timeline exists (or from the ⏱ button).
    open: !!(t.role || t.agentId), seenTimeline: false,
    playing: false, playTimer: null, poll: null, busy: false,
    bar, replay,
    slider: bar.querySelector('.tm-slider'),
    time: bar.querySelector('.tm-time'),
    mode: bar.querySelector('.tm-mode'),
    play: bar.querySelector('.tm-play'),
    replayTime: replay.querySelector('.pane-replay-time'),
    replayText: replay.querySelector('.pane-replay-text'),
  };
  t.timeMachine = tm;

  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleTimeMachine(t);
  });
  bar.querySelector('.tm-rewind').addEventListener('click', () => seekTimeMachine(t, 0));
  tm.play.addEventListener('click', () => toggleTimeMachinePlay(t));
  tm.slider.addEventListener('input', () => seekTimeMachine(t, Number(tm.slider.value)));
  bar.querySelector('.tm-copy').addEventListener('click', () => copyTimeMachineLog(t));
  bar.querySelector('.tm-export').addEventListener('click', () => exportTimeMachineLog(t));
  bar.querySelector('.tm-fork').addEventListener('click', () => forkTimeMachine(t));
  bar.querySelector('.tm-close').addEventListener('click', () => toggleTimeMachine(t, false));

  renderTimeMachine(t);
  refitSoon(t);
  tm.poll = setInterval(() => {
    if (!t.exited) refreshTimeMachine(t);
  }, TM_POLL_MS);
  tm.poll?.unref?.();
  refreshTimeMachine(t);
  return tm;
}

// The scrubber takes height away from the xterm: remeasure after the layout.
function refitSoon(t) {
  requestAnimationFrame(() => {
    try {
      t.fit?.fit();
    } catch {
      // hidden pane: measured when it is shown
    }
  });
}

function renderTimeMachine(t) {
  const tm = t.timeMachine;
  if (!tm) return;
  const last = tm.entries.length - 1;
  const entry = tm.entries[tm.index];
  const live = tm.entries.length === 0 || tm.index >= last;
  tm.bar.hidden = !tm.open;
  tm.slider.max = String(Math.max(0, last));
  tm.slider.value = String(Math.max(0, tm.index));
  tm.slider.disabled = tm.entries.length < 2;
  tm.time.textContent = entry ? formatTimelineTime(entry.timestamp) : '--:--';
  tm.mode.textContent = !tm.entries.length ? 'collecting…' : live ? 'live' : 'replay';
  tm.mode.classList.toggle('replay', !live && tm.entries.length > 0);
  tm.play.textContent = tm.playing ? '⏸' : '▶';
  tm.play.title = tm.playing ? 'Pause the replay' : 'Play the replay';
  tm.play.disabled = tm.entries.length < 2;
  tm.replay.hidden = live;
  if (live) {
    tm.replayTime.textContent = '--:--';
    tm.replayText.textContent = '';
  } else if (entry) {
    tm.replayTime.textContent = formatTimelineTime(entry.timestamp);
    tm.replayText.textContent = entry.text;
    tm.replayText.scrollTop = tm.replayText.scrollHeight || 0;
  }
}

export function toggleTimeMachine(t, open = !t.timeMachine?.open) {
  const tm = t.timeMachine;
  if (!tm) return null;
  tm.open = !!open;
  if (tm.open) refreshTimeMachine(t);
  renderTimeMachine(t);
  refitSoon(t);
  return tm.open;
}

// Rebuilds the scrubber from the backend list. A viewer parked on an old
// snapshot stays there while new output arrives; one on the last entry follows
// the live process.
export function applyTimeline(t, entries) {
  const tm = t.timeMachine;
  if (!tm || !Array.isArray(entries)) return null;
  const followingLive = tm.index >= tm.entries.length - 1;
  tm.entries = entries;
  if (!entries.length) tm.index = 0;
  else tm.index = followingLive ? entries.length - 1 : Math.min(tm.index, entries.length - 1);
  if (entries.length > 1 && !tm.seenTimeline) {
    tm.seenTimeline = true;
    if (!tm.open) {
      tm.open = true;
      refitSoon(t);
    }
  }
  renderTimeMachine(t);
  return tm;
}

export async function refreshTimeMachine(t) {
  const tm = t?.timeMachine;
  if (!tm || !t.tmuxSession || !t.tmuxWindow || t.project?.remote) return null;
  if (!work.tmux?.getHistoryTimeline || tm.busy) return null;
  tm.busy = true;
  try {
    const entries = await work.tmux.getHistoryTimeline(t.tmuxSession, t.tmuxWindow);
    applyTimeline(t, entries);
    return entries;
  } catch {
    // The tmux server may be restarting: the next poll retries silently.
    return null;
  } finally {
    tm.busy = false;
  }
}

function stopPlayback(t) {
  const tm = t?.timeMachine;
  if (!tm) return;
  clearInterval(tm.playTimer);
  tm.playTimer = null;
  tm.playing = false;
}

export function seekTimeMachine(t, index) {
  const tm = t.timeMachine;
  if (!tm?.entries.length) return null;
  stopPlayback(t);
  tm.index = Math.max(0, Math.min(tm.entries.length - 1, Math.trunc(Number(index) || 0)));
  renderTimeMachine(t);
  return tm.entries[tm.index];
}

export function toggleTimeMachinePlay(t) {
  const tm = t.timeMachine;
  if (!tm || tm.entries.length < 2) return null;
  if (tm.playing) {
    stopPlayback(t);
    renderTimeMachine(t);
    return false;
  }
  if (tm.index >= tm.entries.length - 1) tm.index = 0;
  tm.playing = true;
  tm.playTimer = setInterval(() => {
    if (!all.has(t.id) || tm.index >= tm.entries.length - 1) {
      stopPlayback(t);
      renderTimeMachine(t);
      return;
    }
    tm.index += 1;
    renderTimeMachine(t);
  }, TM_PLAY_MS);
  tm.playTimer?.unref?.();
  renderTimeMachine(t);
  return true;
}

// The compact log from session start to the selected moment.
export function timeMachineLog(t) {
  const tm = t.timeMachine;
  if (!tm?.entries.length) return '';
  return compactTimeline(tm.entries, 0, tm.index);
}

export function copyTimeMachineLog(t) {
  const text = timeMachineLog(t);
  if (text) work.app.copy(text);
  return text;
}

const fileSafe = (s) => String(s || 'terminal').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'terminal';

export function exportTimeMachineLog(t) {
  const text = timeMachineLog(t);
  if (!text) return '';
  const entry = t.timeMachine.entries[t.timeMachine.index];
  const name = `work-timemachine-${fileSafe(t.title)}-${formatTimelineTime(entry?.timestamp).replace(/:/g, '')}.log`;
  try {
    if (typeof Blob !== 'function' || typeof URL?.createObjectURL !== 'function') throw new Error('no blob');
    const a = document.createElement('a');
    // A plain document (no download support) falls back to the clipboard.
    if (typeof a.click !== 'function') throw new Error('no download');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Log exported');
  } catch {
    // A webview without downloads still gives the user the text.
    work.app.copy(text);
  }
  return text;
}

// Forks a new tmux window at the selected snapshot and opens its pane beside
// the source one. The backend seeds that window with the captured context.
export async function forkTimeMachine(t) {
  const tm = t.timeMachine;
  if (!tm?.entries.length || !t.tmuxSession || !t.tmuxWindow) return null;
  const entry = tm.entries[tm.index];
  try {
    const windowId = await work.tmux.forkFromHistory(t.tmuxSession, t.tmuxWindow, entry.index);
    if (!windowId) return null;
    return await openTerminal(t.project, {
      cwd: t.cwd,
      title: `Fork ${formatTimelineTime(entry.timestamp)}`,
      tmuxSession: t.tmuxSession,
      tmuxWindow: windowId,
      splitFrom: t,
      splitDirection: 'horizontal',
    });
  } catch (e) {
    toastError(e);
    return null;
  }
}

function disposeTimeMachine(t) {
  const tm = t?.timeMachine;
  if (!tm) return;
  stopPlayback(t);
  clearInterval(tm.poll);
  tm.poll = null;
}

function paintHead(t) {
  t.el.querySelector('.pane-title').textContent = t.title;
  t.el.querySelector('.pane-cwd').innerHTML = `<bdi>${esc(t.procTitle || tildify(t.cwd, home))}</bdi>`;
  t.el.querySelector('.dot').className = `dot ${dotClass(t)}`;
  t.el.classList.toggle('exited', t.exited);
  onChange();
}

// Repaints the agent badge in place: dogwatch may discover a different CLI than
// the role default (a qa1 window can run OpenCode instead of Codex).
function paintAgentBadge(t, badge) {
  t.agent = badge;
  let el = t.agentBadgeEl;
  if (!el) {
    const head = t.el.querySelector('.pane-head');
    el = document.createElement('span');
    el.className = 'pane-badge pane-agent-badge';
    const cwd = head.querySelector('.pane-cwd');
    if (cwd) head.insertBefore(el, cwd);
    else head.appendChild(el);
    t.agentBadgeEl = el;
  }
  el.dataset.agent = badge.id;
  el.textContent = badge.text;
  el.title = badge.name;
  el.setAttribute?.('title', badge.name);
  el.style.setProperty('--agent-tint-1', badge.tint[0]);
  el.style.setProperty('--agent-tint-2', badge.tint[1]);
}

// Updates the badge of the pane whose tmux window (name or id) or title matches.
// `projectPath` scopes the search: every project has its own dev1/qa1 window.
export function updateTerminalAgentBadge(tmuxNameOrId, agentId, projectPath = null) {
  const key = String(tmuxNameOrId || '');
  const badge = agentBadgeFor(agentId);
  if (!key || !badge) return null;
  const matches = [...all.values(), ...pending].filter((t) =>
    t.tmuxName === key || t.tmuxWindow === key || t.title === key);
  const panes = projectPath ? matches.filter((t) => t.project?.path === projectPath) : matches;
  for (const pane of panes) {
    pane.agentId = agentId;
    paintAgentBadge(pane, badge);
  }
  return panes[0] || null;
}

const shellQuote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

const dotClass = (t) => (t.kind === 'webview' ? 'web' : t.exited ? 'exited' : t.kind === 'agent' ? 'working' : t.kind === 'run' ? 'running' : 'shell');

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
  if (!t || t.console) return;
  const p = t.project;
  if (p.focusedId !== id) {
    p.focusedId = id;
    for (const x of terminalsOf(p)) x.el.classList.toggle('focused', x.id === id);
    onChange();
  }
  if (p !== active) return;
  // A pane hidden by maximize has no visible caret: bring it back first.
  if (p.maximizedId && p.maximizedId !== id) toggleMax(id);
  // Move the real caret into xterm even when this pane already had the
  // highlight: the palette closes without restoring focus, so typing must land
  // on the pane's textarea without another click or Tab.
  if (t.term) t.term.focus();
  else t.focus?.();
}

export function closeTerminal(id) {
  const t = all.get(id);
  if (!t) return;
  if (t.kind !== 'webview' && !t.exited) work.pty.kill(id);
  all.delete(id);
  closedIds.add(id);
  const p = t.project;
  if (p.maximizedId === id) p.maximizedId = null;
  // Take the rectangle out of the tree now: the survivors grow while the
  // closing pane plays its exit animation in the space it last occupied.
  removeLeaf(p, t);
  disposeTimeMachine(t);
  t.search?.dispose();
  t.dispose?.();
  t.el.classList.add('closing');
  relayout();
  afterExit(t.el, () => {
    t.term?.dispose();
    t.el.remove();
    relayout();
  });
  if (p.focusedId === id) {
    p.focusedId = null;
    const next = terminalsOf(p).pop();
    if (next) {
      focus(next.id);
      if (p === active) (next.term ? next.term.focus() : next.focus?.());
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
  relayout();
  requestAnimationFrame(fitAll);
  if (t.term) t.term.focus();
  else t.focus?.();
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
        <div class="li-sub"><code>${esc(t.kind === 'webview' ? t.url || 'No address' : tildify(t.cwd, home))}</code></div>
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
      requestAnimationFrame(() => (t.term ? t.term.focus() : t.focus?.()));
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
  removeLeaf(from, t);
  t.project = project;
  t.el.classList.toggle('off', project !== active);
  t.el.classList.remove('focused');
  insertLeaf(project, t, { after: currentPaneOf(project) });
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
    const horizontal = r.width > r.height * 1.2;
    const after = horizontal ? x > r.left + r.width / 2 : y > r.top + r.height / 2;
    mark({ kind: 'pane', el: zone.el, after, horizontal });
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
        moveLeaf(t.project, t, drop.el._t, {
          after: drop.after,
          direction: drop.horizontal ? 'horizontal' : 'vertical',
        });
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
  // A docked preview is not a tmux window: restoring it from state.json would
  // make the next launch ask tmux for a window that never existed.
  const open = terminalsOf(project).filter((t) => t.kind !== 'webview');
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
    // The window command (start or foreground) is more reliable than the role
    // default: a qa1 window may run OpenCode, not Codex.
    const detectedAgentId = agentIdFromCommand(win.startCommand, win.currentCommand);
    const pane = await openTerminal(project, {
      cwd: win.path || win.saved?.cwd || project.path,
      title: win.title,
      tmuxSession: session,
      tmuxWindow: win.id,
      tmuxName: win.name,
      role: win.saved?.role || role?.name || null,
      agentId: detectedAgentId || win.saved?.agentId || role?.agentId || null,
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
      agentId: agentIdFromCommand(command) || entry.agentId || role?.agentId || null,
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

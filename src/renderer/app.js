import { $, $$, esc, basename, ask, toast, toastError, setHtml, contextMenu, clip, tooltip, refreshTip } from './ui.js';
import { ProjectTree } from './tree.js';
import { previewFile } from './preview.js';
import { closeReview } from './review.js';
import {
  initTerminals, openTerminal, closeTerminal, closeProjectTerminals, toggleMax, showProject,
  terminalsOf, renderTermList, pollCwd, focused, copySelection, pasteInto, renameTerminal, moveToProject,
} from './terminals.js';
import { initGit, showGit, refreshGit, showWorkingDiff, setGitHooks, setGraphVisible } from './gitpanel.js';
import { initAgents, renderAgentList, agentStateFor, inside } from './agentsview.js';
import { initRun, showRun, runningIn, detect as detectRun, forgetProject, runningCount } from './run.js';
import { initLauncher, launchDefault, resumeClaude } from './launcher.js';
import { openAppearance } from './appearance.js';
import { tildify } from './paths.js';
import { isRefreshKey, isCloseTerminalKey } from './keys.js';

const { work } = window;

let info = { cwd: '/', home: '/', platform: 'linux' };
const projects = [];
let active = null;

// ── Projects ─────────────────────────────────────────────────

const serialize = () => projects.map((p) => ({ path: p.path, run: p.run }));

function save() {
  work.projects.save({ projects: serialize(), active: active?.path || null });
}

function projectFor(cwd) {
  // Deepest project containing the folder.
  return projects.filter((p) => inside(cwd, p.path)).sort((a, b) => b.path.length - a.path.length)[0] || null;
}

async function addProject(path, { activate = true, withTerminal = true, run = null } = {}) {
  const existing = projects.find((p) => p.path === path);
  if (existing) {
    if (activate) await activateProject(existing);
    return existing;
  }
  const p = {
    path,
    name: basename(path),
    root: await work.git.root(path),
    gitStatus: null,
    draft: '',
    focusedId: null,
    maximizedId: null,
    run: run || { selected: null, custom: [] },
  };
  p.tree = new ProjectTree(p, treeHooks(p));
  if (p.root) work.git.watch(p.root);
  projects.push(p);
  // Register the folder first: the main process only allows fs access inside open projects.
  await work.projects.save({ projects: serialize() });
  if (activate) await activateProject(p);
  if (withTerminal) openTerminal(p);
  renderProjectTabs();
  return p;
}

async function activateProject(p) {
  active = p;
  save();
  closeReview();
  renderProjectTabs();
  showProject(p);
  renderTermList(p);
  p.tree.mount($('#tree'));
  $('#status-repo').textContent = tildify(p.path, info.home);
  renderAgentList();
  showRun(p);
  await showGit(p);
}

async function closeProject(p) {
  const shells = terminalsOf(p).filter((t) => !t.exited).length;
  const runs = runningCount(p);
  if (shells || runs) {
    const parts = [];
    if (shells) parts.push(shells === 1 ? 'il terminale aperto' : `i ${shells} terminali aperti`);
    if (runs) parts.push(runs === 1 ? 'il processo in esecuzione' : `i ${runs} processi in esecuzione`);
    const ok = await ask({
      text: `Chiudere ${p.name}? Verranno chiusi ${parts.join(' e ')}.`,
      okLabel: 'Chiudi progetto', danger: true, input: false,
    });
    if (!ok) return;
  }
  forgetProject(p);
  closeProjectTerminals(p);
  if (p.root && !projects.some((x) => x !== p && x.root === p.root)) work.git.unwatch(p.root);
  const i = projects.indexOf(p);
  projects.splice(i, 1);
  if (active === p) {
    active = null;
    const next = projects[i] || projects[i - 1];
    if (next) await activateProject(next);
    else showWelcome();
  }
  save();
  renderProjectTabs();
}

async function pickProject() {
  const dir = await work.app.pickFolder();
  if (dir) await addProject(dir);
}

function showWelcome() {
  showProject(null);
  renderTermList(null);
  $('#tree').innerHTML = '';
  $('#status-repo').textContent = '';
  $('#term-empty').hidden = false;
  showRun(null);
  showGit(null);
  renderAgentList();
}

function renderProjectTabs() {
  const box = $('#project-tabs');
  const changed = setHtml(box, projects.map((p, i) => {
    const agent = agentStateFor(p.path);
    const branch = p.gitStatus?.branch.name;
    const changes = p.gitStatus ? p.gitStatus.staged.length + p.gitStatus.unstaged.length : 0;
    return `<div class="ptab${p === active ? ' active' : ''}" data-i="${i}" data-path="${esc(p.path)}" title="${esc(p.path)}">
      ${runningIn(p) ? '<span class="ptab-run" title="In esecuzione"></span>' : ''}
      ${agent ? `<span class="dot ${agent}"></span>` : ''}
      <span class="ptab-name">${esc(p.name)}</span>
      ${branch ? `<span class="ptab-branch">${esc(branch)}${changes ? '<i>•</i>' : ''}</span>` : ''}
      <button class="ptab-close" title="Chiudi progetto">✕</button>
    </div>`;
  }).join(''));
  if (changed) for (const el of box.children) {
    const p = projects[Number(el.dataset.i)];
    el.onpointerdown = (e) => {
      if (e.button === 1) {
        e.preventDefault();
        closeProject(p);
        return;
      }
      if (e.button !== 0 || e.target.closest('.ptab-close')) return;
      // Highlight on press, switch on release unless it turned into a drag.
      startTabDrag(el, e, () => p !== active && activateProject(p));
    };
    el.oncontextmenu = (e) => {
      e.preventDefault();
      projectMenu(p, e.clientX, e.clientY);
    };
    el.querySelector('.ptab-close').onclick = () => closeProject(p);
  }
  $('#empty-text').textContent = active ? 'Nessun terminale aperto' : 'Apri un progetto per iniziare';
  $('#empty-new-term').textContent = active ? '＋ Apri un terminale' : '＋ Apri progetto…';
}

// ── Project tabs: drag to reorder ───────────────────────────
// The grabbed tab follows the pointer 1:1 along the strip (rubber-banding at
// the ends); neighbours slide aside to show where it will land.

const rubber = (over, dim, c = 0.55) => (over * dim * c) / (dim + c * Math.abs(over));

function startTabDrag(el, e, onTap) {
  const strip = $('#project-tabs');
  const tabs = [...strip.children];
  const from = tabs.indexOf(el);
  el.classList.add('pressed');
  try {
    el.setPointerCapture(e.pointerId);
  } catch {
    // pointer already released
  }
  const x0 = e.clientX;
  const rects = tabs.map((t) => t.getBoundingClientRect());
  const stripRect = strip.getBoundingClientRect();
  const gap = rects.length > 1 ? rects[1].left - rects[0].right : 4;
  const w = rects[from].width + gap;
  let dragging = false;
  let to = from;

  const move = (ev) => {
    let dx = ev.clientX - x0;
    if (!dragging) {
      if (Math.abs(dx) < 5 || tabs.length < 2) return;
      dragging = true;
      el.classList.add('dragging');
      strip.classList.add('reordering');
    }
    // Soft limits at the strip edges.
    const minDx = stripRect.left - rects[from].left;
    const maxDx = stripRect.right - rects[from].right;
    if (dx < minDx) dx = minDx + rubber(dx - minDx, 120);
    if (dx > maxDx) dx = maxDx + rubber(dx - maxDx, 120);
    el.style.transform = `translateX(${dx}px)`;
    const center = rects[from].left + rects[from].width / 2 + dx;
    to = rects.findIndex((r) => center < r.left + r.width / 2);
    if (to === -1) to = tabs.length - 1;
    else if (to > from) to -= 1;
    tabs.forEach((t, i) => {
      if (t === el) return;
      const shift = from < to && i > from && i <= to ? -w : from > to && i < from && i >= to ? w : 0;
      t.style.transform = shift ? `translateX(${shift}px)` : '';
    });
  };

  const end = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', end);
    el.removeEventListener('pointercancel', end);
    el.classList.remove('pressed');
    if (!dragging) {
      onTap();
      return;
    }
    // Settle: reorder the model, re-render, glide from the on-screen positions.
    const first = new Map(tabs.map((t) => [t.dataset.path, t.getBoundingClientRect()]));
    tabs.forEach((t) => {
      t.style.transform = '';
    });
    el.classList.remove('dragging');
    strip.classList.remove('reordering');
    if (to !== from) {
      const [moved] = projects.splice(from, 1);
      projects.splice(to, 0, moved);
      save();
    }
    renderProjectTabs();
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    for (const t of strip.children) {
      const f = first.get(t.dataset.path);
      if (!f) continue;
      const dx = f.left - t.getBoundingClientRect().left;
      if (Math.abs(dx) > 0.5) t.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: 280, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
    }
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

// ── Context menus ───────────────────────────────────────────
// Only actions that belong to the thing under the pointer; the most common
// first, destructive ones last and separated.

function terminalMenu(t, x, y) {
  if (t.console) {
    // Run console: output only.
    contextMenu(x, y, [
      { label: 'Copia', hint: 'Ctrl+Shift+C', disabled: !t.term.getSelection(), run: () => copySelection(t) },
      { label: 'Seleziona tutto', run: () => t.term.selectAll() },
      { label: 'Pulisci output', run: () => t.term.clear() },
    ]);
    return;
  }
  const others = projects.filter((p) => p !== t.project);
  const hasSel = !!t.term.getSelection();
  const isMax = t.project.maximizedId === t.id;
  contextMenu(x, y, [
    { label: 'Copia', hint: 'Ctrl+Shift+C', disabled: !hasSel, run: () => copySelection(t) },
    { label: 'Incolla', hint: 'Ctrl+Shift+V', disabled: t.exited, run: () => pasteInto(t) },
    { label: 'Seleziona tutto', run: () => t.term.selectAll() },
    { label: 'Pulisci schermo', run: () => t.term.clear() },
    '-',
    { label: 'Nuovo terminale nella stessa cartella', run: () => openTerminal(t.project, { cwd: t.cwd }) },
    {
      label: 'Rinomina…',
      run: async () => {
        const name = await ask({ text: 'Nome del terminale', value: t.title, okLabel: 'Rinomina' });
        if (name) renameTerminal(t, name);
      },
    },
    { label: isMax ? 'Ripristina dimensione' : 'Ingrandisci', hint: 'Ctrl+Shift+M', run: () => toggleMax(t.id) },
    { label: 'Copia percorso della cartella', run: () => work.app.copy(t.cwd) },
    ...(others.length ? ['-', { header: 'Sposta nel progetto' }, ...others.map((p) => ({ label: p.name, run: () => moveTerminal(t, p) }))] : []),
    '-',
    { label: t.exited ? 'Chiudi' : 'Chiudi terminale', hint: 'Ctrl+Shift+W', run: () => closeTerminal(t.id) },
  ]);
}

function moveTerminal(t, p) {
  const from = t.project;
  moveToProject(t, p);
  save();
  renderTermList(active);
  toast(`${t.title} spostato in ${p.name}`, {
    action: { label: 'Annulla', run: () => { moveToProject(t, from); renderTermList(active); } },
  });
}

function projectMenu(p, x, y) {
  const others = projects.filter((o) => o !== p);
  const open = async () => {
    if (p !== active) await activateProject(p);
  };
  contextMenu(x, y, [
    { label: 'Nuovo terminale', run: async () => { await open(); openTerminal(p); } },
    { label: 'Nuovo agente (ultimo usato)', hint: 'Ctrl+Shift+A', run: async () => { await open(); launchDefault(); } },
    '-',
    { label: 'Aggiorna', hint: 'F5', run: async () => { await open(); refreshAll(); } },
    { label: 'Mostra nel file manager', run: () => work.fs.openPath(p.path) },
    { label: 'Copia percorso', run: () => work.app.copy(p.path) },
    '-',
    { label: 'Chiudi gli altri progetti', disabled: !others.length, run: async () => { for (const o of others) await closeProject(o); } },
    { label: 'Chiudi progetto', run: () => closeProject(p) },
  ]);
}

setGitHooks({
  preview: (abs) => active && treeHooks(active).preview(abs),
  reveal: (abs) => {
    if (!active) return;
    showTab('project');
    active.tree.reveal(abs);
  },
});

// Empty space in the terminal area.
$('#terminals').addEventListener('contextmenu', (e) => {
  if (e.target.closest('.pane') || !active) return;
  e.preventDefault();
  contextMenu(e.clientX, e.clientY, [
    { label: 'Nuovo terminale', hint: 'Ctrl+Shift+T', run: () => openTerminal(active) },
    { label: 'Nuovo agente (ultimo usato)', hint: 'Ctrl+Shift+A', run: () => launchDefault() },
    '-',
    { label: 'Apri un altro progetto…', hint: 'Ctrl+Shift+O', run: pickProject },
  ]);
});

// ── Resizable side columns ──────────────────────────────────
// Drag the edge 1:1; past the limits it resists (rubber band) and springs
// back to the limit on release. Double-click restores the default width.

const SIZES = {
  left: { prop: '--left-size', def: 256, min: 190, max: 460, key: 'work.leftSize' },
  right: { prop: '--right-size', def: 440, min: 340, max: 760, key: 'work.rightSize' },
};

function setSize(side, px, persist) {
  const c = SIZES[side];
  $('.layout').style.setProperty(c.prop, `${Math.round(px)}px`);
  if (persist) {
    try {
      localStorage.setItem(c.key, String(Math.round(px)));
    } catch {
      // not persisted
    }
  }
}

for (const side of Object.keys(SIZES)) {
  const c = SIZES[side];
  try {
    const saved = Number(localStorage.getItem(c.key));
    if (saved) setSize(side, Math.min(c.max, Math.max(c.min, saved)), false);
  } catch {
    // default width
  }
  const handle = $(`.splitter[data-side="${side}"]`);
  handle.addEventListener('dblclick', () => setSize(side, c.def, true));
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      // pointer already released
    }
    const layout = $('.layout');
    const start = parseFloat(getComputedStyle(layout).getPropertyValue(c.prop)) || c.def;
    const x0 = e.clientX;
    layout.classList.add('resizing');
    handle.classList.add('active');
    let raw = start;
    const move = (ev) => {
      raw = start + (side === 'left' ? ev.clientX - x0 : x0 - ev.clientX);
      let w = raw;
      if (w < c.min) w = c.min + rubber(w - c.min, 160);
      if (w > c.max) w = c.max + rubber(w - c.max, 160);
      setSize(side, w, false);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      handle.classList.remove('active');
      layout.classList.remove('resizing'); // re-enables the width transition for the settle
      setSize(side, Math.min(c.max, Math.max(c.min, raw)), true);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
}

// ── Event-driven refresh ────────────────────────────────────
// Terminal output means something may have changed (a command finished, an
// agent edited files, `cd` redrew the prompt): refresh that terminal's folder
// and the project's git status — at most once every 2.5 s per terminal and
// per project, however many panes keep printing, instead of polling.
const cwdTimers = new Map();
const gitTimers = new Map();
function throttle(timers, key, fn) {
  if (timers.has(key)) return;
  timers.set(key, setTimeout(() => {
    timers.delete(key);
    fn();
  }, 2500));
}
function onTerminalActivity(t) {
  // Only interactive shells change folder; agents and Run consoles don't `cd`.
  if (t.kind === 'shell') throttle(cwdTimers, t, () => !t.exited && pollCwd(t));
  throttle(gitTimers, t.project, () => projects.includes(t.project) && refreshGit(t.project));
}

// ── Hooks between modules ───────────────────────────────────

function treeHooks(p) {
  const relToRepo = (abs) => (p.root && abs.startsWith(`${p.root}/`) ? abs.slice(p.root.length + 1) : null);
  const isChanged = (abs) => {
    const rel = relToRepo(abs);
    const st = p.gitStatus;
    return !!rel && !!st && [...st.staged, ...st.unstaged].some((f) => f.file === rel);
  };
  return {
    openTerminal: (cwd) => openTerminal(p, { cwd }),
    showDiff: (abs) => showWorkingDiff(p, relToRepo(abs)),
    preview: (abs) => previewFile(abs, { onDiff: isChanged(abs) ? () => showWorkingDiff(p, relToRepo(abs)) : null }),
    refreshGit: () => refreshGit(p),
  };
}

async function refreshAll() {
  if (!active) return;
  const btn = $('#refresh');
  btn.classList.add('spin');
  await Promise.all([active.tree.reload(), refreshGit(active, true), detectRun(active)]);
  renderAgentList();
  btn.addEventListener('animationiteration', () => btn.classList.remove('spin'), { once: true });
}

function showTab(name) {
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab-body').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  if (name === 'project') $('#tree').focus({ preventScroll: true });
  setGraphVisible(name === 'graph');
}
$$('#tabs button').forEach((b) => {
  b.onpointerdown = () => showTab(b.dataset.tab);
});

// ── Side panels ─────────────────────────────────────────────
// Left (terminals + sessions) collapses to the left, right (project/git/agent)
// to the right; each returns along the same path. Grid widths transition from
// their current value, so a second click mid-way simply reverses.

const PANELS = {
  left: { cls: 'sidebar-hidden', btn: '#toggle-sidebar', key: 'work.sidebar' },
  right: { cls: 'panel-hidden', btn: '#toggle-panel', key: 'work.panel' },
};

function setPanel(side, open, persist = true) {
  const p = PANELS[side];
  document.body.classList.toggle(p.cls, !open);
  $(p.btn).setAttribute('aria-pressed', String(open));
  if (persist) {
    try {
      localStorage.setItem(p.key, open ? '1' : '0');
    } catch {
      // storage unavailable: keep the state for this session only
    }
  }
}
const panelOpen = (side) => !document.body.classList.contains(PANELS[side].cls);
const togglePanel = (side) => setPanel(side, !panelOpen(side));
// Close buttons live in each panel's header (next to what they hide); the
// reopen buttons appear in the top bar only while their panel is hidden.
$$('.panel-collapse').forEach((b) => {
  b.onpointerdown = (e) => e.button === 0 && setPanel(b.dataset.panel, false);
});
for (const side of Object.keys(PANELS)) {
  $(PANELS[side].btn).onpointerdown = (e) => e.button === 0 && setPanel(side, true);
  let open = true;
  try {
    open = localStorage.getItem(PANELS[side].key) !== '0';
  } catch {
    // default: visible
  }
  setPanel(side, open, false);
}

// ── Commands & shortcuts ────────────────────────────────────

const newTerminal = () => (active ? openTerminal(active) : pickProject());

$('#new-project').onclick = pickProject;
$('#refresh').onclick = refreshAll;
$('#new-term').onclick = newTerminal;
$('#empty-new-term').onclick = newTerminal;
$('#tree-new-file').onclick = () => active?.tree.create(active.tree.selected || active.path, false);
$('#tree-new-dir').onclick = () => active?.tree.create(active.tree.selected || active.path, true);
$('#tree-collapse').onclick = () => {
  if (!active) return;
  active.tree.expanded = new Set([active.path]);
  active.tree.render();
};

addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === 'b') {
    e.preventDefault();
    e.stopPropagation();
    togglePanel('right');
    return;
  }
  if (isRefreshKey(e)) {
    e.preventDefault();
    refreshAll();
    return;
  }
  if (isCloseTerminalKey(e, info.platform === 'darwin')) {
    e.preventDefault();
    e.stopPropagation();
    if (active?.focusedId) closeTerminal(active.focusedId);
    return;
  }
  const mod = (e.ctrlKey || e.metaKey) && e.shiftKey;
  if (!mod) return;
  const t = focused();
  if (t && (e.key === 'C' || e.key === 'c') && document.activeElement?.closest('.pane')) {
    e.preventDefault();
    e.stopPropagation();
    copySelection(t);
    return;
  }
  if (t && (e.key === 'V' || e.key === 'v') && document.activeElement?.closest('.pane')) {
    e.preventDefault();
    e.stopPropagation();
    pasteInto(t);
    return;
  }
  const actions = {
    T: newTerminal,
    A: () => active && launchDefault(),
    O: pickProject,
    B: () => togglePanel('left'),
    M: () => active?.focusedId && toggleMax(active.focusedId),
  };
  const fn = actions[e.key.toUpperCase()];
  if (fn) {
    e.preventDefault();
    e.stopPropagation();
    fn();
  }
}, true);

// ── Status bar: shortcuts, machine load, version ────────────
// The bar shows the glanceable part (two gauges, the version); the details
// are one level deeper, in tooltips that grow out of each item.

const GB = 1024 ** 3;
const pct = (x) => `${Math.round(x * 100)}%`;
let stats = null;

const SHORTCUTS = [
  ['Nuovo terminale', 'Ctrl+Shift+T'],
  ['Nuovo agente', 'Ctrl+Shift+A'],
  ['Apri progetto', 'Ctrl+Shift+O'],
  ['Chiudi terminale', 'Ctrl+Shift+W'],
  ['Ingrandisci terminale', 'Ctrl+Shift+M'],
  ['Pannello sinistro / destro', 'Ctrl+Shift+B', 'Ctrl+Alt+B'],
  ['Avvia / ferma', 'Shift+F10', 'Ctrl+F2'],
  ['Aggiorna', 'F5'],
];
const kbd = (k) => `<span class="tip-combo">${k.split('+').map((x) => `<kbd>${esc(x)}</kbd>`).join('')}</span>`;
const OS_NAMES = { linux: 'Linux', darwin: 'macOS', win32: 'Windows' };

const row = (label, value) => `<dt>${label}</dt><dd>${value}</dd>`;
const bar = (v) => `<i class="tip-bar${v > 0.85 ? ' high' : ''}"><b style="--v:${v.toFixed(3)}"></b></i>`;

function statsTip() {
  if (!stats) return '<div class="tip-note">Lettura in corso…</div>';
  const s = stats;
  const mb = (b) => `${Math.round(b / 1024 ** 2)} MB`;
  return `<h4>Sistema</h4><dl>
      ${row('CPU', `${pct(s.cpu)} ${bar(s.cpu)}`)}
      ${row('Memoria', `${(s.memUsed / GB).toFixed(1)} di ${(s.memTotal / GB).toFixed(0)} GB ${bar(s.memUsed / s.memTotal)}`)}
      ${row('Carico medio', `${s.load.map((l) => l.toFixed(2)).join(' · ')}`)}
      ${row('Core', s.cores)}
    </dl><h4>Work</h4><dl>
      ${row('Memoria', mb(s.work.mem))}
      ${row('CPU', pct(s.work.cpu))}
    </dl><div class="tip-note">Work senza shell e agenti dei terminali · ogni 3 s</div>`;
}

function initStatusBar() {
  tooltip($('#status-keys'), () => `<h4>Scorciatoie</h4><dl class="tip-keys">${
    SHORTCUTS.map(([label, ...keys]) => row(esc(label), keys.map(kbd).join('<span class="tip-or">/</span>'))).join('')}</dl>`);
  tooltip($('#status-sys'), statsTip);
  const v = info.versions;
  $('#status-version').textContent = `v${info.version}`;
  tooltip($('#status-version'), () => `<div class="tip-title">Work ${esc(info.version)}</div><dl>
      ${row('Electron', esc(v.electron))}${row('Chromium', esc(v.chrome))}${row('Node', esc(v.node))}
      ${row('Sistema', `${esc(OS_NAMES[info.platform] || info.platform)} ${esc(info.arch)}`)}</dl>`);
  refreshStats();
  setInterval(refreshStats, 3000);
}

function setGauge(el, v, text) {
  el.classList.toggle('high', v > 0.85);
  el.querySelector('b').style.setProperty('--v', v.toFixed(3));
  el.querySelector('em').textContent = text;
}

// Every 3 s, and only while the window is visible: numbers that change
// constantly pull the eye, and a hidden window has no one to show them to.
async function refreshStats() {
  if (document.hidden) return;
  stats = await work.app.stats();
  setGauge($('#gauge-cpu'), stats.cpu, pct(stats.cpu));
  setGauge($('#gauge-ram'), stats.memUsed / stats.memTotal, pct(stats.memUsed / stats.memTotal));
  refreshTip($('#status-sys'));
}

// ── Boot ────────────────────────────────────────────────────

(async () => {
  info = await work.app.info();
  if (info.platform === 'darwin') document.body.classList.add('mac');

  initTerminals({
    homeDir: info.home,
    changed: () => active && renderTermList(active),
    openAppearance,
    activity: onTerminalActivity,
    menu: terminalMenu,
    // Dropping a pane on another project's tab moves it there.
    dropOnTab: (t, tabEl) => {
      const p = projects[Number(tabEl.dataset.i)];
      if (!p || p === t.project) return false;
      moveTerminal(t, p);
      return true;
    },
  });
  // .git changed: an index-only change (stage) needs the status, anything else
  // (commit, checkout, fetch…) also branches and graph.
  work.git.onChanged((repo, kind) => projects.filter((p) => p.root === repo).forEach((p) => refreshGit(p, kind !== 'index')));
  initGit({
    statusChanged: (p) => {
      p.tree.setGitStatus(p.gitStatus, p.root);
      renderProjectTabs();
      if (p === active) {
        const n = p.gitStatus ? p.gitStatus.staged.length + p.gitStatus.unstaged.length : 0;
        $('#toggle-panel').dataset.changes = n ? '1' : '';
      }
    },
  });
  initRun({
    save,
    changed: renderProjectTabs,
    reveal: () => {
      setPanel('right', true);
      showTab('run');
    },
  });
  initLauncher({ activeProject: () => active });
  initAgents({
    homeDir: info.home,
    activeProject: () => active,
    showTab,
    changed: renderProjectTabs,
    resume: async (a) => {
      const p = projectFor(a.cwd) || await addProject((await work.git.root(a.cwd)) || a.cwd, { withTerminal: false });
      if (p !== active) await activateProject(p);
      try {
        resumeClaude(p, a.cwd, a.id, clip(a.title, 40));
      } catch (e) {
        toastError(e);
      }
    },
    shellAt: (cwd) => active && openTerminal(projectFor(cwd) || active, { cwd }),
    openRepo: async (cwd) => {
      await addProject((await work.git.root(cwd)) || cwd, { withTerminal: false });
      showTab('project');
    },
  });

  const saved = await work.projects.load();
  // Check every saved folder before adding any: adding re-saves the project list,
  // which is also what authorizes file access in the main process.
  const valid = [];
  for (const entry of saved.projects || []) {
    try {
      await work.fs.list(entry.path);
      valid.push(entry);
    } catch {
      // folder removed since last session
    }
  }
  for (const { path, run } of valid) await addProject(path, { activate: false, withTerminal: false, run });
  if (!projects.length) {
    const root = await work.git.root(info.cwd);
    if (root) await addProject(root, { activate: false, withTerminal: false });
  }
  const first = projects.find((p) => p.path === saved.active) || projects[0];
  if (first) {
    await activateProject(first);
    if (!terminalsOf(first).length) openTerminal(first);
  } else showWelcome();
  projects.filter((p) => p !== active).forEach((p) => refreshGit(p));
  renderProjectTabs();
  initStatusBar();
  performance.mark('work:ready'); // boot finished: read with performance.getEntriesByName

  // Safety-net polling only: real updates are event-driven (.git watcher + terminal activity).
  setInterval(() => refreshGit(active), 20000);
  setInterval(() => projects.filter((p) => p !== active).forEach((p) => refreshGit(p)), 60000);
  work.app.onFocus(() => active?.tree.reload());
})().catch(toastError);

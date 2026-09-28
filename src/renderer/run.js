// Run configurations, WebStorm style: pick a command (npm script, make
// target…), start / rerun / stop it; output lives in a dedicated pane.
import { $, esc, ask, toast, contextMenu } from './ui.js';
import { openTerminal, closeTerminal, sendInput, killTerminal } from './terminals.js';
import { findLocalUrl } from './runurl.js';

const { work } = window;

let active = null;
let hooks = { save() {}, changed() {}, reveal() {} };
let shown = null; // run whose console is visible in the Run tab


export function initRun(opts) {
  hooks = { ...hooks, ...opts };
  wireRunTab();
  $('#run-config').onpointerdown = (e) => {
    if (e.button === 0) openMenu();
  };
  $('#run-start').onclick = () => startOrRerun();
  $('#run-stop').onclick = () => stop();
  $('#run-url').onclick = () => {
    const r = current();
    if (r?.url) work.app.openExternal(r.url);
  };

  addEventListener('keydown', (e) => {
    if (!active) return;
    // WebStorm keys: Shift+F10 run, Ctrl+F5 rerun, Ctrl+F2 stop
    if (e.key === 'F10' && e.shiftKey) startOrRerun();
    else if (e.key === 'F5' && (e.ctrlKey || e.metaKey)) startOrRerun();
    else if (e.key === 'F2' && (e.ctrlKey || e.metaKey)) stop();
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);
}

function ensure(p) {
  p.run ??= { selected: null, custom: [] };
  p.runs ??= new Map();
  return p;
}

export async function showRun(project) {
  active = project;
  if (project) {
    ensure(project);
    if (!project.detected) await detect(project);
  }
  render();
}

export async function detect(p) {
  ensure(p);
  try {
    p.detected = await work.run.detect(p.path);
  } catch {
    p.detected = [];
  }
  if (p === active) render();
}

function configs(p) {
  return [...(p.detected || []), ...p.run.custom.map((c) => ({ ...c, group: 'personalizzati', custom: true }))];
}

function selected(p = active) {
  if (!p) return null;
  const list = configs(p);
  return list.find((c) => c.id === p.run.selected) || list[0] || null;
}

function current() {
  const cfg = selected();
  return cfg ? active.runs.get(cfg.id) : null;
}

export const isRunning = (r) => !!r && (r.status === 'running' || r.status === 'stopping');
export const runningIn = (p) => !!p?.runs && [...p.runs.values()].some(isRunning);

// ── Actions ──

async function start(p, cfg) {
  const prev = p.runs.get(cfg.id);
  if (prev?.t) closeTerminal(prev.t.id); // a rerun replaces the old console
  prev?.box?.remove();
  // Runs in the background: its console lives in the Run tab, not in the terminal grid.
  const box = document.createElement('div');
  box.className = 'run-console';
  box.dataset.project = p.path;
  $('#run-output').appendChild(box);
  const r = { status: 'running', url: null, started: Date.now(), cfg, box };
  p.runs.set(cfg.id, r);
  if (!shown || shown.status === 'exited' || shown === prev) shown = r;
  render();
  hooks.changed();
  r.t = await openTerminal(p, {
    command: cfg.command,
    title: cfg.name,
    kind: 'run',
    focus: false,
    container: box,
    onOutput: (data) => {
      if (r.url) return;
      // Only complete lines are searched: an address split across two chunks
      // ("…localhost:51" + "73/") is read once its line has ended.
      const text = (r.partial || '') + data;
      const end = text.lastIndexOf('\n') + 1;
      r.partial = text.slice(end).slice(-1024);
      r.url = findLocalUrl(text.slice(0, end));
      if (r.url && p === active) render();
    },
    onExit: (code) => {
      const wasStopping = r.status === 'stopping';
      r.stopped = wasStopping; // stopped on purpose: not a failure (npm exits 130 on Ctrl+C)
      r.status = 'exited';
      r.code = code;
      r.url = null;
      if (p === active) render();
      hooks.changed();
      if (r.restart) start(p, cfg);
      else if (code && !wasStopping) {
        toast(`${cfg.name} terminato con codice ${code}`, {
          error: true,
          action: { label: 'Mostra output', run: () => showOutput(p, r) },
        });
      }
    },
  });
  if (p === active) render(); // its terminal is ready: stop and clear apply to it now
}

function stop(p = active, cfg = selected(p)) {
  const r = cfg && p.runs.get(cfg.id);
  if (!isRunning(r) || !r.t) return;
  r.status = 'stopping';
  render();
  sendInput(r.t.id, '\x03'); // Ctrl+C: let the process shut down cleanly
  setTimeout(() => {
    if (r.status === 'stopping') killTerminal(r.t.id);
  }, 3000);
}

function startOrRerun() {
  const cfg = selected();
  if (!cfg) return openMenu();
  const r = active.runs.get(cfg.id);
  if (isRunning(r)) {
    r.restart = true;
    stop(active, cfg);
  } else start(active, cfg);
}

async function addCustom() {
  const command = await ask({ text: 'Comando da eseguire nella cartella del progetto', placeholder: 'npm run dev -- --port 4000', okLabel: 'Avanti' });
  if (!command) return;
  const name = await ask({ text: 'Nome della configurazione', value: command.split(/\s+/).slice(-1)[0], okLabel: 'Aggiungi' });
  if (!name) return;
  const cfg = { id: `custom:${Date.now()}`, name, command };
  active.run.custom.push(cfg);
  active.run.selected = cfg.id;
  hooks.save();
  render();
}

function openMenu() {
  if (!active) return;
  const p = active;
  const list = configs(p);
  const sel = selected(p);
  const items = [];
  let group = null;
  for (const c of list) {
    if (c.group !== group) {
      group = c.group;
      items.push({ header: group });
    }
    const r = p.runs.get(c.id);
    items.push({
      label: c.name,
      detail: c.command,
      checked: c.id === sel?.id,
      hint: isRunning(r) ? '● attivo' : '',
      run: () => {
        p.run.selected = c.id;
        hooks.save();
        render();
      },
    });
  }
  if (!list.length) items.push({ header: 'Nessun comando rilevato' });
  items.push('-');
  const r = current();
  if (r?.t) items.push({ label: 'Mostra output', run: () => showOutput(p, r) });
  items.push({ label: 'Aggiungi comando…', run: addCustom });
  if (sel?.custom) {
    items.push({
      label: `Rimuovi “${sel.name}”`,
      danger: true,
      run: () => {
        p.run.custom = p.run.custom.filter((c) => c.id !== sel.id);
        p.run.selected = null;
        hooks.save();
        render();
      },
    });
  }
  items.push({ label: 'Rileva di nuovo', run: () => detect(p) });
  // Anchor the menu to the trigger so it grows out of it.
  const b = $('#run-config').getBoundingClientRect();
  contextMenu(b.left, b.bottom + 6, items);
}

// Closing a project stops its processes (marked as stopped on purpose, so
// no failure toast or restart follows) and drops their consoles.
export function forgetProject(p) {
  if (!p.runs) return;
  for (const r of p.runs.values()) {
    r.status = 'stopping';
    r.restart = false;
    if (r.t) closeTerminal(r.t.id);
    r.box?.remove();
    if (shown === r) shown = null;
  }
  p.runs.clear();
  if (active === p) active = null;
  render();
}

export const runningCount = (p) => (p.runs ? [...p.runs.values()].filter(isRunning).length : 0);

// ── Run tab (WebStorm's Run tool window) ──

export function showOutput(p, r) {
  if (r) shown = r;
  hooks.reveal(); // open the right panel on the Run tab
  renderRunTab();
}

export function renderRunTab() {
  const list = $('#run-list');
  // A run counts from the moment its console exists, not once its terminal is
  // ready: otherwise the render right after ▶ drops it and nothing is shown.
  const runs = active ? [...active.runs.values()].filter((r) => r.box) : [];
  if (!runs.includes(shown)) shown = runs.find(isRunning) || runs[0] || null;
  $('#run-empty').hidden = runs.length > 0;
  list.innerHTML = runs.map((r, i) => {
    const st = isRunning(r) ? (r.status === 'stopping' ? 'blocked' : 'running') : r.code && !r.stopped ? 'failed' : 'idle';
    return `<button class="run-chip${r === shown ? ' active' : ''}" data-i="${i}"><span class="dot ${st}"></span>${esc(r.cfg.name)}</button>`;
  }).join('');
  list.querySelectorAll('.run-chip').forEach((b) => {
    b.onpointerdown = () => {
      shown = runs[Number(b.dataset.i)];
      renderRunTab();
    };
  });
  for (const box of $('#run-output').children) box.hidden = !shown || box !== shown.box;
  const running = isRunning(shown);
  $('#run-tab-rerun').disabled = !shown;
  $('#run-tab-stop').disabled = !running;
  $('#run-tab-clear').disabled = !shown;
  $('#run-tab-url').hidden = !shown?.url;
  if (shown?.url) $('#run-tab-url').textContent = `${shown.url.replace(/^https?:\/\//, '')} ↗`;
  // Green dot on the tab while anything runs in this project.
  $('#run-tab-dot').className = runs.some(isRunning) ? 'dot running' : 'dot hidden';
  requestAnimationFrame(() => {
    try {
      shown?.t?.fit.fit();
    } catch {
      // console not visible yet
    }
  });
}

function wireRunTab() {
  $('#run-tab-rerun').onclick = () => {
    if (!shown) return;
    if (isRunning(shown)) {
      shown.restart = true;
      stop(active, shown.cfg);
    } else start(active, shown.cfg);
  };
  $('#run-tab-stop').onclick = () => shown && stop(active, shown.cfg);
  $('#run-tab-clear').onclick = () => shown?.t?.term.clear();
  $('#run-tab-url').onclick = () => shown?.url && work.app.openExternal(shown.url);
}

// ── View ──

export function render() {
  renderRunTab();
  const box = $('#run');
  box.hidden = !active;
  if (!active) return;
  const cfg = selected();
  const r = cfg && active.runs.get(cfg.id);
  const running = isRunning(r);
  const state = r?.status === 'stopping' ? 'blocked' : running ? 'running' : r?.status === 'exited' && r.code && !r.stopped ? 'failed' : 'idle';
  box.dataset.state = state;
  $('#run-dot').className = `dot ${state}`;
  $('#run-name').textContent = cfg ? cfg.name : 'Aggiungi configurazione';
  $('#run-config').title = cfg ? `${cfg.command}\n(clic per scegliere)` : 'Nessun comando rilevato: aggiungine uno';
  const startBtn = $('#run-start');
  startBtn.innerHTML = running ? '<span class="i-rerun">↻</span>' : '<span class="i-play"></span>';
  startBtn.title = running ? 'Riavvia (Ctrl+F5)' : 'Avvia (Shift+F10)';
  startBtn.disabled = !cfg;
  $('#run-stop').disabled = !running;
  const url = $('#run-url');
  url.hidden = !r?.url;
  if (r?.url) {
    url.innerHTML = `${esc(r.url.replace(/^https?:\/\//, ''))}<span>↗</span>`;
    url.title = `Apri ${r.url} nel browser`;
  }
}

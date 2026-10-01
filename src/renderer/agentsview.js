// Agents: sidebar list (this project first); a row opens to show its actions.
import { $, esc, ago, setHtml, setOpenRow, contextMenu, ask, toast, toastError } from './ui.js';

const { work } = window;

let agents = [];
let selected = null;
let hooks = {}; // { activeProject(), resume(agent), shellAt(cwd), openRepo(cwd), changed() }

export const inside = (cwd, path) => !!cwd && (cwd === path || cwd.startsWith(`${path}/`));

export function initAgents(opts) {
  hooks = opts;
  work.agents.onUpdate(setAgents);
  work.agents.list().then(setAgents);
  setInterval(() => agents.length && renderAgentList(), 10000);
}

function setAgents(list) {
  agents = list;
  if (selected && !list.some((a) => a.id === selected)) selected = null;
  renderAgentList();
  hooks.changed?.();
}

// Most urgent state among the agents working inside a folder.
export function agentStateFor(path) {
  const order = ['blocked', 'waiting', 'working'];
  const states = agents.filter((a) => inside(a.cwd, path)).map((a) => a.status.state);
  return order.find((s) => states.includes(s)) || null;
}

function item(a) {
  const open = a.id === selected;
  return `<li data-id="${a.id}" class="row-item${open ? ' open' : ''}" title="${esc(a.cwd || '')}">
    <button class="row-main" aria-expanded="${open}">
      <span class="dot ${a.status.state}"></span>
      <div class="li-main">
        <div class="li-title">${esc(a.title)}</div>
        <div class="li-sub">${esc(a.project)} · ${esc(a.status.label)}</div>
      </div>
      <span class="li-time">${ago(a.mtime)}</span>
      <span class="chev">›</span>
    </button>
    <div class="row-actions"><div><div class="row-btns">
      <button class="btn btn-small" data-act="resume">Riprendi</button>
      <button class="btn btn-small" data-act="shell"${a.cwd ? '' : ' disabled'}>Terminale</button>
      <button class="btn btn-small" data-act="repo"${a.cwd ? '' : ' disabled'}>Apri progetto</button>
      ${a.live ? '<button class="btn btn-small btn-danger-text" data-act="close">Chiudi</button>' : ''}
    </div></div></div>
  </li>`;
}

function toggle(id) {
  selected = selected === id ? null : id;
  setOpenRow($('#agent-list'), selected);
}

export function renderAgentList() {
  const project = hooks.activeProject();
  const mine = project ? agents.filter((a) => inside(a.cwd, project.path)) : [];
  const others = agents.filter((a) => !mine.includes(a));
  const list = $('#agent-list');
  $('#agent-count').textContent = agents.length;
  $('#agent-empty').hidden = agents.length > 0;
  const changed = setHtml(list, (mine.length ? `<li class="list-label">In questo progetto</li>${mine.map(item).join('')}` : '')
    + (others.length ? `<li class="list-label">${mine.length ? 'Altre sessioni' : 'Sessioni recenti'}</li>${others.map(item).join('')}` : ''));
  if (changed) for (const li of list.querySelectorAll('li[data-id]')) {
    const a = agents.find((x) => x.id === li.dataset.id);
    if (!a) continue;
    li.oncontextmenu = (e) => {
      e.preventDefault();
      agentMenu(a, e.clientX, e.clientY);
    };
    // Opens on pointerdown, like the other rows; Enter or Space arrive as a click with no pointer.
    const row = li.querySelector('.row-main');
    row.onpointerdown = (e) => e.button === 0 && toggle(a.id);
    row.onclick = (e) => e.detail === 0 && toggle(a.id);
    li.querySelector('[data-act="resume"]').onclick = () => hooks.resume(a);
    li.querySelector('[data-act="shell"]').onclick = () => hooks.shellAt(a.cwd);
    li.querySelector('[data-act="repo"]').onclick = () => hooks.openRepo(a.cwd);
    const close = li.querySelector('[data-act="close"]');
    if (close) close.onclick = () => closeSession(a);
  }
  const working = agents.filter((a) => a.status.state === 'working').length;
  const waiting = agents.filter((a) => a.status.state === 'waiting' || a.status.state === 'blocked').length;
  $('#status-agents').textContent = agents.length ? `${working} al lavoro · ${waiting} in attesa` : '';
  // Shown on the sidebar toggle while the list is hidden, so nothing urgent is missed.
  const urgent = ['blocked', 'waiting', 'working'].find((st) => agents.some((a) => a.status.state === st)) || '';
  $('#toggle-sidebar').dataset.agents = urgent;
  $('#status-agents').dataset.state = urgent;
}

// Ends the Claude Code process of a session. It interrupts whatever the agent
// is doing, so it asks first; the conversation stays resumable.
export async function closeSession(a) {
  const ok = await ask({
    text: `Chiudere «${a.title}»? Claude Code viene terminato; potrai riprendere la conversazione con «Riprendi».`,
    input: false,
    danger: true,
    okLabel: 'Chiudi sessione',
  });
  if (!ok) return;
  try {
    await work.agents.stop(a.id);
    toast('Sessione chiusa');
  } catch (e) {
    toastError(e);
  }
}

function agentMenu(a, x, y) {
  contextMenu(x, y, [
    { label: 'Riprendi sessione', run: () => hooks.resume(a) },
    '-',
    { label: 'Terminale nella cartella', disabled: !a.cwd, run: () => hooks.shellAt(a.cwd) },
    { label: 'Apri come progetto', disabled: !a.cwd, run: () => hooks.openRepo(a.cwd) },
    '-',
    { label: 'Copia percorso', disabled: !a.cwd, run: () => work.app.copy(a.cwd) },
    { label: 'Copia ID sessione', run: () => work.app.copy(a.id) },
    ...(a.live ? ['-', { label: 'Chiudi sessione', danger: true, run: () => closeSession(a) }] : []),
  ]);
}

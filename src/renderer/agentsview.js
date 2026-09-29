// Agents: sidebar list (this project first) + detail timeline in the panel.
import { $, esc, ago, setHtml, contextMenu, ask, toast, toastError } from './ui.js';
import { tildify } from './paths.js';

const { work } = window;

let agents = [];
let selected = null;
let home = '';
let hooks = {}; // { activeProject(), showTab(name), resume(agent), shellAt(cwd), openRepo(cwd), changed() }
const seen = new Map();

export const inside = (cwd, path) => !!cwd && (cwd === path || cwd.startsWith(`${path}/`));

export function initAgents(opts) {
  home = opts.homeDir;
  hooks = opts;
  work.agents.onUpdate(setAgents);
  work.agents.list().then(setAgents);
  setInterval(() => agents.length && renderAgentList(), 10000);
}

function setAgents(list) {
  agents = list;
  renderAgentList();
  if (selected) renderAgentDetail();
  hooks.changed?.();
}

// Most urgent state among the agents working inside a folder.
export function agentStateFor(path) {
  const order = ['blocked', 'waiting', 'working'];
  const states = agents.filter((a) => inside(a.cwd, path)).map((a) => a.status.state);
  return order.find((s) => states.includes(s)) || null;
}

function item(a) {
  return `<li data-id="${a.id}" class="${a.id === selected ? 'active' : ''}" title="${esc(a.cwd || '')}">
    <span class="dot ${a.status.state}"></span>
    <div class="li-main">
      <div class="li-title">${esc(a.title)}</div>
      <div class="li-sub">${esc(a.project)} · ${esc(a.status.label)}</div>
    </div>
    <span class="li-time">${ago(a.mtime)}</span>
  </li>`;
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
    li.oncontextmenu = (e) => {
      e.preventDefault();
      const a = agents.find((x) => x.id === li.dataset.id);
      if (a) agentMenu(a, e.clientX, e.clientY);
    };
    li.onpointerdown = (e) => {
      if (e.button !== 0) return;
      selected = li.dataset.id;
      renderAgentList();
      renderAgentDetail();
      hooks.showTab('agent');
    };
  }
  const working = agents.filter((a) => a.status.state === 'working').length;
  const waiting = agents.filter((a) => a.status.state === 'waiting' || a.status.state === 'blocked').length;
  $('#status-agents').textContent = agents.length ? `${working} al lavoro · ${waiting} in attesa` : '';
  // Shown on the sidebar toggle while the list is hidden, so nothing urgent is missed.
  const urgent = ['blocked', 'waiting', 'working'].find((st) => agents.some((a) => a.status.state === st)) || '';
  $('#toggle-sidebar').dataset.agents = urgent;
  $('#status-agents').dataset.state = urgent;
}

async function renderAgentDetail() {
  const a = agents.find((x) => x.id === selected);
  const box = $('#agent-detail');
  if (!a) {
    box._key = null;
    box._eventsKey = null;
    box.innerHTML = '<p class="empty">Seleziona un agente dalla colonna a sinistra.</p>';
    return;
  }
  const key = `${a.id}|${a.eventSeq}|${a.status.state}|${a.status.label}|${ago(a.mtime)}|${a.tokens}|${a.live}`;
  if (box._key === key) return; // nothing new to show
  box._key = key;
  // Events are fetched only for the selected session, and only when new ones arrived.
  if (box._eventsKey !== `${a.id}|${a.eventSeq}`) {
    box._events = await work.agents.events(a.id);
    box._eventsKey = `${a.id}|${a.eventSeq}`;
    if (box._key !== key) return; // a newer update started rendering meanwhile
  }
  const events = box._events;
  const before = seen.get(a.id) ?? a.eventSeq;
  const fresh = Math.min(a.eventSeq - before, events.length);
  seen.set(a.id, a.eventSeq);
  const time = (ts) => new Date(ts).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const label = { user: 'Tu', text: 'Claude', tool: null, error: 'Errore' };

  box.innerHTML = `
    <div class="agent-head">
      <h3>${esc(a.title)}</h3>
      <div class="li-sub">${esc(tildify(a.cwd, home))}</div>
    </div>
    <div class="agent-state">
      <span class="dot ${a.status.state}"></span>${esc(a.status.label)}
      <span class="meta">${a.tokens ? `${Math.round(a.tokens / 1000)}k token contesto · ` : ''}${ago(a.mtime)}</span>
    </div>
    <div class="agent-buttons">
      <button class="btn" data-act="resume">Riprendi sessione</button>
      <button class="btn" data-act="shell">Terminale qui</button>
      <button class="btn" data-act="repo">Apri come progetto</button>
      ${a.live ? '<div class="spacer"></div><button class="btn btn-danger-text" data-act="close">Chiudi sessione</button>' : ''}
    </div>
    <ul class="timeline">
      ${events.slice().reverse().map((ev, i) => `
        <li class="${ev.kind}${i < fresh ? ' new' : ''}">
          <div class="t-head"><b>${esc(label[ev.kind] ?? ev.tool)}</b><span>${time(ev.ts)}</span></div>
          <div class="t-body">${esc(ev.text)}</div>
        </li>`).join('')}
    </ul>`;

  box.querySelector('[data-act="resume"]').onclick = () => hooks.resume(a);
  box.querySelector('[data-act="shell"]').onclick = () => hooks.shellAt(a.cwd);
  box.querySelector('[data-act="repo"]').onclick = () => hooks.openRepo(a.cwd);
  const close = box.querySelector('[data-act="close"]');
  if (close) close.onclick = () => closeSession(a);
}

// Ends the Claude Code process of a session. It interrupts whatever the agent
// is doing, so it asks first; the conversation stays resumable.
export async function closeSession(a) {
  const ok = await ask({
    text: `Chiudere «${a.title}»? Claude Code viene terminato; potrai riprendere la conversazione con «Riprendi sessione».`,
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
    { label: 'Mostra attività', run: () => { selected = a.id; renderAgentList(); renderAgentDetail(); hooks.showTab('agent'); } },
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

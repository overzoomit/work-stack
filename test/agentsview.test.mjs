// Agents list (this project first) and detail timeline, on the shared fake
// renderer environment; list rows are read back from the rendered HTML.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { El, $, tick, openMenuItems, env } from './helpers/renderer-env.mjs';

class ListBox extends El {
  querySelectorAll(sel) {
    if (sel !== 'li[data-id]') return [];
    return [...this.innerHTML.matchAll(/<li data-id="([^"]*)"/g)].map(([, id]) => {
      const li = new El();
      li.dataset.id = id;
      this.lis.push(li);
      return li;
    });
  }
}
const list = new ListBox();
list.lis = [];
const baseQuery = document.querySelector;
document.querySelector = (s) => (s === '#agent-list' ? list : baseQuery(s));

let push = null;
const events = new Map();
Object.assign(globalThis.window.work, {
  agents: {
    onUpdate: (fn) => { push = fn; },
    list: async () => [],
    events: async (id) => events.get(id) || [],
  },
});
const { initAgents, agentStateFor } = await import('../src/renderer/agentsview.js');

const agent = (id, cwd, state, extra = {}) => ({
  id, cwd, project: cwd.split('/').pop(), title: `sessione ${id}`, mtime: Date.now(), tokens: 0,
  status: { state, label: { working: 'Esegue Bash', waiting: 'Attende il tuo input', blocked: 'Attende permesso: Edit', idle: 'Inattivo' }[state] },
  eventSeq: 0, ...extra,
});
const hooks = { tabs: [], resumed: [], shells: [], repos: [] };
const active = { path: '/home/u/app' };
// The list refreshes its "x min ago" every 10 s; that timer would keep the test alive.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = () => 0;
initAgents({
  homeDir: '/home/u',
  activeProject: () => active,
  showTab: (t) => hooks.tabs.push(t),
  changed() {},
  resume: (a) => hooks.resumed.push(a.id),
  shellAt: (cwd) => hooks.shells.push(cwd),
  openRepo: (cwd) => hooks.repos.push(cwd),
});
globalThis.setInterval = realSetInterval;

test('la lista mette prima le sessioni del progetto attivo e riassume gli stati', async () => {
  push([
    agent('a1', '/home/u/altro', 'working'),
    agent('b2', '/home/u/app/api', 'blocked'),
    agent('c3', '/home/u/app', 'waiting'),
  ]);
  const html = list.innerHTML;
  assert.ok(html.indexOf('In questo progetto') < html.indexOf('data-id="b2"'));
  assert.ok(html.indexOf('data-id="c3"') < html.indexOf('Altre sessioni'));
  assert.ok(html.indexOf('Altre sessioni') < html.indexOf('data-id="a1"'));
  assert.equal($('#agent-count').textContent, 3);
  assert.equal($('#status-agents').textContent, '1 al lavoro · 2 in attesa');
  assert.equal($('#toggle-sidebar').dataset.agents, 'blocked', 'the most urgent state shows on the hidden sidebar button');
  assert.equal(agentStateFor('/home/u/app'), 'blocked', 'a project shows its most urgent agent');
  assert.equal(agentStateFor('/home/u/altro'), 'working');
  assert.equal(agentStateFor('/home/u/app2'), null, 'not a prefix match');
});

test('il dettaglio mostra titolo, cartella, contesto e timeline dal più recente; i pulsanti agiscono sulla sessione', async () => {
  events.set('c3', [
    { ts: Date.now() - 2000, kind: 'user', text: 'sistema <il> bug' },
    { ts: Date.now() - 1000, kind: 'tool', tool: 'Bash', text: 'npm test' },
  ]);
  push([agent('c3', '/home/u/app', 'waiting', { eventSeq: 2, tokens: 12600 })]);
  list.lis.at(-1).onpointerdown({ button: 0 });
  await tick();
  const box = $('#agent-detail');
  assert.deepEqual(hooks.tabs.at(-1), 'agent', 'selecting a session opens its tab');
  assert.match(box.innerHTML, /<h3>sessione c3<\/h3>/);
  assert.match(box.innerHTML, /<div class="li-sub">~\/app<\/div>/);
  assert.match(box.innerHTML, /13k token contesto/);
  const tool = box.innerHTML.indexOf('<b>Bash</b>');
  const you = box.innerHTML.indexOf('<b>Tu</b>');
  assert.ok(tool !== -1 && you !== -1 && tool < you, 'newest event first');
  assert.match(box.innerHTML, /sistema &lt;il&gt; bug/);

  box.querySelector('[data-act="resume"]').onclick();
  box.querySelector('[data-act="shell"]').onclick();
  box.querySelector('[data-act="repo"]').onclick();
  assert.deepEqual([hooks.resumed, hooks.shells, hooks.repos], [['c3'], ['/home/u/app'], ['/home/u/app']]);

  // New events arrive: they are fetched again and marked as new.
  events.get('c3').push({ ts: Date.now(), kind: 'text', text: 'Fatto.' });
  push([agent('c3', '/home/u/app', 'waiting', { eventSeq: 3, tokens: 12600 })]);
  await tick();
  assert.match(box.innerHTML, /<li class="text new">[\s\S]*<b>Claude<\/b>[\s\S]*Fatto\./);
});

test('tasto destro su una sessione: mostra attività, riprendi, terminale, copia; se la sessione sparisce il dettaglio si svuota', async () => {
  push([agent('d4', '/home/u/app', 'working', { eventSeq: 1 })]);
  const li = list.lis.at(-1);
  li.oncontextmenu({ preventDefault() {}, clientX: 1, clientY: 1 });
  const items = openMenuItems();
  assert.ok(items['Mostra attività'] && items['Riprendi sessione'] && items['Terminale nella cartella'] && items['Apri come progetto']);
  items['Copia ID sessione'].onclick();
  assert.equal(env.copied.at(-1), 'd4');
  items['Mostra attività'].onclick();
  await tick();
  assert.match($('#agent-detail').innerHTML, /sessione d4/);

  push([]); // the session left the 24 h window
  await tick();
  assert.match($('#agent-detail').innerHTML, /Seleziona un agente/);
  assert.equal($('#agent-empty').hidden, false);
  assert.equal($('#status-agents').textContent, '');
});

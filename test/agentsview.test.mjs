// Agents list (this project first) and the actions of an open row, on the
// shared fake renderer environment; rows are read back from the rendered HTML.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { El, $, tick, openMenuItems, env, answer } from './helpers/renderer-env.mjs';

class Row extends El {
  constructor(segment, id) {
    super();
    this.dataset.id = id;
    this.segment = segment;
    this.row = new El();
    this.row.attrs = { 'aria-expanded': /aria-expanded="true"/.test(segment) ? 'true' : 'false' };
    this.row.setAttribute = (k, v) => { this.row.attrs[k] = v; };
    if (/class="row-item open"/.test(segment)) this.classList.add('open');
  }
  querySelector(sel) {
    if (sel === '.row-main') return this.row;
    if (sel === '[data-act="close"]') return this.segment.includes('data-act="close"') ? super.querySelector(sel) : null;
    return super.querySelector(sel);
  }
}
class ListBox extends El {
  set innerHTML(v) { super.innerHTML = v; this.rows = null; }
  get innerHTML() { return super.innerHTML; }
  querySelectorAll(sel) {
    if (sel !== 'li[data-id]') return [];
    this.rows ??= [...this.innerHTML.matchAll(/<li data-id="([^"]*)"[\s\S]*?<\/li>/g)].map((m) => new Row(m[0], m[1]));
    return this.rows;
  }
}
const list = new ListBox();
const baseQuery = document.querySelector;
document.querySelector = (s) => (s === '#agent-list' ? list : baseQuery(s));
const li = (id) => list.querySelectorAll('li[data-id]').find((r) => r.dataset.id === id);
const opened = () => list.querySelectorAll('li[data-id]').filter((r) => r.classList.contains('open')).map((r) => r.dataset.id);

let push = null;
const stopped = [];
Object.assign(globalThis.window.work, {
  agents: {
    onUpdate: (fn) => { push = fn; },
    list: async () => [],
    stop: async (id) => { stopped.push(id); },
  },
});
const { initAgents, agentStateFor } = await import('../src/renderer/agentsview.js');

const agent = (id, cwd, state, extra = {}) => ({
  id, cwd, project: cwd.split('/').pop(), title: `sessione ${id}`, mtime: Date.now(), tokens: 0,
  status: { state, label: { working: 'Esegue Bash', waiting: 'Attende il tuo input', blocked: 'Attende permesso: Edit', idle: 'Inattivo' }[state] },
  eventSeq: 0, ...extra,
});
const hooks = { resumed: [], shells: [], repos: [] };
const active = { path: '/home/u/app' };
// The list refreshes its "x min ago" every 10 s; that timer would keep the test alive.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = () => 0;
initAgents({
  activeProject: () => active,
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

test('un clic apre la riga; una sola alla volta; di nuovo la chiude; da tastiera con Invio o Spazio', async () => {
  push([agent('b2', '/home/u/app/api', 'blocked'), agent('c3', '/home/u/app', 'waiting')]);
  assert.deepEqual(opened(), []);
  li('b2').row.onpointerdown({ button: 2 });
  assert.deepEqual(opened(), [], 'only the main button opens a row');

  li('b2').row.onpointerdown({ button: 0 });
  assert.deepEqual(opened(), ['b2']);
  assert.equal(li('b2').row.attrs['aria-expanded'], 'true');

  li('c3').row.onpointerdown({ button: 0 });
  assert.deepEqual(opened(), ['c3'], 'opening another row closes the previous one');
  assert.equal(li('b2').row.attrs['aria-expanded'], 'false');

  li('c3').row.onclick({ detail: 1 }); // the click that follows a pointer press
  assert.deepEqual(opened(), ['c3'], 'a pointer click does not toggle twice');
  li('c3').row.onclick({ detail: 0 }); // Enter or Space
  assert.deepEqual(opened(), []);
});

test('le capsule della riga aperta agiscono sulla sessione', async () => {
  push([agent('c3', '/home/u/app', 'waiting')]);
  const row = li('c3');
  row.querySelector('[data-act="resume"]').onclick();
  row.querySelector('[data-act="shell"]').onclick();
  row.querySelector('[data-act="repo"]').onclick();
  assert.deepEqual([hooks.resumed, hooks.shells, hooks.repos], [['c3'], ['/home/u/app'], ['/home/u/app']]);
});

test('la riga aperta resta aperta agli aggiornamenti; se la sessione sparisce non resta aperto niente', async () => {
  push([agent('c3', '/home/u/app', 'waiting'), agent('d4', '/home/u/app', 'working')]);
  li('c3').row.onpointerdown({ button: 0 });
  push([agent('c3', '/home/u/app', 'working'), agent('d4', '/home/u/app', 'working')]);
  assert.match(list.innerHTML, /<li data-id="c3" class="row-item open"/);
  assert.deepEqual(opened(), ['c3']);

  push([agent('d4', '/home/u/app', 'working')]); // c3 left the 24 h window
  push([agent('c3', '/home/u/app', 'working'), agent('d4', '/home/u/app', 'working')]);
  assert.deepEqual(opened(), [], 'a session that comes back is not reopened');
});

test('tasto destro su una sessione: riprendi, terminale, copia; niente "Mostra attività"', async () => {
  push([agent('d4', '/home/u/app', 'working')]);
  li('d4').oncontextmenu({ preventDefault() {}, clientX: 1, clientY: 1 });
  const items = openMenuItems();
  assert.ok(items['Riprendi sessione'] && items['Terminale nella cartella'] && items['Apri come progetto']);
  assert.equal(items['Mostra attività'], undefined);
  items['Copia ID sessione'].onclick();
  assert.equal(env.copied.at(-1), 'd4');

  push([]);
  assert.equal($('#agent-empty').hidden, false);
  assert.equal($('#status-agents').textContent, '');
});

test('"Chiudi" c\'è solo se la sessione è viva e chiede conferma; lo stesso dal tasto destro', async () => {
  push([agent('e5', '/home/u/app', 'working', { live: true })]);
  assert.match(li('e5').segment, /data-act="close">Chiudi</);
  li('e5').querySelector('[data-act="close"]').onclick();
  await tick(0);
  $('#modal-cancel').onclick(); // changed their mind
  await tick();
  assert.deepEqual(stopped, [], 'nothing is closed without confirming');

  li('e5').oncontextmenu({ preventDefault() {}, clientX: 1, clientY: 1 });
  openMenuItems()['Chiudi sessione'].onclick();
  await answer('');
  await tick();
  assert.deepEqual(stopped, ['e5']);

  push([agent('e5', '/home/u/app', 'idle', { live: false })]);
  assert.equal(li('e5').querySelector('[data-act="close"]'), null, 'a closed session has no close button');
  li('e5').oncontextmenu({ preventDefault() {}, clientX: 1, clientY: 1 });
  assert.equal(openMenuItems()['Chiudi sessione'], undefined);
});

// Terminal panes and the agent launcher, on the shared fake renderer
// environment (xterm stub, minimal DOM, scriptable pty bridge).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env, FakeTerminal, $, tick, El } from './helpers/renderer-env.mjs';

const { killed, created } = env;

const T = await import('../src/renderer/terminals.js');
T.initTerminals({ homeDir: '/home/u', changed() {} });

test('chiudendo il terminale con il focus, il focus passa a un altro terminale rimasto (regressione)', async () => {
  const p = { path: '/p', focusedId: null, maximizedId: null };
  T.showProject(p);
  const a = await T.openTerminal(p);
  const b = await T.openTerminal(p);
  assert.equal(p.focusedId, b.id, 'the newest pane takes the focus');

  T.closeTerminal(b.id);
  assert.deepEqual(killed, [b.id]);
  assert.equal(p.focusedId, a.id, 'focus moves to the pane that is still open');
  assert.equal(FakeTerminal.focused, a.term);
  assert.deepEqual(T.terminalsOf(p).map((t) => t.id), [a.id], 'a closing pane no longer counts as open');

  await new Promise((r) => setTimeout(r, 700)); // exit animation fallback
  assert.equal(b.term.disposed, true);
  T.closeTerminal(a.id);
  await new Promise((r) => setTimeout(r, 700));
});

test('spostando il terminale con il focus in un altro progetto, il focus resta visibile in entrambi (regressione)', async () => {
  const p = { path: '/p', focusedId: null, maximizedId: null };
  const q = { path: '/q', focusedId: null, maximizedId: null };
  T.showProject(p);
  const a = await T.openTerminal(p);
  const b = await T.openTerminal(p);
  assert.equal(p.focusedId, b.id);

  T.moveToProject(b, q);
  assert.equal(p.focusedId, a.id);
  assert.ok(a.el.classList.contains('focused'), 'the pane that takes the focus is highlighted');
  assert.equal(q.focusedId, b.id, 'an empty destination focuses the pane it receives');
  assert.deepEqual(T.terminalsOf(q).map((t) => t.id), [b.id]);
  assert.ok(b.el.classList.contains('off'), 'q is not the active project: its pane is hidden');

  T.closeTerminal(a.id);
  T.closeTerminal(b.id);
  await new Promise((r) => setTimeout(r, 700));
});

test('"cerca di nuovo gli agenti" non riapre il menu se nel frattempo è stato chiuso (regressione)', async () => {
  const L = await import('../src/renderer/launcher.js');
  const p = { path: '/p', name: 'p', focusedId: null, maximizedId: null };
  L.initLauncher({ activeProject: () => p });
  const button = document.querySelector('#new-agent');
  const press = () => button.onpointerdown({ button: 0, stopPropagation() {} });
  press(); // open
  await new Promise((r) => setTimeout(r, 10));
  const pops = () => document.body.children.filter((c) => c.className === 'agent-pop' && !c.classList.contains('closing'));
  assert.equal(pops().length, 1);

  let finish;
  env.agentsReply = new Promise((r) => { finish = r; });
  const rescan = { closest: (sel) => (sel === '.ap-rescan' ? {} : null) };
  pops()[0].listeners.click[0]({ target: rescan });
  press(); // closed by hand while the search runs
  finish(['claude']);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(pops().length, 0, 'the menu stays closed');
});

test('Claude Code parte sempre in bypass permessi: dal menu, con Continua e con Riprendi', async () => {
  const L = await import('../src/renderer/launcher.js');
  const p = { path: '/p', name: 'p', focusedId: null, maximizedId: null };
  T.showProject(p);
  L.initLauncher({ activeProject: () => p });
  const press = () => document.querySelector('#new-agent').onpointerdown({ button: 0, stopPropagation() {} });
  const menu = () => document.body.children.filter((c) => c.className === 'agent-pop' && !c.classList.contains('closing')).at(-1);
  const clickRow = async (id, extra = null) => {
    env.agentsReply = Promise.resolve(['claude', 'codex']);
    press();
    await new Promise((r) => setTimeout(r, 10));
    const row = { dataset: { id }, classList: { contains: () => false } };
    menu().listeners.click[0]({ target: { closest: (sel) => (sel === '.ap-row' ? row : sel === extra ? {} : null) } });
    await new Promise((r) => setTimeout(r, 10));
    return created.at(-1);
  };

  const claude = await clickRow('claude');
  assert.equal(claude.command, 'claude --dangerously-skip-permissions');
  assert.equal((await clickRow('claude', '[data-continue]')).command, 'claude --continue --dangerously-skip-permissions');
  assert.equal((await clickRow('codex')).command, 'codex', 'other agents start as they are');

  const uuid = '12345678-1234-1234-1234-123456789abc';
  const t = await L.resumeClaude(p, '/p', uuid, 'sessione');
  assert.equal(created.at(-1).command, `claude --resume ${uuid} --dangerously-skip-permissions`);
  assert.match(t.el.innerHTML, /bypass permessi/, 'the pane shows the bypass badge');
  assert.throws(() => L.resumeClaude(p, '/p', 'x; rm -rf ~', 't'), /ID di sessione non valido/);
  await new Promise((r) => setTimeout(r, 700));
});

test('la lista laterale mostra i terminali del progetto con titolo, cartella e quello attivo', async () => {
  const p = { path: '/home/u/app', name: 'app', focusedId: null, maximizedId: null };
  T.showProject(p);
  const a = await T.openTerminal(p);
  const b = await T.openTerminal(p, { title: 'server <dev>', cwd: '/home/u/app/api' });
  T.renderTermList(p);
  const html = $('#term-list').innerHTML;
  assert.equal($('#term-count').textContent, 2);
  assert.match(html, new RegExp(`data-id="${a.id}" class=""[\\s\\S]*<code>~/app</code>`), 'home shown as ~');
  assert.match(html, new RegExp(`data-id="${b.id}" class="active"[\\s\\S]*server &lt;dev&gt;[\\s\\S]*<code>~/app/api</code>`));

  // The shell moved to another folder: the header and the list follow.
  env.cwds.set(a.id, '/tmp/lavoro');
  await T.pollCwd(a);
  assert.equal(a.cwd, '/tmp/lavoro');
  assert.match(a.el.querySelector('.pane-cwd').innerHTML, /<bdi>\/tmp\/lavoro<\/bdi>/);

  T.renameTerminal(a, 'build');
  assert.equal(a.el.querySelector('.pane-title').textContent, 'build');
  T.closeTerminal(a.id);
  T.closeTerminal(b.id);
  await tick(700);
});

test('copia e incolla: la selezione va negli appunti, l\'incolla arriva al terminale ancora vivo', async () => {
  const p = { path: '/c', name: 'c', focusedId: null, maximizedId: null };
  T.showProject(p);
  const t = await T.openTerminal(p);
  assert.equal(T.copySelection(t), false, 'nothing selected: nothing copied');
  t.term.selection = 'npm test';
  assert.equal(T.copySelection(t), true);
  assert.deepEqual(env.copied.at(-1), 'npm test');
  env.clipboard = 'echo ciao';
  await T.pasteInto(t);
  assert.equal(t.term.pasted, 'echo ciao', 'through xterm paste (bracketed when the shell supports it)');
  t.term.pasted = null;
  env.exit(t.id, 0);
  await T.pasteInto(t);
  assert.equal(t.term.pasted, null, 'an exited terminal takes no input');
  T.closeTerminal(t.id);
  await tick(700);
});

test('l\'aspetto vale per tutti i terminali e la dimensione del testo resta nei limiti', async () => {
  const p = { path: '/d', name: 'd', focusedId: null, maximizedId: null };
  T.showProject(p);
  const t = await T.openTerminal(p);
  T.setAppearance({ fontSize: 99, cursorStyle: 'block' });
  assert.equal(t.term.options.fontSize, 28, 'clamped to the maximum');
  assert.equal(t.term.options.cursorStyle, 'block');
  T.setAppearance({ fontSize: 1 });
  assert.equal(T.getAppearance().fontSize, 9, 'clamped to the minimum');
  const committed = T.getAppearance().theme;
  T.previewTheme('pro');
  const previewed = JSON.stringify(t.term.options.theme);
  T.previewTheme(null);
  assert.equal(T.getAppearance().theme, committed, 'hovering a theme does not change the saved one');
  assert.notEqual(JSON.stringify(t.term.options.theme), previewed, 'leaving the swatch restores the saved theme');
  T.closeTerminal(t.id);
  await tick(700);
});

test('trascinare un pannello per l\'intestazione lo riordina; Esc annulla; sul tab di un altro progetto lo sposta', async () => {
  const dropped = [];
  T.initTerminals({ homeDir: '/home/u', changed() {}, dropOnTab: (t, tab) => { dropped.push([t.id, tab.dataset.path]); return true; } });
  const p = { path: '/g', name: 'g', focusedId: null, maximizedId: null };
  T.showProject(p);
  const [a, b, c] = [await T.openTerminal(p), await T.openTerminal(p), await T.openTerminal(p)];
  // Three panes side by side, 100 px wide.
  [a, b, c].forEach((t, i) => { t.el.rect = { left: i * 100, right: i * 100 + 100, top: 0, bottom: 300, width: 100, height: 300 }; });
  const order = () => T.terminalsOf(p).map((t) => t.id);
  const grab = (t, x, y) => t.el.querySelector('.pane-head').listeners.pointerdown[0]({ button: 0, clientX: x, clientY: y, currentTarget: t.el.querySelector('.pane-head'), target: { closest: () => null } });

  grab(a, 50, 10);
  env.pointer('pointermove', 52, 11); // under the threshold: still a click
  env.pointer('pointermove', 280, 250); // lower half of c (tall panes split top/bottom)
  env.pointer('pointerup', 280, 250);
  assert.deepEqual(order(), [b.id, c.id, a.id]);

  grab(a, 250, 10);
  env.pointer('pointermove', 20, 150);
  env.key('Escape');
  env.pointer('pointerup', 20, 150);
  assert.deepEqual(order(), [b.id, c.id, a.id], 'Escape cancels the move');

  // A project tab under the pointer: the pane moves to that project.
  const tab = new El();
  tab.dataset.path = '/altro';
  tab.rect = { left: 0, right: 80, top: -40, bottom: -10, width: 80, height: 30 };
  const realAll = document.querySelectorAll;
  document.querySelectorAll = (sel) => (sel === '.ptab:not(.active)' ? [tab] : realAll(sel));
  grab(b, 50, 10);
  env.pointer('pointermove', 40, -20);
  env.pointer('pointerup', 40, -20);
  document.querySelectorAll = realAll;
  assert.deepEqual(dropped, [[b.id, '/altro']]);

  [a, b, c].forEach((t) => T.closeTerminal(t.id));
  await tick(700);
});

test('menu agenti: ↓ e Invio avviano l\'agente evidenziato; "Installa" scrive il comando senza eseguirlo', async () => {
  const L = await import('../src/renderer/launcher.js');
  const p = { path: '/k', name: 'k', focusedId: null, maximizedId: null };
  T.showProject(p);
  L.initLauncher({ activeProject: () => p });
  const menu = () => document.body.children.filter((c) => c.className === 'agent-pop' && !c.classList.contains('closing')).at(-1);
  const open = async () => {
    env.agentsReply = Promise.resolve(['claude', 'opencode']);
    document.querySelector('#new-agent').onpointerdown({ button: 0, stopPropagation() {} });
    await tick();
  };

  // Keyboard: rows are the installed agents in menu order (Claude Code, OpenCode).
  await open();
  const rows = [{ id: 'claude' }, { id: 'opencode' }].map(({ id }) => {
    const r = new El();
    r.dataset.id = id;
    r.click = () => menu().listeners.click[0]({ target: { closest: (sel) => (sel === '.ap-row' ? r : null) } });
    return r;
  });
  menu().querySelectorAll = (sel) => (sel === '.ap-row:not(.missing)' ? rows : []);
  env.key('ArrowDown');
  env.key('Enter');
  await tick();
  assert.equal(env.created.at(-1).command, 'opencode');

  // Install: a new terminal with the command typed, no Enter.
  await open();
  const missing = { dataset: { id: 'codex' }, classList: { contains: (c) => c === 'missing' } };
  menu().listeners.click[0]({ target: { closest: (sel) => (sel === '.ap-row' ? missing : sel === '[data-install]' ? {} : null) } });
  await tick(700);
  const [id, typed] = env.input.at(-1);
  assert.equal(id, env.lastId);
  assert.equal(typed, 'npm i -g @openai/codex');
  assert.ok(!/[\r\n]/.test(typed), 'never executed on its own');
  await tick(700);
});

test('su Mac Option resta Option: con la tastiera italiana serve per @ # [ ] (regressione)', async () => {
  const p = { path: '/m', name: 'm', focusedId: null, maximizedId: null };
  T.showProject(p);
  const t = await T.openTerminal(p);
  assert.notEqual(t.term.options.macOptionIsMeta, true, 'Option+ò must type @, not Meta+ò');
  T.closeTerminal(t.id);
  await tick(700);
});

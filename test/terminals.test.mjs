// Terminal panes and the agent launcher, on the shared fake renderer
// environment (xterm stub, minimal DOM, scriptable pty bridge).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env, FakeTerminal } from './helpers/renderer-env.mjs';

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

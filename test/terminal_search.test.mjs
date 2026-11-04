// In-buffer terminal search: the floating bar, its shortcuts and the state each
// pane keeps. The xterm search addon is a stub that records what the bar asks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env, FakeSearchAddon, tick } from './helpers/renderer-env.mjs';

const T = await import('../src/renderer/terminals.js');
const K = await import('../src/renderer/keys.js');

T.initTerminals({ homeDir: '/home/u', changed() {} });

const project = (path) => ({ path, name: path, focusedId: null, maximizedId: null });

function pressFind(t, mods = {}) {
  let prevented = 0;
  let stopped = 0;
  const e = {
    key: 'f', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false,
    target: t.term.textarea,
    preventDefault: () => { prevented++; },
    stopPropagation: () => { stopped++; },
    ...mods,
  };
  t.el.listeners.keydown.at(-1)(e);
  return { prevented, stopped };
}

const key = (target, props) => {
  let prevented = 0;
  let stopped = 0;
  const e = { preventDefault: () => { prevented++; }, stopPropagation: () => { stopped++; }, ...props };
  for (const fn of target.listeners.keydown || []) fn(e);
  return { prevented, stopped };
};

test('Ctrl+F apre la barra nel pannello attivo, con il campo a fuoco e selezionato', async () => {
  const p = project('/find-open');
  T.showProject(p);
  const t = await T.openTerminal(p);
  const bar = t.search;

  assert.equal(bar.el.hidden, true, 'closed until asked');
  const { prevented, stopped } = pressFind(t);
  assert.equal(prevented, 1);
  assert.equal(stopped, 1);
  assert.equal(bar.el.hidden, false);
  assert.equal(bar.input.focused, true, 'the field takes the focus');
  assert.deepEqual(document.activeElement, bar.input);

  bar.input.value = 'errore';
  bar.search('errore');
  bar.input.focused = false;
  pressFind(t, { shiftKey: true });
  assert.equal(bar.input.selection[0], 0);
  assert.equal(bar.input.selection[1], 'errore'.length, 'the old query is selected for a new search');

  T.closeTerminal(t.id);
  await tick(700);
});

test('la digitazione cerca in modo incrementale; Invio e Shift+Invio scorrono i risultati', async () => {
  const p = project('/find-keys');
  T.showProject(p);
  const t = await T.openTerminal(p);
  const bar = t.search;
  bar.open();

  bar.input.value = 'errore';
  bar.input.listeners.input[0]({});
  let call = bar.addon.calls.at(-1);
  assert.deepEqual(call.slice(0, 2), ['next', 'errore']);
  assert.equal(call[2].incremental, true, 'each keystroke extends the current match');
  assert.equal(call[2].decorations.matchOverviewRuler, '#0a84ff');
  assert.equal(call[2].decorations.activeMatchColorOverviewRuler, '#ffd60a');

  const enter = key(bar.input, { key: 'Enter', shiftKey: false });
  assert.deepEqual(enter, { prevented: 1, stopped: 1 });
  call = bar.addon.calls.at(-1);
  assert.deepEqual(call.slice(0, 2), ['next', 'errore']);
  assert.equal(call[2].incremental, false, 'Enter jumps to the next match, without re-expanding');

  key(bar.input, { key: 'Enter', shiftKey: true });
  call = bar.addon.calls.at(-1);
  assert.deepEqual(call.slice(0, 2), ['previous', 'errore']);

  T.closeTerminal(t.id);
  await tick(700);
});

test('il contatore segue i risultati dell\'addon: indice su totale, molti match, nessun match', async () => {
  const p = project('/find-count');
  T.showProject(p);
  const t = await T.openTerminal(p);
  const bar = t.search;
  bar.open();
  bar.search('log');

  bar.addon.emit(2, 12);
  assert.equal(bar.count.textContent, '3 of 12');
  assert.equal(bar.count.classList.contains('empty'), false);
  assert.equal(bar.next.disabled, false);

  bar.addon.emit(-1, 5);
  assert.equal(bar.count.textContent, '5 matches', 'over the highlight limit: no active index');

  bar.addon.emit(-1, 0);
  assert.equal(bar.count.textContent, 'No results');
  assert.equal(bar.next.disabled, true);
  assert.equal(bar.prev.disabled, true);

  bar.input.value = '';
  bar.input.listeners.input[0]({});
  assert.equal(bar.count.textContent, '', 'an empty query has no counter');
  assert.ok(bar.addon.cleared > 0, 'the decorations go away');

  T.closeTerminal(t.id);
  await tick(700);
});

test('Escape chiude la barra, toglie le evidenziazioni e riporta il focus alla shell', async () => {
  const p = project('/find-esc');
  T.showProject(p);
  const t = await T.openTerminal(p);
  const bar = t.search;
  bar.open();
  bar.search('warning');
  const cleared = bar.addon.cleared || 0;

  const esc = key(bar.input, { key: 'Escape', shiftKey: false });
  assert.deepEqual(esc, { prevented: 1, stopped: 1 });
  assert.equal(bar.el.hidden, true);
  assert.equal(bar.state.open, false);
  assert.ok(bar.addon.cleared > cleared, 'no decoration survives a closed bar');
  assert.equal(FakeSearchAddon.instances.includes(bar.addon), true);
  assert.equal(FakeTerminalFocused(), t.term);

  T.closeTerminal(t.id);
  await tick(700);
});

// The pane focuses its own xterm on close, not the shared stub above.
const FakeTerminalFocused = () => globalThis.__xterm.Terminal.focused;

test('ogni pannello conserva la propria ricerca; cambiando progetto la barra si nasconde e torna', async () => {
  const p = project('/find-a');
  const q = project('/find-b');
  T.showProject(p);
  const a = await T.openTerminal(p);
  const b = await T.openTerminal(p);
  a.search.open();
  a.search.search('alpha');
  b.search.open();
  b.search.search('beta');

  assert.equal(a.search.input.value, 'alpha');
  assert.equal(b.search.input.value, 'beta');

  T.showProject(q);
  assert.equal(a.search.el.hidden, true, 'hidden with its project');
  assert.equal(b.search.el.hidden, true);
  assert.equal(q.focusedId, null);

  T.showProject(p);
  assert.equal(a.search.el.hidden, false, 'restored with its project');
  assert.equal(b.search.el.hidden, false);
  assert.equal(a.search.input.value, 'alpha', 'the query is still the pane\'s own');

  T.closeTerminal(a.id);
  T.closeTerminal(b.id);
  await tick(700);
});

test('ridimensionare la finestra ricalcola i match del pannello aperto', async () => {
  const p = project('/find-resize');
  T.showProject(p);
  const t = await T.openTerminal(p);
  const bar = t.search;
  bar.open();
  bar.search('trace');
  bar.addon.calls.length = 0;

  env.resize(1400, 900);
  await tick(200);
  const call = bar.addon.calls.at(-1);
  assert.deepEqual(call.slice(0, 2), ['next', 'trace']);
  assert.equal(call[2].incremental, true);

  T.closeTerminal(t.id);
  await tick(700);
});

test('chiudere il pannello libera la barra e l\'addon di ricerca', async () => {
  const p = project('/find-dispose');
  T.showProject(p);
  const t = await T.openTerminal(p);
  const bar = t.search;
  bar.open();
  bar.search('x');

  T.closeTerminal(t.id);
  assert.equal(bar.addon.disposed, true);
  assert.equal(bar.el.parent, null, 'the bar leaves the pane');
  await tick(700);
});

test('isTerminalSearchKey riconosce Ctrl/⌘+F ma non le combinazioni con Alt o senza modificatore', () => {
  assert.equal(K.isTerminalSearchKey({ key: 'f', ctrlKey: true, metaKey: false, altKey: false }), true);
  assert.equal(K.isTerminalSearchKey({ key: 'F', ctrlKey: false, metaKey: true, altKey: false }), true);
  assert.equal(K.isTerminalSearchKey({ key: 'f', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true }), true);
  assert.equal(K.isTerminalSearchKey({ key: 'f', ctrlKey: false, metaKey: false, altKey: false }), false);
  assert.equal(K.isTerminalSearchKey({ key: 'f', ctrlKey: true, metaKey: false, altKey: true }), false);
  assert.equal(K.isTerminalSearchKey({ key: 'g', ctrlKey: true, metaKey: false, altKey: false }), false);
});

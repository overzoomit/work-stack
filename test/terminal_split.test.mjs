// Split panes: the binary layout tree, the splitter gesture and the tmux
// window each rectangle is attached to. The renderer runs on the shared fake
// DOM/xterm environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env, $, tick } from './helpers/renderer-env.mjs';

const T = await import('../src/renderer/terminals.js');
T.initTerminals({ homeDir: '/home/u', changed() {} });

const project = (path) => ({ path, name: path, focusedId: null, maximizedId: null });
const splitters = () => $('#terminals').children.filter((el) => el.classList?.contains('pane-splitter'));

async function closeAll(p) {
  for (const t of T.terminalsOf(p)) T.closeTerminal(t.id);
  await tick(700);
}

test('splitting horizontally puts a new independent pane on the right', async () => {
  env.tmuxAvailable = false;
  env.created.length = 0;
  const p = project('/split-horizontal');
  T.showProject(p);

  const a = await T.openTerminal(p);
  const b = await T.splitTerminal(a.id, 'horizontal');

  assert.ok(b, 'the split opens a pane');
  assert.notEqual(b.id, a.id, 'its own PTY and xterm');
  assert.equal(env.created.length, 2);
  assert.equal(b.project, p);
  assert.deepEqual(T.layoutSnapshot(p), {
    dir: 'row',
    ratio: 0.5,
    a: { pane: a.id },
    b: { pane: b.id },
  });
  assert.match(b.el.style.left, /50/, 'the new pane starts to the right');
  assert.equal(splitters().length, 1);
  assert.ok(splitters()[0].classList.contains('splitter-row'), 'a vertical divider');

  await closeAll(p);
});

test('splitting vertically stacks the pane and the divider drags to a new ratio', async () => {
  env.tmuxAvailable = false;
  const p = project('/split-vertical');
  T.showProject(p);

  const a = await T.openTerminal(p);
  const b = await T.splitTerminal(a.id, 'vertical');
  assert.deepEqual(T.layoutSnapshot(p), {
    dir: 'col',
    ratio: 0.5,
    a: { pane: a.id },
    b: { pane: b.id },
  });
  const handle = splitters()[0];
  assert.ok(handle.classList.contains('splitter-col'), 'a horizontal divider');
  assert.match(b.el.style.top, /50/, 'the new pane starts below');

  const grid = $('#terminals');
  grid.rect = { left: 0, top: 0, right: 100, bottom: 200, width: 100, height: 200 };
  handle.listeners.pointerdown[0]({
    button: 0, clientX: 50, clientY: 100, preventDefault() {}, stopPropagation() {},
  });
  env.pointer('pointermove', 50, 150);
  assert.equal(T.layoutSnapshot(p).ratio, 0.75, 'the splitter follows the pointer');
  env.pointer('pointerup', 50, 150);

  await closeAll(p);
});

test('a split asks tmux for a sibling window and attaches the new PTY to it', async () => {
  env.tmuxAvailable = true;
  env.tmuxSession = 'work_split_123456';
  env.tmuxWindows = [{ id: '@0', name: 'shell', active: true, path: '/home/u/split-tmux' }];
  env.tmuxWindowOf = () => '@0';
  env.tmuxSplit = { windowId: '@9', paneId: '%7', width: 120, height: 30 };
  env.tmuxCalls.length = 0;
  env.created.length = 0;

  const p = project('/home/u/split-tmux');
  T.showProject(p);
  const a = await T.openTerminal(p);
  assert.equal(a.tmuxWindow, '@0');

  const b = await T.splitTerminal(a.id, 'horizontal');
  const call = env.tmuxCalls.find(([kind]) => kind === 'splitPane');
  assert.deepEqual(call, ['splitPane', 'work_split_123456', '@0', 'horizontal', null]);
  assert.equal(b.tmuxWindow, '@9');
  assert.equal(b.tmuxPane, '%7');
  assert.equal(env.created.at(-1).tmux_window, '@9', 'the PTY attaches to the new window');
  assert.equal(env.created.at(-1).tmux_session, 'work_split_123456');

  await closeAll(p);
  env.tmuxAvailable = false;
  env.tmuxWindowOf = null;
  env.tmuxSplit = null;
});

test('a tmux split failure falls back to a normal new window', async () => {
  env.tmuxAvailable = true;
  env.tmuxSession = 'work_split_fallback';
  env.tmuxWindows = [{ id: '@1', name: 'shell', active: true, path: '/home/u/fallback' }];
  env.tmuxWindowOf = () => '@1';
  env.tmuxSplitError = new Error('tmux refused');
  env.created.length = 0;

  const p = project('/home/u/fallback');
  T.showProject(p);
  const a = await T.openTerminal(p);
  const b = await T.splitTerminal(a.id, 'horizontal');

  assert.ok(b, 'the pane still opens');
  assert.equal(env.created.at(-1).tmux_window, undefined, 'the backend creates the window');
  assert.equal(env.created.at(-1).tmux_session, 'work_split_fallback');

  env.tmuxSplitError = null;
  await closeAll(p);
  env.tmuxAvailable = false;
  env.tmuxWindowOf = null;
});

test('closing a pane collapses its rectangle and the survivors keep the space', async () => {
  env.tmuxAvailable = false;
  const p = project('/split-close');
  T.showProject(p);

  const a = await T.openTerminal(p);
  const b = await T.splitTerminal(a.id, 'vertical');
  const c = await T.splitTerminal(b.id, 'horizontal');
  assert.equal(T.terminalsOf(p).length, 3);
  assert.equal(splitters().length, 2);

  T.closeTerminal(b.id);
  assert.deepEqual(T.terminalsOf(p).map((t) => t.id), [a.id, c.id], 'the closed pane is out at once');
  assert.ok(env.killed.includes(b.id));
  const after = T.layoutSnapshot(p);
  assert.ok(after, 'the remaining panes still have a layout');
  assert.ok(!JSON.stringify(after).includes(`"pane":${b.id}`));

  await closeAll(p);
});

test('a command that exits collapses a split after its final output', async () => {
  env.tmuxAvailable = false;
  const p = project('/split-exit');
  T.showProject(p);

  const a = await T.openTerminal(p);
  const b = await T.splitTerminal(a.id, 'horizontal');
  env.exit(b.id, 0);
  assert.equal(T.terminalsOf(p).length, 2, 'the exit message is shown first');

  await tick(1700);
  assert.deepEqual(T.terminalsOf(p).map((t) => t.id), [a.id], 'the survivor takes the whole area');

  await closeAll(p);
});

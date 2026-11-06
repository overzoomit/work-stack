// Time Machine: timestamped scrollback snapshots replayed under a terminal,
// the compact delta log and the fork of a new session. tmux and the PTY are
// the shared fake env, so the real process is never started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env, tick } from './helpers/renderer-env.mjs';

const T = await import('../src/renderer/terminals.js');
T.initTerminals({ homeDir: '/home/u', changed() {} });

const project = (path) => ({ path, name: path, focusedId: null, maximizedId: null });
const at = (sec) => Date.UTC(2026, 10, 6, 12, 0, sec);

const timeline = [
  { index: 10, timestamp: at(0), text: '$ npm test\npass 1\npass 2' },
  { index: 11, timestamp: at(5), text: '$ npm test\npass 1\npass 2\nFAIL login' },
  { index: 12, timestamp: at(9), text: '$ npm test\npass 1\npass 2\nFAIL login\nfix applied' },
];

async function openAgent(path = '/home/u/tm', { entries = timeline, error = null } = {}) {
  env.tmuxAvailable = true;
  env.tmuxSession = 'work_tm_123456';
  env.tmuxWindows = [{ id: '@0', name: 'dev1', active: true, path }];
  env.tmuxWindowOf = () => '@0';
  env.timeline = entries;
  env.timelineError = error;
  env.fork = null;
  env.forkError = null;
  env.forks.length = 0;
  env.created.length = 0;
  env.killed.length = 0;
  env.copied.length = 0;
  env.tmuxCalls.length = 0;

  const p = project(path);
  T.showProject(p);
  const t = await T.openTerminal(p, { tmuxName: 'dev1', title: 'dev1' });
  await tick(5); // the first snapshot read is asynchronous
  return { p, t };
}

async function closeAll(p) {
  for (const t of T.terminalsOf(p)) T.closeTerminal(t.id);
  await tick(700);
  env.tmuxAvailable = false;
  env.tmuxWindowOf = null;
}

test('the compact log keeps only the lines that appeared, with their timestamps', () => {
  const text = T.compactTimeline(timeline, 0, 2);
  assert.equal((text.match(/pass 1/g) || []).length, 1, 'unchanged lines are not repeated');
  assert.match(text, /FAIL login/);
  assert.match(text, /fix applied/);
  assert.equal((text.match(/── \d\d:\d\d:\d\d ──/g) || []).length, 3, 'one header per snapshot');
  assert.equal(T.compactTimeline([], 0, 0), '');
  assert.match(T.formatTimelineTime(at(5)), /^\d\d:\d\d:\d\d$/);
});

test('a tmux agent terminal gets a scrubber that follows the live end', async () => {
  const { p, t } = await openAgent('/home/u/tm-open');
  const tm = t.timeMachine;

  assert.ok(tm, 'the pane has a Time Machine');
  assert.equal(tm.bar.hidden, false, 'an agent pane shows the scrubber');
  assert.deepEqual(
    env.tmuxCalls.find(([kind]) => kind === 'getHistoryTimeline'),
    ['getHistoryTimeline', 'work_tm_123456', '@0'],
    'the backend captures this window',
  );
  assert.equal(tm.entries.length, 3);
  assert.equal(tm.index, 2, 'it starts on the live end');
  assert.equal(tm.slider.max, '2');
  assert.equal(tm.mode.textContent, 'live');
  assert.equal(tm.replay.hidden, true, 'no overlay while live');

  await closeAll(p);
});

test('rewinding shows the old output without touching the running process', async () => {
  const { p, t } = await openAgent('/home/u/tm-seek');
  const written = t.term.written;

  const entry = T.seekTimeMachine(t, 1);
  assert.equal(entry.index, 11);
  assert.equal(t.timeMachine.slider.value, '1');
  assert.equal(t.timeMachine.mode.textContent, 'replay');
  assert.equal(t.timeMachine.replay.hidden, false);
  assert.match(t.timeMachine.replayText.textContent, /FAIL login/);
  assert.ok(!t.timeMachine.replayText.textContent.includes('fix applied'), 'the selected moment only');
  assert.equal(t.term.written, written, 'the live xterm is untouched');
  assert.ok(!env.killed.includes(t.id), 'the shell is still running');

  T.seekTimeMachine(t, 2);
  assert.equal(t.timeMachine.replay.hidden, true, 'the live end restores the terminal');
  await closeAll(p);
});

test('copy and export use the compact log up to the selected moment', async () => {
  const { p, t } = await openAgent('/home/u/tm-copy');
  T.seekTimeMachine(t, 1);

  const text = T.timeMachineLog(t);
  assert.match(text, /FAIL login/);
  assert.ok(!text.includes('fix applied'), 'only the selected section');
  assert.equal(T.copyTimeMachineLog(t), text);
  assert.equal(env.copied.at(-1), text, 'the log reaches the clipboard');
  assert.equal(T.exportTimeMachineLog(t), text, 'the same log is what gets exported');

  await closeAll(p);
});

test('play advances the replay and can be paused', async () => {
  const { p, t } = await openAgent('/home/u/tm-play');
  T.seekTimeMachine(t, 0);

  assert.equal(T.toggleTimeMachinePlay(t), true);
  assert.equal(t.timeMachine.playing, true);
  await tick(750);
  assert.equal(t.timeMachine.index, 1, 'one snapshot per beat');
  assert.equal(T.toggleTimeMachinePlay(t), false);
  assert.equal(t.timeMachine.playing, false, 'paused by the user');

  await closeAll(p);
});

test('fork opens a new terminal at the selected snapshot in its own tmux window', async () => {
  const { p, t } = await openAgent('/home/u/tm-fork');
  T.seekTimeMachine(t, 1);

  const pane = await T.forkTimeMachine(t);
  assert.ok(pane, 'a new pane is opened');
  assert.deepEqual(
    env.forks.at(-1),
    { session: 'work_tm_123456', window: '@0', atIndex: 11 },
    'the backend receives the snapshot index, not its position',
  );
  assert.notEqual(pane.id, t.id);
  assert.equal(pane.project, p);
  assert.equal(pane.tmuxSession, 'work_tm_123456');
  assert.equal(env.created.at(-1).tmux_window, pane.tmuxWindow, 'its PTY attaches to the fork window');

  await closeAll(p);
});

test('a failing snapshot read leaves the terminal usable', async () => {
  const { p, t } = await openAgent('/home/u/tm-error', {
    entries: [],
    error: new Error('tmux non risponde'),
  });

  assert.deepEqual(t.timeMachine.entries, []);
  assert.equal(t.timeMachine.mode.textContent, 'collecting…');
  assert.equal(t.timeMachine.bar.hidden, false, 'an agent pane still shows the controls');
  assert.equal(await T.refreshTimeMachine(t), null, 'the failure is swallowed');
  assert.equal(t.exited, false);

  await closeAll(p);
});

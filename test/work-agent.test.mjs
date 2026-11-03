// scripts/work-agent.py: inter-agent coordination CLI driven through a fake
// tmux executable and the shared .claude/dogwatch_state.json snapshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../scripts/work-agent.py', import.meta.url));
const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });
const hasPython = python.status === 0;

const FAKE = `#!/bin/sh
printf '%s\\n' "$*" >> "$TMUX_LOG"
case "$1" in
  display-message) printf 'work_test\\n' ;;
  list-sessions) printf 'work_test\\n' ;;
  list-windows) printf '@0\\tdev1\\t1\\t/p\\n@1\\tqa1\\t0\\t/p\\n' ;;
  send-keys) exit 0 ;;
  capture-pane)
    case "$*" in
      *:dev1*) printf '\\033[31mDo you want to proceed?\\033[0m\\n│ ❯ 1. Yes │\\n│   2. No │\\n  Esc to cancel\\n' ;;
      *) printf 'all good\\n' ;;
    esac
    ;;
esac
`;

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'work-agent-'));
  const tmux = join(dir, 'tmux');
  writeFileSync(tmux, FAKE);
  chmodSync(tmux, 0o755);
  writeFileSync(join(dir, 'tmux.log'), '');
  return {
    dir,
    tmux,
    log: join(dir, 'tmux.log'),
    state: join(dir, '.claude', 'dogwatch_state.json'),
    env: { ...process.env, TMUX_LOG: join(dir, 'tmux.log') },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function writeState(box, windows) {
  mkdirSync(dirname(box.state), { recursive: true });
  writeFileSync(box.state, JSON.stringify({
    updated_at: new Date().toISOString(),
    session: 'work_test',
    live: true,
    windows,
  }));
}

const run = (box, args, env = {}) =>
  spawnSync('python3', [CLI, ...args, '--root', box.dir, '--session', 'work_test', '--tmux-bin', box.tmux, '--state', box.state], {
    encoding: 'utf8',
    env: { ...box.env, ...env },
    timeout: 20_000,
  });

const windows = () => [
  { id: '@0', name: 'dev1', agent: 'opencode', state: 'working', rule: 'opencode-spinner', prompt: null },
  { id: '@1', name: 'qa1', agent: 'codex', state: 'idle', rule: null, prompt: null },
];

test('list prints the shared Dogwatch state for every agent window', { skip: !hasPython }, () => {
  const box = sandbox();
  try {
    writeState(box, windows());
    const out = run(box, ['list']);
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(out.stdout.trim().split('\n'), [
      'dev1\tworking\topencode\topencode-spinner',
      'qa1\tidle\tcodex',
    ]);
  } finally {
    box.cleanup();
  }
});

test('prompt sends the instruction and Enter to the target window', { skip: !hasPython }, () => {
  const box = sandbox();
  try {
    writeState(box, windows());
    const out = run(box, ['prompt', 'dev1', 'run', 'the', 'tests']);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout.trim(), 'sent\tdev1');
    const log = readFileSync(box.log, 'utf8');
    assert.match(log, /send-keys -t work_test:dev1 -l -- run the tests/);
    assert.match(log, /send-keys -t work_test:dev1 Enter/);
  } finally {
    box.cleanup();
  }
});

test('read strips ANSI and --clean removes box borders and key hints', { skip: !hasPython }, () => {
  const box = sandbox();
  try {
    writeState(box, windows());
    const out = run(box, ['read', 'dev1', '--lines', '20', '--clean']);
    assert.equal(out.status, 0, out.stderr);
    assert.doesNotMatch(out.stdout, /\x1b/);
    assert.match(out.stdout, /Do you want to proceed\?/);
    assert.match(out.stdout, /1\. Yes/);
    assert.doesNotMatch(out.stdout, /Esc to cancel/);
    assert.doesNotMatch(out.stdout, /│/);
  } finally {
    box.cleanup();
  }
});

test('wait returns 0 when the shared state reaches the requested value', { skip: !hasPython }, async () => {
  const box = sandbox();
  try {
    writeState(box, windows());
    const child = spawn('python3', [CLI, 'wait', 'dev1', '--until', 'blocked', '--timeout', '5', '--root', box.dir, '--session', 'work_test', '--tmux-bin', box.tmux, '--state', box.state], {
      env: box.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    await new Promise((r) => setTimeout(r, 300));
    writeState(box, [{ ...windows()[0], state: 'blocked', rule: 'opencode-permission', prompt: { question: 'Proceed?' } }]);
    const code = await new Promise((r) => child.once('exit', r));
    assert.equal(code, 0, stderr);
    assert.equal(stdout.trim(), 'dev1\tblocked');
  } finally {
    box.cleanup();
  }
});

test('wait exits 2 on timeout and 1 when the target does not exist', { skip: !hasPython }, () => {
  const box = sandbox();
  try {
    writeState(box, windows());
    const timed = run(box, ['wait', 'dev1', '--until', 'idle', '--timeout', '0.3']);
    assert.equal(timed.status, 2);
    assert.match(timed.stderr, /timeout waiting for dev1/);

    const missing = run(box, ['read', 'dev9']);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /not found/);
  } finally {
    box.cleanup();
  }
});

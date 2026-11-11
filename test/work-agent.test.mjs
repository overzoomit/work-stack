// scripts/work-agent.py: inter-agent coordination CLI driven through a fake
// tmux executable and the shared .claude/dogwatch_state.json snapshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../scripts/work-agent.py', import.meta.url));
const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });
const hasPython = python.status === 0;

const FAKE = `#!/bin/sh
printf '%s\\n' "$*" >> "$TMUX_LOG"
case "$1" in
  display-message)
    case "$*" in
      *pane_start_command*)
        case "$*" in
          *:dev1*) printf 'ollama launch opencode --model x\\tollama\\n' ;;
          *:qa1*) printf 'codex --full-auto\\tcodex\\n' ;;
          *) printf 'agy\\tagy\\n' ;;
        esac ;;
      *) if [ -n "$TMUX_CURRENT" ]; then printf '%s\\n' "$TMUX_CURRENT"; else printf 'work_test\\n'; fi ;;
    esac
    ;;
  list-sessions)
    if [ -n "$TMUX_SESSIONS" ]; then printf '%b' "$TMUX_SESSIONS"; else printf 'work_test\\n'; fi
    ;;
  list-windows) printf '@0\\tdev1\\t1\\t/p\\n@1\\tqa1\\t0\\t/p\\n' ;;
  send-keys) exit 0 ;;
  capture-pane)
    case "$*" in
      *:dev1*) printf '\\033[31mDo you want to proceed?\\033[0m\\n│ ❯ 1. Yes │\\n│   2. No │\\n  Esc to cancel\\n⠋ Working… (esc to interrupt)\\n' ;;
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

function writeState(box, windows, session = 'work_test') {
  mkdirSync(dirname(box.state), { recursive: true });
  writeFileSync(box.state, JSON.stringify({
    updated_at: new Date().toISOString(),
    session,
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

// No --session: the CLI must resolve the project itself.
const runBare = (box, args, env = {}) => {
  const clean = { ...box.env, ...env };
  if (!('TMUX' in env)) delete clean.TMUX;
  if (!('WORK_TMUX_SESSION' in env)) delete clean.WORK_TMUX_SESSION;
  return spawnSync('python3', [CLI, ...args, '--root', box.dir, '--tmux-bin', box.tmux, '--state', box.state], {
    encoding: 'utf8',
    env: clean,
    timeout: 20_000,
  });
};

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
    assert.doesNotMatch(out.stdout, /Working… \(esc to interrupt\)/);
    assert.doesNotMatch(out.stdout, /│/);
  } finally {
    box.cleanup();
  }
});

test('wait returns 0 when the shared state reaches the requested value', { skip: !hasPython }, async () => {
  const box = sandbox();
  try {
    writeState(box, windows());
    const child = spawn('python3', [CLI, 'wait', 'qa1', '--until', 'blocked', '--timeout', '5', '--root', box.dir, '--session', 'work_test', '--tmux-bin', box.tmux, '--state', box.state], {
      env: box.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const update = () => writeState(box, [{ ...windows()[0] }, { ...windows()[1], state: 'blocked', rule: 'codex-permission', prompt: { question: 'Proceed?' } }]);
    await new Promise((r) => setTimeout(r, 400));
    update();
    const interval = setInterval(update, 200);
    const code = await new Promise((r) => child.once('exit', r));
    clearInterval(interval);
    assert.equal(code, 0, stderr);
    assert.equal(stdout.trim(), 'qa1\tblocked');
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

test('fuori da tmux la sessione viene scelta dalla directory, non dal client corrente', { skip: !hasPython }, () => {
  const box = sandbox();
  try {
    const base = `work_${basename(box.dir)}_abc123`;
    writeState(box, windows(), base);
    const out = runBare(box, ['list'], {
      TMUX_CURRENT: 'work_other_project_pty_9',
      TMUX_SESSIONS: `${base}\n${base}_pty_2\nwork_other_project_abc123\n`,
    });
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /^dev1\tworking\topencode\topencode-spinner$/m);
    assert.match(out.stdout, /^qa1\tidle\tcodex$/m);

    const unrelated = runBare(box, ['list'], {
      TMUX_CURRENT: 'work_other_project_abc123',
      TMUX_SESSIONS: 'work_other_project_abc123\n',
    });
    assert.equal(unrelated.status, 1);
    assert.match(unrelated.stderr, /no tmux session found/);
  } finally {
    box.cleanup();
  }
});

test('dentro tmux il client raggruppato _pty_N viene normalizzato alla sessione base', { skip: !hasPython }, () => {
  const box = sandbox();
  try {
    writeState(box, windows(), 'work_test');
    const out = runBare(box, ['list'], { TMUX: '1', TMUX_CURRENT: 'work_test_pty_3' });
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /^dev1\tworking\topencode/m);
    assert.doesNotMatch(out.stdout, /work_test_pty_3/);
  } finally {
    box.cleanup();
  }
});

test('prompt + wait --until done non accetta lo snapshot idle precedente all’avvio', { skip: !hasPython }, async () => {
  const box = sandbox();
  try {
    writeState(box, windows());
    const sent = run(box, ['prompt', 'qa1', 'long', 'task']);
    assert.equal(sent.status, 0, sent.stderr);

    const started = Date.now();
    const child = spawn('python3', [CLI, 'wait', 'qa1', '--until', 'done', '--timeout', '5', '--root', box.dir, '--session', 'work_test', '--tmux-bin', box.tmux, '--state', box.state], {
      env: box.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    await new Promise((r) => setTimeout(r, 400));
    writeState(box, [{ ...windows()[0] }, { ...windows()[1], state: 'working', rule: 'codex-spinner' }]);
    await new Promise((r) => setTimeout(r, 400));
    writeState(box, windows());
    const code = await new Promise((r) => child.once('exit', r));
    assert.equal(code, 0, stderr);
    assert.equal(stdout.trim(), 'qa1\tdone');
    assert.ok(Date.now() - started >= 600, 'deve osservare working prima di done');
  } finally {
    box.cleanup();
  }
});

test('wait dopo un prompt va in timeout finché l’agente non è partito', { skip: !hasPython }, () => {
  const box = sandbox();
  try {
    writeState(box, windows());
    assert.equal(run(box, ['prompt', 'qa1', 'task']).status, 0);
    const out = run(box, ['wait', 'qa1', '--until', 'done', '--timeout', '0.5']);
    assert.equal(out.status, 2, out.stdout);
    assert.match(out.stderr, /timeout waiting for qa1/);
  } finally {
    box.cleanup();
  }
});

test('gli errori di usage escono con 1, lasciando 2 ai timeout', { skip: !hasPython }, () => {
  const box = sandbox();
  try {
    writeState(box, windows());
    const invalid = run(box, ['wait', 'dev1', '--until', 'working']);
    assert.equal(invalid.status, 1, invalid.stderr);
    assert.match(invalid.stderr, /invalid choice/);
    const empty = run(box, []);
    assert.equal(empty.status, 1, empty.stderr);
  } finally {
    box.cleanup();
  }
});

// ── OpenCode/Ollama session reset ────────────────────────────

const idleDev = () => [{ ...windows()[0], state: 'idle', rule: null }, windows()[1]];

test('prompt resets an idle OpenCode session with /new before the new task', { skip: !hasPython }, () => {
  const box = sandbox();
  try {
    writeState(box, idleDev());
    const out = run(box, ['prompt', 'dev1', 'new', 'task'], { WORK_AGENT_RESET_SETTLE: '0' });
    assert.equal(out.status, 0, out.stderr);
    const log = readFileSync(box.log, 'utf8');
    assert.match(log, /send-keys -t work_test:dev1 -l -- \/new/);
    assert.ok(log.indexOf('-l -- /new') < log.indexOf('-l -- new task'), 'the reset comes before the task');
  } finally {
    box.cleanup();
  }
});

test('a follow-up to a working OpenCode agent keeps its context, and --no-clean never resets', { skip: !hasPython }, () => {
  const box = sandbox();
  try {
    writeState(box, windows()); // dev1 is working
    assert.equal(run(box, ['prompt', 'dev1', 'follow', 'up'], { WORK_AGENT_RESET_SETTLE: '0' }).status, 0);
    assert.doesNotMatch(readFileSync(box.log, 'utf8'), /-l -- \/new/, 'no reset while the task is still running');

    writeState(box, idleDev());
    assert.equal(run(box, ['prompt', 'dev1', 'another', 'task', '--no-clean'], { WORK_AGENT_RESET_SETTLE: '0' }).status, 0);
    assert.doesNotMatch(readFileSync(box.log, 'utf8'), /-l -- \/new/, '--no-clean opts out of the automatic reset');
  } finally {
    box.cleanup();
  }
});

test('--clean forces the reset even when the snapshot still looks busy', { skip: !hasPython }, () => {
  const box = sandbox();
  try {
    writeState(box, windows()); // dev1 is working
    const out = run(box, ['prompt', 'dev1', 'task', '--clean'], { WORK_AGENT_RESET_SETTLE: '0' });
    assert.equal(out.status, 0, out.stderr);
    assert.match(readFileSync(box.log, 'utf8'), /send-keys -t work_test:dev1 -l -- \/new/);
  } finally {
    box.cleanup();
  }
});

test('--clean on a non-OpenCode target warns and does not send /new', { skip: !hasPython }, () => {
  const box = sandbox();
  try {
    writeState(box, windows()); // qa1 runs Codex
    const out = run(box, ['prompt', 'qa1', 'task', '--clean'], { WORK_AGENT_RESET_SETTLE: '0' });
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stderr, /not an OpenCode\/Ollama agent/);
    assert.doesNotMatch(readFileSync(box.log, 'utf8'), /-l -- \/new/);
  } finally {
    box.cleanup();
  }
});

test('wait --clean resets the OpenCode session once the task is done', { skip: !hasPython }, () => {
  const box = sandbox();
  try {
    writeState(box, windows()); // dev1 capture is blocked, so wait --until blocked matches
    const out = run(box, ['wait', 'dev1', '--until', 'blocked', '--timeout', '5', '--clean'], { WORK_AGENT_RESET_SETTLE: '0' });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout.trim(), 'dev1\tblocked');
    assert.match(readFileSync(box.log, 'utf8'), /send-keys -t work_test:dev1 -l -- \/new/);
  } finally {
    box.cleanup();
  }
});

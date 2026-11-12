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

// ── Shared database (.claude/work.db): status / log / inspect ──

const SCRIPTS = fileURLToPath(new URL('../scripts/', import.meta.url));

// Runs Python with scripts/ importable; `db` is the box's work.db.
const py = (box, code) => {
  const out = spawnSync('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(SCRIPTS)})\nimport work_db\ndb = work_db.connect(work_db.Path(${JSON.stringify(join(box.dir, '.claude', 'work.db'))}))\n${code}\ndb.close()`], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout;
};

function seedTeam(box) {
  py(box, `
work_db.sync_plane_issues(db, [{"issue_id": "i-66", "sequence_id": 66, "title": "SQLite state", "state": "In Progress", "role": "dev", "assigned_window": "dev1", "delegated": True}])
db.execute("INSERT INTO anomalies(window_name, kind, message, detected_at) VALUES('qa1', 'frozen_working', 'qa1 output still for 400s', 1)")
`);
}

test('status refreshes from tmux when no dogwatch ran and lists windows, tickets, questions and anomalies', { skip: !hasPython }, () => {
  const box = sandbox();
  try {
    const first = run(box, ['status', '--json']);
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(JSON.parse(first.stdout).windows.map((w) => [w.name, w.state]), [['dev1', 'blocked'], ['qa1', 'idle']]);
    seedTeam(box);
    py(box, `work_db.sync_escalations(db, [{"target": "dev1", "prompt_type": "permission", "question": "Do you want to proceed?", "options": ["Yes", "No"], "relayed_to_pm": True}], lambda t, e: "fp1")`);

    const data = JSON.parse(run(box, ['status', '--json']).stdout);
    const dev1 = data.windows.find((w) => w.name === 'dev1');
    assert.equal(dev1.ticket.sequence_id, 66);
    assert.equal(typeof dev1.duration, 'number');
    assert.equal(dev1.last_activity_line, 'Do you want to proceed?');
    assert.equal(data.escalations[0].status, 'relayed');
    assert.equal(data.anomalies[0].kind, 'frozen_working');

    const text = run(box, ['status']);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /^session work_test · last dogwatch look \d+s ago/);
    assert.match(text.stdout, /dev1\s+dev\s+blocked\s+\d+s\s+opencode \(x\)\s+\[66\] In Progress\s+Do you want to proceed\?/);
    assert.match(text.stdout, /pending questions:\n {2}dev1 \(relayed, \d+s\): Do you want to proceed\? \[Yes \| No\]/);
    assert.match(text.stdout, /anomalies:\n {2}qa1 frozen_working: qa1 output still for 400s/);
  } finally {
    box.cleanup();
  }
});

test('status without a database or a tmux session says how to get one', { skip: !hasPython }, () => {
  const box = sandbox();
  try {
    const out = runBare(box, ['status'], { TMUX_SESSIONS: 'other_project\\n' });
    assert.equal(out.status, 1);
    assert.match(out.stderr, /no shared state yet/);
  } finally {
    box.cleanup();
  }
});

test('log prints the newest events, filtered by window and limit', { skip: !hasPython }, () => {
  const box = sandbox();
  try {
    py(box, `
for i in range(5):
    work_db.log_event(db, 1700000000 + i, "dev1" if i % 2 == 0 else "qa1", "window", "state", f"event {i}")
`);
    const all = JSON.parse(run(box, ['log', '--json']).stdout);
    assert.deepEqual(all.map((e) => e.summary), ['event 0', 'event 1', 'event 2', 'event 3', 'event 4']);
    const dev1 = JSON.parse(run(box, ['log', '--window', 'dev1', '--limit', '2', '--json']).stdout);
    assert.deepEqual(dev1.map((e) => e.summary), ['event 2', 'event 4'], 'oldest first, newest kept');
    const text = run(box, ['log', '--limit', '1']);
    assert.match(text.stdout.trim(), /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d {2}window\/state {2}dev1 {2}event 4$/);
  } finally {
    box.cleanup();
  }
});

test('inspect shows one window card with ticket, tail and recent events', { skip: !hasPython }, () => {
  const box = sandbox();
  try {
    run(box, ['status']);
    seedTeam(box);
    const out = run(box, ['inspect', 'dev1']);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /^dev1 · blocked for \d+s · agent opencode/);
    assert.match(out.stdout, /ticket: \[66\] In Progress SQLite state/);
    assert.match(out.stdout, /--- tail ---\nDo you want to proceed\?\n/);
    assert.match(out.stdout, /--- recent events ---\n.*dev1 new -> blocked/);
    const card = JSON.parse(run(box, ['inspect', 'qa1', '--json']).stdout);
    assert.equal(card.window.name, 'qa1');
    assert.equal(card.anomalies[0].kind, 'frozen_working');

    const missing = run(box, ['inspect', 'dev9']);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /window 'dev9' not found/);
  } finally {
    box.cleanup();
  }
});

test('prompt leaves a shared barrier that the dogwatch marks busy and wait clears', { skip: !hasPython }, () => {
  const box = sandbox();
  try {
    writeState(box, windows());
    assert.equal(run(box, ['prompt', 'dev1', 'run', 'the', 'tests']).status, 0);
    const barrier = JSON.parse(py(box, 'import json; print(json.dumps(dict(work_db.barrier(db, "dev1"))))'));
    assert.equal(barrier.session, 'work_test');
    assert.equal(barrier.instruction_preview, 'run the tests');
    assert.equal(typeof barrier.sent_at_ms, 'number');
    assert.equal(typeof barrier.observed_busy_at_ms, 'number', 'the refresh after the prompt saw dev1 blocked');

    const out = run(box, ['wait', 'dev1', '--until', 'blocked', '--timeout', '5']);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(py(box, 'print(work_db.barrier(db, "dev1"))').trim(), 'None');
  } finally {
    box.cleanup();
  }
});

test('the cleaned-output hash is the one dogwatch.rs computes', { skip: !hasPython }, () => {
  const box = sandbox();
  try {
    const sample = '⏺ Running the tests\n  npm test passed\n✻ Thinking… (12s · esc to interrupt)\n╭───╮\n│ > │\n╰───╯\n';
    const out = JSON.parse(py(box, `import json; print(json.dumps(work_db.activity(${JSON.stringify(sample)})))`));
    assert.equal(out.output_hash, 'c226aa322ef97bd9a89063feb23d72fadff39516ef444cc4295a7b781fc28351');
    assert.equal(out.last_activity_line, 'npm test passed');
    assert.equal(out.tail_preview, '⏺ Running the tests\nnpm test passed');
  } finally {
    box.cleanup();
  }
});

test('the shared database and its WAL files are never committed', () => {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  for (const file of ['.claude/work.db', '.claude/work.db-wal', '.claude/work.db-shm']) {
    const out = spawnSync('git', ['check-ignore', '-q', file], { cwd: repo });
    assert.equal(out.status, 0, `${file} must be ignored`);
  }
});

// ── Roles and real agents ──

test('status shows the role, the agent with its model and a summary per role, with filters', { skip: !hasPython }, () => {
  const box = sandbox();
  try {
    const out = run(box, ['status']);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /^roles: dev=dev1:opencode\(x\) · qa=qa1:codex$/m);
    assert.match(out.stdout, /^WINDOW\s+ROLE\s+STATE\s+FOR\s+AGENT\s+TICKET\s+LAST ACTIVITY$/m);
    assert.match(out.stdout, /^qa1\s+qa\s+idle\s+\d+s\s+codex\s+-\s+all good$/m);

    const qa = JSON.parse(run(box, ['status', '--role', 'qa', '--json']).stdout);
    assert.deepEqual(qa.windows.map((w) => [w.name, w.role, w.agent]), [['qa1', 'qa', 'codex']]);
    assert.equal(qa.roles, 'roles: dev=dev1:opencode(x) · qa=qa1:codex', 'the summary covers the whole team');
    const dev1 = JSON.parse(run(box, ['status', '--agent', 'ollama', '--json']).stdout).windows;
    assert.deepEqual(dev1.map((w) => [w.name, w.model, w.start_command]), [['dev1', 'x', 'ollama launch opencode --model x']]);
    assert.equal(run(box, ['status', '--role', 'boss']).status, 1, 'an unknown role is a usage error');
  } finally {
    box.cleanup();
  }
});

test('list filters by role and by agent', { skip: !hasPython }, () => {
  const box = sandbox();
  try {
    writeState(box, windows());
    assert.deepEqual(run(box, ['list', '--role', 'qa']).stdout.trim().split('\n'), ['qa1\tidle\tcodex']);
    assert.deepEqual(run(box, ['list', '--agent', 'opencode']).stdout.trim().split('\n'), ['dev1\tworking\topencode\topencode-spinner']);
    assert.equal(run(box, ['list', '--role', 'doc']).stdout.trim(), '(no agent windows)');
  } finally {
    box.cleanup();
  }
});

test('prompt --require-agent refuses a window running another agent', { skip: !hasPython }, () => {
  const box = sandbox();
  try {
    writeState(box, windows());
    const wrong = run(box, ['prompt', 'qa1', 'run e2e', '--require-agent', 'claude']);
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /qa1 runs codex, not claude/);
    assert.doesNotMatch(readFileSync(box.log, 'utf8'), /send-keys -t work_test:qa1/);

    const right = run(box, ['prompt', 'qa1', 'run e2e', '--require-agent', 'codex']);
    assert.equal(right.status, 0, right.stderr);
    assert.equal(right.stdout.trim(), 'sent\tqa1');
  } finally {
    box.cleanup();
  }
});

test('prompt to a role picks its first idle window running the required agent', { skip: !hasPython }, () => {
  const box = sandbox();
  try {
    const out = run(box, ['prompt', 'qa', 'run', 'e2e', '--require-agent', 'codex']);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout.trim(), 'sent\tqa1');
    assert.match(readFileSync(box.log, 'utf8'), /send-keys -t work_test:qa1 -l -- run e2e/);

    const none = run(box, ['prompt', 'qa', 'run e2e', '--require-agent', 'claude']);
    assert.equal(none.status, 1);
    assert.match(none.stderr, /no idle qa window running claude \(qa1: codex idle\)/);
    const busy = run(box, ['prompt', 'dev', 'fix it']);
    assert.equal(busy.status, 1, 'dev1 is waiting for an answer, not idle');
    assert.match(busy.stderr, /no idle dev window \(dev1: opencode blocked\)/);
  } finally {
    box.cleanup();
  }
});

// ── Ready teammates ──

test('wait --until idle and done accept a ready teammate', { skip: !hasPython }, () => {
  const box = sandbox();
  try {
    writeState(box, [{ id: '@1', name: 'qa1', agent: 'codex', state: 'ready', rule: null, prompt: null }]);
    py(box, `db.execute("INSERT INTO windows(name, state, state_changed_at, last_output_change_at, updated_at) VALUES('qa1', 'ready', 1, 1, 1)")`);
    const out = run(box, ['wait', 'qa1', '--until', 'idle', '--timeout', '5']);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout.trim(), 'qa1\tready');
    const done = run(box, ['wait', 'qa1', '--until', 'done', '--timeout', '5']);
    assert.equal(done.stdout.trim(), 'qa1\tdone');
  } finally {
    box.cleanup();
  }
});

test('the live scan keeps a registered teammate ready, drops the ones gone and status shows only the team', { skip: !hasPython }, () => {
  const box = sandbox();
  try {
    py(box, `
db.execute("INSERT INTO windows(name, state, state_changed_at, last_output_change_at, updated_at) VALUES('qa1', 'ready', 1, 1, 1)")
db.execute("INSERT INTO windows(name, state, state_changed_at, last_output_change_at, updated_at) VALUES('dev9', 'idle', 1, 1, 1)")
`);
    const data = JSON.parse(run(box, ['status', '--json']).stdout);
    assert.deepEqual(data.windows.map((w) => [w.name, w.state]), [['dev1', 'blocked'], ['qa1', 'ready']]);
    assert.equal(py(box, `print(db.execute("SELECT summary FROM events WHERE kind = 'removed'").fetchone()[0])`).trim(), 'dev9 removed from team');
    assert.match(run(box, ['list']).stdout, /^qa1\tready\tcodex$/m);
  } finally {
    box.cleanup();
  }
});

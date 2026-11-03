// scripts/tmux-dogwatch.py: interactive prompt detection, escalation file and
// answer helper, driven through a fake tmux executable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/tmux-dogwatch.py', import.meta.url));
const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });
const hasPython = python.status === 0;

const FAKE = `#!/bin/sh
printf '%s\\n' "$*" >> "$TMUX_LOG"
if [ "$DOGWATCH_CLEAN" = "1" ]; then
  case "$1" in
    list-windows) printf '@0\\tdev1\\t1\\t/p\\n' ;;
    capture-pane) printf 'all good, working\\n' ;;
    display-message) printf 'work_test\\n' ;;
  esac
  exit 0
fi
if [ "$DOGWATCH_RESUMED" = "1" ]; then
  case "$1" in
    list-windows) printf '@0\\tdev1\\t1\\t/p\\n' ;;
    capture-pane) printf 'Do you want to proceed? [y/N]\\nANSWER=no\\nrunning the test suite\\n' ;;
    display-message) printf 'work_test\\n' ;;
  esac
  exit 0
fi
case "$1" in
  list-windows)
    printf '@0\\tdev1\\t1\\t/p\\n@1\\tdev2\\t0\\t/p\\n@2\\tqa\\t0\\t/p\\n@3\\tagent1\\t0\\t/p\\n@4\\tshell\\t0\\t/p\\n'
    ;;
  capture-pane)
    case "$*" in
      *:dev1*) printf 'Do you want to proceed?\\n❯ 1. Yes\\n  2. No\\n' ;;
      *:qa*) printf 'Continue with the deploy? [y/N]\\n' ;;
      *:agent1*) printf 'Could you clarify which file should I edit?\\n' ;;
      *) printf 'just working\\n' ;;
    esac
    ;;
  display-message) printf 'work_test\\n' ;;
  list-sessions) printf 'work_test\\n' ;;
esac
`;

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'work-dogwatch-'));
  const tmux = join(dir, 'tmux');
  writeFileSync(tmux, FAKE);
  chmodSync(tmux, 0o755);
  writeFileSync(join(dir, 'tmux.log'), '');
  return {
    dir,
    tmux,
    log: join(dir, 'tmux.log'),
    file: join(dir, '.claude', 'escalation_to_pm.json'),
    env: { ...process.env, TMUX_LOG: join(dir, 'tmux.log'), TMUX_DOGWATCH_TMUX: tmux },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const run = (box, args, env = {}) =>
  spawnSync('python3', [SCRIPT, ...args, '--root', box.dir], {
    encoding: 'utf8',
    env: { ...box.env, ...env },
    timeout: 20_000,
  });

const pending = (stdout) => JSON.parse(stdout).pending;
const readPending = (box) => JSON.parse(readFileSync(box.file, 'utf8')).pending;

test('--once segnala solo le finestre agenti bloccate e scrive il file di escalation', { skip: !hasPython }, () => {
  const box = sandbox();
  try {
    const out = run(box, ['--once', '--session', 'work_test']);
    assert.equal(out.status, 0, out.stderr);
    const state = JSON.parse(out.stdout);
    assert.equal(state.session, 'work_test');
    assert.deepEqual(state.pending.map((p) => p.target), ['dev1', 'qa', 'agent1'], 'shell and clean windows are skipped');

    const [dev1, qa, agent] = state.pending;
    assert.equal(dev1.prompt_type, 'permission');
    assert.equal(dev1.question, 'Do you want to proceed?');
    assert.deepEqual(dev1.options, ['Yes', 'No']);
    assert.equal(qa.prompt_type, 'confirmation');
    assert.deepEqual(qa.options, ['Yes', 'No']);
    assert.equal(agent.prompt_type, 'question');
    assert.match(agent.question, /which file/);
    for (const entry of state.pending) {
      assert.equal(entry.timestamp, state.updated_at, 'each entry carries the scan timestamp');
    }

    assert.ok(existsSync(box.file), '.claude/escalation_to_pm.json created');
    assert.deepEqual(readPending(box), state.pending, 'the file mirrors the JSON output');

    const shared = JSON.parse(readFileSync(join(box.dir, '.claude', 'dogwatch_state.json'), 'utf8'));
    assert.equal(shared.session, 'work_test');
    assert.deepEqual(
      shared.windows.map((w) => [w.name, w.state]),
      [['dev1', 'blocked'], ['dev2', 'idle'], ['qa', 'blocked'], ['agent1', 'blocked']],
      'work-agent reads the same state snapshot',
    );
  } finally {
    box.cleanup();
  }
});

test('--check è un alias di --once e riscrive un file vuoto quando nessuno è bloccato', { skip: !hasPython }, () => {
  const box = sandbox();
  try {
    const blocked = run(box, ['--check', '--session', 'work_test']);
    assert.equal(blocked.status, 0, blocked.stderr);
    assert.equal(pending(blocked.stdout).length, 3);

    const clean = run(box, ['--once', '--session', 'work_test'], { DOGWATCH_CLEAN: '1' });
    assert.equal(clean.status, 0, clean.stderr);
    assert.deepEqual(pending(clean.stdout), []);
    assert.deepEqual(readPending(box), [], 'questions that disappeared are cleared');
  } finally {
    box.cleanup();
  }
});

test('un prompt già risposto, seguito da nuovo output, non resta in pending (regressione)', { skip: !hasPython }, () => {
  const box = sandbox();
  try {
    const out = run(box, ['--once', '--session', 'work_test'], { DOGWATCH_RESUMED: '1' });
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(pending(out.stdout), []);
    assert.deepEqual(readPending(box), []);
  } finally {
    box.cleanup();
  }
});

test('answer invia il testo e invio al pane della finestra bersaglio', { skip: !hasPython }, () => {
  const box = sandbox();
  try {
    const out = run(box, ['answer', 'dev1', 'yes,', 'go'], {});
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(JSON.parse(out.stdout), { sent: true, pane: 'work_test:dev1' });
    const log = readFileSync(box.log, 'utf8');
    assert.match(log, /send-keys -t work_test:dev1 -l -- yes, go/);
    assert.match(log, /send-keys -t work_test:dev1 Enter/);

    const noEnter = run(box, ['answer', 'qa', 'no'], {});
    assert.equal(noEnter.status, 0, noEnter.stderr);
  } finally {
    box.cleanup();
  }
});

test('--daemon scrive il file di escalation a ogni giro finché non viene fermato', { skip: !hasPython }, async () => {
  const box = sandbox();
  const child = spawn('python3', [SCRIPT, '--daemon', '--interval', '0.2', '--session', 'work_test', '--root', box.dir], {
    env: box.env,
    stdio: 'ignore',
  });
  try {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (existsSync(box.file)) {
        try {
          if (readPending(box).length === 3) break;
        } catch {
          // the atomic replace may be between reads
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(readPending(box).length, 3);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
    box.cleanup();
  }
});

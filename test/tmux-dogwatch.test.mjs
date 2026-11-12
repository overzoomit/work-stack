// scripts/tmux-dogwatch.py: interactive prompt detection, escalation file and
// answer helper, driven through a fake tmux executable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
if [ "$DOGWATCH_DOCS" = "1" ]; then
  case "$1" in
    list-windows) printf '@0\tdoc1\t1\t/p\n@1\tdocs\t0\t/p\n' ;;
    capture-pane) printf 'just working\n' ;;
    display-message) printf 'work_test\n' ;;
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

test('le finestre doc1/doc2 sono agenti validi, "docs" no', { skip: !hasPython }, () => {
  const box = sandbox();
  try {
    const out = run(box, ['--once', '--session', 'work_test'], { DOGWATCH_DOCS: '1' });
    assert.equal(out.status, 0, out.stderr);
    const shared = JSON.parse(readFileSync(join(box.dir, '.claude', 'dogwatch_state.json'), 'utf8'));
    assert.deepEqual(shared.windows.map((w) => w.name), ['doc1'], 'docs is not an agent window');
  } finally {
    box.cleanup();
  }
});

test('--once fills .claude/work.db and answer records the reply on the open question', { skip: !hasPython }, () => {
  const box = sandbox();
  const db = join(box.dir, '.claude', 'work.db');
  const query = (sql) => {
    const out = spawnSync('python3', ['-c', `import json, sqlite3; c = sqlite3.connect(${JSON.stringify(db)}); c.row_factory = sqlite3.Row; print(json.dumps([dict(r) for r in c.execute(${JSON.stringify(sql)})]))`], { encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    return JSON.parse(out.stdout);
  };
  try {
    assert.equal(run(box, ['answer', 'dev1', 'yes']).status, 0);
    assert.equal(existsSync(db), false, 'answer never creates the database');

    assert.equal(run(box, ['--once', '--session', 'work_test']).status, 0);
    const windows = query('SELECT name, state, last_activity_line FROM windows ORDER BY name');
    assert.deepEqual(windows.map((w) => [w.name, w.state]), [['agent1', 'blocked'], ['dev1', 'blocked'], ['dev2', 'idle'], ['qa', 'blocked']]);
    assert.equal(windows.find((w) => w.name === 'dev2').last_activity_line, 'just working');
    const shared = JSON.parse(readFileSync(join(box.dir, '.claude', 'dogwatch_state.json'), 'utf8'));
    assert.equal(typeof shared.windows[0].state_changed_at, 'number');
    assert.deepEqual(query("SELECT window_name, status FROM escalations ORDER BY window_name").map((e) => [e.window_name, e.status]),
      [['agent1', 'pending'], ['dev1', 'pending'], ['qa', 'pending']]);

    assert.equal(run(box, ['answer', 'dev1', 'yes']).status, 0);
    const [dev1] = query("SELECT answer_text, answered_by, status FROM escalations WHERE window_name = 'dev1'");
    assert.deepEqual(dev1, { answer_text: 'yes', answered_by: 'pm', status: 'pending' });
  } finally {
    box.cleanup();
  }
});

test('an agent started by hand in a shell is detected from the pane process tree, with its model', { skip: !hasPython }, async () => {
  const box = sandbox();
  // A shell (the pane process) running a "claude" in the qa1 window, whose role default is codex.
  const claude = join(box.dir, 'bin', 'claude');
  mkdirSync(dirname(claude), { recursive: true });
  writeFileSync(claude, '#!/bin/sh\nsleep 30\n');
  chmodSync(claude, 0o755);
  const shell = spawn('bash', ['-c', `"${claude}" --model opus-4 & wait`], { stdio: 'ignore' });
  const fake = join(box.dir, 'tmux-tree');
  writeFileSync(fake, `#!/bin/sh
case "$1" in
  list-windows) printf '@0\\tqa1\\t1\\t/p\\n@1\\tdev1\\t0\\t/p\\n' ;;
  capture-pane) printf 'done\\n> \\n' ;;
  display-message)
    case "$*" in
      *:qa1*) printf '\\tbash\\tqa1-host\\t${shell.pid}\\n' ;;
      *:dev1*) printf 'ollama launch opencode --model deepseek-v4.1-flash:cloud\\tollama\\tdev1\\t1\\n' ;;
      *) printf 'work_test\\n' ;;
    esac ;;
esac
`);
  chmodSync(fake, 0o755);
  try {
    let windows = [];
    for (let i = 0; i < 50 && !windows.find((w) => w.name === 'qa1' && w.agent === 'claude'); i++) {
      await new Promise((r) => setTimeout(r, 100));
      const out = run(box, ['--once', '--session', 'work_test'], { TMUX_DOGWATCH_TMUX: fake });
      assert.equal(out.status, 0, out.stderr);
      windows = JSON.parse(readFileSync(join(box.dir, '.claude', 'dogwatch_state.json'), 'utf8')).windows;
    }
    const qa1 = windows.find((w) => w.name === 'qa1');
    assert.equal(qa1.agent, 'claude', 'the real agent, not the codex default of the qa role');
    assert.equal(qa1.role, 'qa');
    assert.equal(qa1.model, 'opus-4');
    assert.match(qa1.start_command, /bin\/claude --model opus-4$/);
    assert.equal(qa1.current_command, 'bash');
    const dev1 = windows.find((w) => w.name === 'dev1');
    assert.deepEqual([dev1.agent, dev1.role, dev1.model], ['opencode', 'dev', 'deepseek-v4.1-flash:cloud']);

    const db = spawnSync('python3', ['-c', `import json, sqlite3; c = sqlite3.connect(${JSON.stringify(join(box.dir, '.claude', 'work.db'))}); print(json.dumps(c.execute("SELECT name, role, agent, model FROM windows ORDER BY name").fetchall()))`], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(db.stdout), [['dev1', 'dev', 'opencode', 'deepseek-v4.1-flash:cloud'], ['qa1', 'qa', 'claude', 'opus-4']]);
  } finally {
    shell.kill();
    box.cleanup();
  }
});

test('Python detects the agent with the same rules as dogwatch.rs', { skip: !hasPython }, () => {
  // The inputs of an_agent_started_by_hand_in_a_shell_beats_the_role_default (Rust).
  const code = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("t", ${JSON.stringify(SCRIPT)}); t = importlib.util.module_from_spec(spec); spec.loader.exec_module(t)
table = t.parse_ps("  100     1 -zsh\\n  200   100 node /home/u/.npm/bin/claude --model opus\\n  300   200 npx @playwright/mcp\\n bad line\\n")
tree = t.tree_commands(table, 100)
out = []
for name, pane, tr in [("qa1", "\\tzsh\\tqa1-host\\t100", tree), ("dev1", "opencode\\tcodex\\t\\t100", tree), ("dev2", "\\tbash\\tdev2\\t7", ["npm run dev"])]:
    m, hint = t.detect_manifest(name, t.agent_hints(t.parse_pane(pane), tr))
    out.append([m["id"], t.model_of(hint)])
print(json.dumps([tree, out, t.canonical_agent("ollama"), t.canonical_agent("qa")]))
`;
  const out = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), [
    ['node /home/u/.npm/bin/claude --model opus', 'npx @playwright/mcp'],
    [['claude', 'opus'], ['codex', null], ['opencode', null]],
    'opencode',
    'qa',
  ]);
});

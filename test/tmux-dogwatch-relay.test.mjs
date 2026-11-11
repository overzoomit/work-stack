// scripts/tmux-dogwatch.py --relay-pm: a blocked worker's question reaches an
// idle PM once, the relay file keeps that memory across runs, and it resets when
// the worker unblocks. Driven through a fake tmux executable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/tmux-dogwatch.py', import.meta.url));
const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });
const hasPython = python.status === 0;

const FAKE = `#!/bin/sh
printf '%s\\n' "$*" >> "$TMUX_LOG"
case "$1" in
  list-windows) printf '@0\\tpm\\t1\\t/p\\n@1\\tdev1\\t0\\t/p\\n' ;;
  capture-pane)
    case "$*" in
      *:pm*) if [ "$PM_BLOCKED" = 1 ]; then printf 'Continue? [y/N]\\n'; else printf 'waiting for the next task\\n'; fi ;;
      *:dev1*)
        if [ "$DEV1_BLOCKED" = 1 ]; then
          printf 'Do you want to proceed?\\n❯ 1. Yes\\n  2. No\\n';
        elif [ "$DEV1_QUESTION_PROMPT" = 1 ]; then
          printf 'Task complete. Should I write unit tests for the changes?\\n❯ \\n';
        else
          printf 'running the suite\\n';
        fi
        ;;
    esac
    ;;
  display-message) printf 'work_test\\n' ;;
  list-sessions) printf 'work_test\\n' ;;
esac
exit 0
`;

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'work-relay-'));
  const tmux = join(dir, 'tmux');
  writeFileSync(tmux, FAKE);
  chmodSync(tmux, 0o755);
  const log = join(dir, 'tmux.log');
  writeFileSync(log, '');
  return {
    dir,
    log,
    relayFile: join(dir, '.claude', 'dogwatch_relay.json'),
    env: { ...process.env, TMUX_LOG: log, TMUX_DOGWATCH_TMUX: tmux },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const run = (box, env, extra = []) => {
  const out = spawnSync('python3', [SCRIPT, '--once', '--root', box.dir, ...extra], {
    encoding: 'utf8',
    env: { ...box.env, ...env },
    timeout: 20_000,
  });
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout);
};

const pmSends = (box) =>
  readFileSync(box.log, 'utf8').split('\n').filter((line) => line.includes('send-keys -t work_test:pm -l'));

const relayed = (box) => JSON.parse(readFileSync(box.relayFile, 'utf8')).relayed;

test('una domanda bloccata arriva al PM inattivo una sola volta, anche tra un processo e l’altro', { skip: !hasPython }, () => {
  const box = sandbox();
  try {
    const first = run(box, { DEV1_BLOCKED: '1' }, ['--relay-pm']);
    assert.equal(first.pending[0].target, 'dev1');
    assert.equal(first.pending[0].relayed_to_pm, true);
    const [sent] = pmSends(box);
    assert.ok(sent, 'the PM window receives the prompt');
    assert.match(sent, /tmux-dogwatch\.py answer dev1/);
    assert.match(sent, /telegram-pm\.py send/);
    assert.ok(existsSync(box.relayFile), 'the memory is written');
    assert.deepEqual(Object.keys(relayed(box)), ['dev1']);

    const second = run(box, { DEV1_BLOCKED: '1' }, ['--relay-pm']);
    assert.equal(second.pending[0].relayed_to_pm, true);
    assert.equal(pmSends(box).length, 1, 'a second process reads the memory and stays silent');
  } finally {
    box.cleanup();
  }
});

test('il relay non parte se il PM è occupato, e riparte appena torna inattivo', { skip: !hasPython }, () => {
  const box = sandbox();
  try {
    const busy = run(box, { DEV1_BLOCKED: '1', PM_BLOCKED: '1' }, ['--relay-pm']);
    assert.equal(busy.pending[0].relayed_to_pm, false);
    assert.equal(pmSends(box).length, 0, 'the PM is asking something itself');
    assert.equal(existsSync(box.relayFile), false, 'nothing relayed, nothing remembered');

    const idle = run(box, { DEV1_BLOCKED: '1' }, ['--relay-pm']);
    assert.equal(idle.pending[0].relayed_to_pm, true);
    assert.equal(pmSends(box).length, 1);
  } finally {
    box.cleanup();
  }
});

test('quando il bersaglio si sblocca la memoria si svuota e un nuovo blocco viene inoltrato di nuovo', { skip: !hasPython }, () => {
  const box = sandbox();
  try {
    run(box, { DEV1_BLOCKED: '1' }, ['--relay-pm']);
    const cleared = run(box, { DEV1_BLOCKED: '0' }, ['--relay-pm']);
    assert.deepEqual(cleared.pending, []);
    assert.deepEqual(relayed(box), {}, 'the key is dropped once the window unblocks');

    const again = run(box, { DEV1_BLOCKED: '1' }, ['--relay-pm']);
    assert.equal(again.pending[0].relayed_to_pm, true);
    assert.equal(pmSends(box).length, 2);
  } finally {
    box.cleanup();
  }
});

test('senza --relay-pm il PM non riceve nulla e le voci restano con relayed_to_pm falso', { skip: !hasPython }, () => {
  const box = sandbox();
  try {
    const out = run(box, { DEV1_BLOCKED: '1' });
    assert.equal(out.pending[0].relayed_to_pm, false);
    assert.equal(pmSends(box).length, 0);
    assert.equal(existsSync(box.relayFile), false);
  } finally {
    box.cleanup();
  }
});

test('una domanda aperta con cursore interattivo sulla riga finale viene estratta e inoltrata al PM', { skip: !hasPython }, () => {
  const box = sandbox();
  try {
    const out = run(box, { DEV1_QUESTION_PROMPT: '1' }, ['--relay-pm']);
    assert.equal(out.pending.length, 1);
    assert.equal(out.pending[0].target, 'dev1');
    assert.equal(out.pending[0].relayed_to_pm, true);
    assert.equal(out.pending[0].prompt_type, 'question');
    assert.match(out.pending[0].question, /Should I write unit tests/);
    const [sent] = pmSends(box);
    assert.ok(sent);
    assert.match(sent, /Should I write unit tests/);
  } finally {
    box.cleanup();
  }
});

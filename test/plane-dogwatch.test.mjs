// scripts/plane-dogwatch.py: Plane tickets delegated to the agents of a tmux
// session, against a local mock of the Plane REST API and a fake tmux.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { basename } from 'node:path';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/plane-dogwatch.py', import.meta.url));
const hasPython = spawnSync('python3', ['--version']).status === 0;
const skip = !hasPython;

const FAKE_TMUX = `#!/bin/sh
printf '%s\\n' "$*" >> "$TMUX_LOG"
case "$1" in
  list-windows) printf 'pm\\tagy\\tagy\\ndev1\\tollama launch opencode --model x\\tollama\\ndev2\\tollama launch opencode --model x\\tollama\\nqa1\\tcodex --full-auto\\tcodex\\n' ;;
  capture-pane)
    for w in $FAKE_BUSY; do
      case "$*" in *":$w "*) printf 'running\\n* Working (12s - esc to interrupt)\\n> \\n'; exit 0 ;; esac
    done
    printf 'done.\\n> \\n'
    ;;
  display-message) printf 'work_test\\n' ;;
esac
`;

const FAKE_TELEGRAM = `import sys
open(sys.argv[0] + '.log', 'a').write(' '.join(sys.argv[1:]) + '\\n')
print('{"sent": true}')
`;

const STATES = [
  { id: 's-todo', name: 'Todo' },
  { id: 's-progress', name: 'In Progress' },
  { id: 's-test', name: 'Test' },
  { id: 's-reopen', name: 'Re-open' },
  { id: 's-done', name: 'Done' },
];

const issue = (seq, state, extra = {}) => ({
  id: `issue-${seq}`,
  sequence_id: seq,
  name: `Ticket title ${seq}`,
  description_html: `<p>Description ${seq}</p><ul><li>criterion A${seq}</li></ul>`,
  state,
  updated_at: '2026-11-01T10:00:00Z',
  ...extra,
});

// Plane mock: GET states/issues/comments, PATCH issue state, POST comment.
async function plane(issues, comments = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (req.headers['x-api-key'] !== 'test-key') return send(401, { error: 'unauthorized' });
      const path = req.url.replace('/api/v1/workspaces/ws/projects/p1/', '');
      const json = body ? JSON.parse(body) : null;
      requests.push({ method: req.method, path, body: json });
      if (req.method === 'GET' && path === 'states/') return send(200, { results: STATES });
      if (req.method === 'GET' && path === 'issues/') return send(200, { results: issues });
      let m = path.match(/^issues\/([^/]+)\/comments\/$/);
      if (m && req.method === 'GET') return send(200, { results: comments[m[1]] || [] });
      if (m && req.method === 'POST') return send(201, { id: 'c', ...json });
      m = path.match(/^issues\/([^/]+)\/$/);
      if (m && req.method === 'PATCH') {
        const found = issues.find((i) => i.id === m[1]);
        Object.assign(found, json, { updated_at: new Date().toISOString() });
        return send(200, found);
      }
      return send(404, { error: 'not found' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((r) => server.close(r)) };
}

function sandbox(api) {
  const dir = mkdtempSync(join(tmpdir(), 'work-plane-dogwatch-'));
  writeFileSync(join(dir, '.plane.json'), JSON.stringify({ project_id: 'p1', workspace_slug: 'ws' }));
  const tmux = join(dir, 'tmux');
  writeFileSync(tmux, FAKE_TMUX);
  chmodSync(tmux, 0o755);
  writeFileSync(join(dir, 'tmux.log'), '');
  const telegram = join(dir, 'telegram-pm.py');
  writeFileSync(telegram, FAKE_TELEGRAM);
  return {
    dir,
    telegramLog: `${telegram}.log`,
    stateFile: join(dir, '.claude', 'plane_dogwatch_state.json'),
    env: {
      ...process.env,
      PLANE_API_KEY: 'test-key',
      PLANE_BASE_URL: api.url,
      PLANE_CLI: join(dir, 'missing-plane-cli.py'),
      TMUX_DOGWATCH_TMUX: tmux,
      TMUX_LOG: join(dir, 'tmux.log'),
      FAKE_BUSY: '',
      WORK_OPENCODE_PRUNE: '0',
      WORK_OPENCODE_SETTLE: '0',
    },
    args: ['--root', dir, '--session', 'work_test', '--telegram', telegram],
    sends: () => readFileSync(join(dir, 'tmux.log'), 'utf8').split('\n').filter((l) => l.startsWith('send-keys') && l.includes(' -l ') && !l.includes(' -l -- /new')),
    resets: () => readFileSync(join(dir, 'tmux.log'), 'utf8').split('\n').filter((l) => l.includes(' -l -- /new')),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// Async: the mock server lives in this process and must keep answering.
function run(box, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn('python3', [SCRIPT, ...args, ...box.args], { env: { ...box.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (status) => resolve({ status, stdout, stderr, json: () => JSON.parse(stdout) }));
  });
}

const patches = (api) => api.requests.filter((r) => r.method === 'PATCH');

async function scenario(issues, comments, body) {
  const api = await plane(issues, comments);
  const box = sandbox(api);
  try {
    await body(api, box);
  } finally {
    await api.close();
    box.cleanup();
  }
}

test('Todo: the first free dev gets the ticket, which moves to In Progress with a comment', { skip }, () =>
  scenario([issue(1, 's-todo')], {}, async (api, box) => {
    const out = await run(box, ['--once']);
    assert.equal(out.status, 0, out.stderr);
    const result = out.json();
    assert.deepEqual(result.actions.map((a) => [a.issue, a.from, a.to, a.target]), [[1, 'todo', 'In Progress', 'dev1']]);
    assert.deepEqual(patches(api).map((r) => [r.path, r.body.state]), [['issues/issue-1/', 's-progress']]);
    const comment = api.requests.find((r) => r.method === 'POST');
    assert.match(comment.body.comment_html, /delegato a dev1/);

    const [send] = box.sends();
    assert.match(send, /-t work_test:dev1 -l -- /);
    assert.match(send, /Ticket \[1\] \(UUID: issue-1\): Ticket title 1/);
    assert.match(send, /Description 1 - criterion A1/, 'description and criteria as plain text');
    assert.doesNotMatch(send, /<p>|<li>/);

    const state = JSON.parse(readFileSync(box.stateFile, 'utf8'));
    assert.equal(state.issues['issue-1'].target, 'dev1');
    assert.equal(state.issues['issue-1'].state, 'in progress');
    assert.match(state.issues['issue-1'].hash, /^[0-9a-f]{64}$/);
  }));

test('an unchanged ticket is never delegated twice, not even to another free agent', { skip }, () =>
  scenario([issue(1, 's-todo'), issue(3, 's-test')], {}, async (api, box) => {
    assert.equal((await run(box, ['--once'])).status, 0);
    assert.equal(box.sends().length, 2, 'Todo to dev1, Test to the QA agent');
    const before = api.requests.filter((r) => r.method !== 'GET').length;

    const again = await run(box, ['--check', '--qa', 'qa1']);
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(again.json().actions, []);
    assert.equal(box.sends().length, 2, 'no new prompt');
    assert.equal(api.requests.filter((r) => r.method !== 'GET').length, before, 'no new write on Plane');
  }));

test('Re-open comes before Todo and carries the QA rejection', { skip }, () =>
  scenario(
    [issue(1, 's-todo'), issue(2, 's-reopen')],
    { 'issue-2': [
      { created_at: '2026-11-01T09:00:00Z', comment_html: '<p>Presa in carico</p>' },
      { created_at: '2026-11-01T11:00:00Z', comment_html: '<p>QA: the LED stays <b>off</b> at startup</p>' },
    ] },
    async (api, box) => {
      const out = await run(box, ['--once'], { FAKE_BUSY: 'dev2' });
      assert.equal(out.status, 0, out.stderr);
      const result = out.json();
      assert.deepEqual(result.actions.map((a) => [a.issue, a.target]), [[2, 'dev1']], 'the only free dev takes the Re-open');
      assert.deepEqual(result.waiting, [{ issue: 1, state: 'Todo', reason: 'no free dev' }]);
      assert.deepEqual(patches(api).map((r) => r.path), ['issues/issue-2/']);
      const [send] = box.sends();
      assert.match(send, /Re-open del Ticket \[2\]/);
      assert.match(send, /Motivo del QA: QA: the LED stays off at startup/);
    },
  ));

test('a Re-open goes back to the dev who worked on it when that dev is free', { skip }, () =>
  scenario([issue(2, 's-reopen')], {}, async (api, box) => {
    mkdirSync(join(box.dir, '.claude'));
    writeFileSync(box.stateFile, JSON.stringify({ issues: { 'issue-2': { role: 'dev', target: 'dev2', state: 'test', hash: 'old' } } }));
    const out = await run(box, ['--once']);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.json().actions[0].target, 'dev2');
    assert.match(box.sends()[0], /-t work_test:dev2 /);
  }));

test('Test: the QA agent gets the validation request, the state is left to QA', { skip }, () =>
  scenario(
    [issue(3, 's-test')],
    { 'issue-3': [{ created_at: '2026-11-01T11:00:00Z', comment_html: '<p>Files: src/a.js. npm test ok</p>' }] },
    async (api, box) => {
      const out = await run(box, ['--once']);
      assert.equal(out.status, 0, out.stderr);
      assert.deepEqual(out.json().actions.map((a) => [a.issue, a.from, a.to, a.target]), [[3, 'test', 'test', 'qa1']]);
      assert.equal(patches(api).length, 0, 'QA moves the ticket itself');
      const [send] = box.sends();
      assert.match(send, /-t work_test:qa1 /);
      assert.match(send, /Valida il Ticket \[3\]/);
      assert.match(send, /Files: src\/a\.js\. npm test ok/);
      assert.match(send, /'Done'.*'Re-open'/);
    },
  ));

test('a busy pane gets nothing, and a dev holding a delegated ticket is not free', { skip }, () =>
  scenario([issue(1, 's-todo'), issue(4, 's-todo')], {}, async (api, box) => {
    const out = await run(box, ['--once'], { FAKE_BUSY: 'dev1' });
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(out.json().actions.map((a) => [a.issue, a.target]), [[1, 'dev2']]);
    assert.deepEqual(out.json().waiting.map((w) => w.issue), [4]);

    const next = await run(box, ['--once']);
    assert.deepEqual(next.json().actions.map((a) => [a.issue, a.target]), [[4, 'dev1']], 'dev2 still holds ticket 1');
  }));

test('Done: the PM is notified once, and only for a ticket seen before it was done', { skip }, () => {
  const tickets = [issue(3, 's-test'), issue(9, 's-done')];
  return scenario(tickets, {}, async (api, box) => {
    await run(box, ['--once']);
    assert.equal(existsSync(box.telegramLog), false, 'old Done tickets are history, not news');

    tickets[0].state = 's-done';
    tickets[0].updated_at = '2026-11-02T10:00:00Z';
    const out = await run(box, ['--once']);
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(out.json().actions.map((a) => [a.issue, a.to, a.telegram]), [[3, 'done', 'sent']]);
    assert.match(
      readFileSync(box.telegramLog, 'utf8'),
      new RegExp(`^send \\[${basename(box.dir)}\\] ✅ Ticket \\[3\\] .* completato: Ticket title 3`),
      'the folder name tags the message when there is no .oz.json',
    );

    await run(box, ['--once']);
    assert.equal(readFileSync(box.telegramLog, 'utf8').trim().split('\n').length, 1, 'only once');
  });
});

test('Done: the .oz.json project key tags the message', { skip }, () => {
  const tickets = [issue(3, 's-test')];
  return scenario(tickets, {}, async (api, box) => {
    writeFileSync(join(box.dir, '.oz.json'), JSON.stringify({ version: 1, project: 'MIRADA' }));
    await run(box, ['--once']);
    tickets[0].state = 's-done';
    tickets[0].updated_at = '2026-11-02T10:00:00Z';
    await run(box, ['--once']);
    assert.match(readFileSync(box.telegramLog, 'utf8'), /^send \[MIRADA\] ✅ Ticket \[3\] /);
  });
});

test('without an API key it stops with a JSON error and touches nothing', { skip }, () =>
  scenario([issue(1, 's-todo')], {}, async (api, box) => {
    const out = await run(box, ['--once'], { PLANE_API_KEY: '' });
    assert.equal(out.status, 2);
    assert.match(out.json().error, /no Plane API key/);
    assert.equal(api.requests.length, 0);
    assert.equal(box.sends().length, 0);
  }));

test('--daemon polls until SIGTERM and exits cleanly', { skip }, () =>
  scenario([issue(1, 's-todo')], {}, async (api, box) => {
    const child = spawn('python3', [SCRIPT, '--daemon', '--interval', '0.5', ...box.args], { env: box.env });
    let stdout = '';
    const firstCycle = new Promise((resolve) => child.stdout.on('data', (c) => { stdout += c; if (stdout.includes('"actions"')) resolve(); }));
    const closed = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
    await firstCycle;
    child.kill('SIGTERM');
    assert.deepEqual(await closed, { code: 0, signal: null });
    assert.equal(box.sends().length, 1, 'the ticket was delegated once');
  }));

// ── OpenCode/Ollama session lifecycle ───────────────────────

test('an OpenCode dev is reset with /new before a delegated task', { skip }, () =>
  scenario([issue(1, 's-todo')], {}, async (api, box) => {
    const out = await run(box, ['--once']);
    assert.equal(out.status, 0, out.stderr);
    const [reset] = box.resets();
    assert.match(reset, /-t work_test:dev1 -l -- \/new/);
    assert.equal(box.sends().length, 1, 'the task prompt follows the reset');
    assert.match(box.sends()[0], /Ticket \[1\]/);
    assert.deepEqual(out.json().cleanups.map((c) => [c.target, c.reason]), [['dev1', 'before delegation']]);
  }));

test('a ticket leaving the working state resets the idle OpenCode window', { skip }, () => {
  const tickets = [issue(1, 's-todo')];
  return scenario(tickets, {}, async (api, box) => {
    assert.equal((await run(box, ['--once'])).status, 0);
    assert.equal(box.resets().length, 1, 'reset before the Todo delegation');

    tickets[0].state = 's-test';
    tickets[0].updated_at = '2026-11-02T10:00:00Z';
    const out = await run(box, ['--once']);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(box.resets().length, 2, 'reset again when the dev reaches Test');
    assert.match(box.resets()[1], /-t work_test:dev1 -l -- \/new/);
    assert.deepEqual(out.json().cleanups.map((c) => [c.target, c.reason]), [['dev1', 'task reached test']]);
  });
});

test('old OpenCode sessions are pruned through the CLI, keeping the newest ones', { skip }, () => {
  const tickets = [issue(1, 's-todo')];
  return scenario(tickets, {}, async (api, box) => {
    const bin = join(box.dir, 'opencode');
    const log = join(box.dir, 'opencode.log');
    writeFileSync(bin, `#!/bin/sh
printf '%s\\n' "$*" >> "$OPENCODE_LOG"
case "$1 $2" in
  "session list") printf '[{"id":"a"},{"id":"b"},{"id":"c"}]' ;;
  "session delete") exit 0 ;;
esac
`);
    chmodSync(bin, 0o755);
    writeFileSync(log, '');

    const out = await run(box, ['--once'], {
      WORK_OPENCODE_PRUNE: '1',
      WORK_OPENCODE_BIN: bin,
      WORK_OPENCODE_KEEP: '1',
      WORK_OPENCODE_PRUNE_INTERVAL: '0',
      OPENCODE_LOG: log,
    });
    assert.equal(out.status, 0, out.stderr);
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    assert.deepEqual(calls, [
      'session list --format json --max-count 100',
      'session delete b',
      'session delete c',
    ]);
    assert.deepEqual(out.json().opencode_cleanup.deleted, ['b', 'c']);
    assert.equal(existsSync(join(box.dir, '.claude', 'opencode_cleanup.json')), true, 'the next prune waits for the interval');
  });
});

test('cleanup of a finished ticket never wipes a new task delegated to the same window', { skip }, () => {
  const tickets = [issue(1, 's-todo'), issue(2, 's-todo')];
  return scenario(tickets, {}, async (api, box) => {
    // Only dev1 is free: ticket 1 goes there, ticket 2 waits for the next cycle.
    const first = await run(box, ['--once', '--devs', 'dev1']);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(box.resets().length, 1, 'reset before ticket 1');
    assert.equal(box.sends().length, 1);

    tickets[0].state = 's-test';
    tickets[0].updated_at = '2026-11-02T11:00:00Z';
    const second = await run(box, ['--once', '--devs', 'dev1']);
    assert.equal(second.status, 0, second.stderr);

    assert.equal(box.resets().length, 2, 'one reset per new task, never a third after ticket 2');
    assert.deepEqual(
      second.json().cleanups.map((c) => [c.issue, c.reason]),
      [[2, 'before delegation']],
      'the completed ticket skips cleanup because dev1 just received ticket 2',
    );
    const log = readFileSync(join(box.dir, 'tmux.log'), 'utf8');
    const prompt = box.sends().at(-1);
    const promptAt = log.lastIndexOf(prompt);
    assert.ok(promptAt > log.lastIndexOf('-l -- /new'), 'the last reset precedes the new prompt');
    assert.ok(!log.slice(promptAt).includes('-l -- /new'), 'no reset after ticket 2 was written');
  });
});

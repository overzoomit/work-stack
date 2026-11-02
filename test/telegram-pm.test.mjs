// scripts/telegram-pm.py: PM-only Telegram CLI, driven through a fake local
// API. The script may only send to the chat configured for Work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/telegram-pm.py', import.meta.url));
const TOKEN = '123456:AAHm2x3YqW8sVn4Lp6Rt0Zk9Bd1Cf5Gh7J';
const CHAT = '987654321';
const hasPython = spawnSync('python3', ['--version']).status === 0;

function sandbox(config) {
  const dir = mkdtempSync(join(tmpdir(), 'work-telegram-pm-'));
  const file = join(dir, 'telegram.json');
  if (config !== undefined) writeFileSync(file, JSON.stringify(config));
  return {
    dir,
    file,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function fakeApi(reply = (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, result: { message_id: 42 } }));
}) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body });
      reply(req, res, body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function run(box, args, { env = {}, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [SCRIPT, ...args], {
      cwd: box.dir,
      env: { ...process.env, WORK_TELEGRAM_CONFIG: box.file, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}

test('send posts to the configured chat and never prints the token', { skip: !hasPython }, async () => {
  const box = sandbox({ token: TOKEN, chat_id: CHAT, bot: 'work_pm_bot' });
  const api = await fakeApi();
  try {
    const out = await run(box, ['send', 'hello', 'PM'], {
      env: { WORK_TELEGRAM_API: api.url },
    });
    assert.equal(out.code, 0, out.stderr);
    assert.deepEqual(JSON.parse(out.stdout), { sent: true, chat_id: CHAT, message_id: 42 });

    assert.equal(api.requests.length, 1);
    const [request] = api.requests;
    assert.equal(request.method, 'POST');
    assert.equal(request.url, `/bot${TOKEN}/sendMessage`);
    assert.deepEqual(JSON.parse(request.body), { chat_id: CHAT, text: 'hello PM' });
    assert.ok(!out.stdout.includes(TOKEN), 'the token is not printed');
    assert.ok(!out.stderr.includes(TOKEN), 'the token is not printed');
  } finally {
    await api.close();
    box.cleanup();
  }
});

test('there is no recipient argument: only the configured chat can be reached', { skip: !hasPython }, async () => {
  const box = sandbox({ token: TOKEN, chat_id: CHAT });
  const api = await fakeApi();
  try {
    const out = await run(box, ['send', 'hello', '--chat-id', '111222333'], {
      env: { WORK_TELEGRAM_API: api.url },
    });
    assert.notEqual(out.code, 0, 'an arbitrary chat id is rejected');
    assert.equal(api.requests.length, 0, 'nothing was sent anywhere');
    assert.match(out.stderr, /unrecognized arguments: --chat-id/);
  } finally {
    await api.close();
    box.cleanup();
  }
});

test('an invalid chat id is refused before any request', { skip: !hasPython }, async () => {
  const box = sandbox({ token: TOKEN, chat_id: '999,111' });
  const api = await fakeApi();
  try {
    const out = await run(box, ['send', 'hello'], { env: { WORK_TELEGRAM_API: api.url } });
    assert.equal(out.code, 2);
    assert.equal(api.requests.length, 0);
    assert.match(JSON.parse(out.stdout).error, /chat id/i);
    assert.ok(!out.stdout.includes(TOKEN));
  } finally {
    await api.close();
    box.cleanup();
  }
});

test('missing credentials point at the Work connection and send nothing', { skip: !hasPython }, async () => {
  const box = sandbox();
  const api = await fakeApi();
  try {
    const out = await run(box, ['send', 'hello'], { env: { WORK_TELEGRAM_API: api.url } });
    assert.equal(out.code, 2);
    assert.equal(api.requests.length, 0);
    assert.match(JSON.parse(out.stdout).error, /not configured/i);
  } finally {
    await api.close();
    box.cleanup();
  }
});

test('text can come from stdin and is cut below the Telegram limit', { skip: !hasPython }, async () => {
  const box = sandbox({ token: TOKEN, chat_id: CHAT });
  const api = await fakeApi();
  try {
    const long = 'x'.repeat(5000);
    const out = await run(box, ['send'], {
      env: { WORK_TELEGRAM_API: api.url },
      input: long,
    });
    assert.equal(out.code, 0, out.stderr);
    const sent = JSON.parse(api.requests[0].body).text;
    assert.equal(sent.length, 4000);
    assert.ok(sent.endsWith('…'));
  } finally {
    await api.close();
    box.cleanup();
  }
});

test('environment credentials override the file without changing the recipient rule', { skip: !hasPython }, async () => {
  const box = sandbox({ token: '000:oldoldoldoldoldoldoldoldoldoldold', chat_id: '111' });
  const api = await fakeApi();
  try {
    const out = await run(box, ['send', 'hello'], {
      env: {
        WORK_TELEGRAM_API: api.url,
        WORK_TELEGRAM_TOKEN: TOKEN,
        WORK_TELEGRAM_CHAT_ID: CHAT,
      },
    });
    assert.equal(out.code, 0, out.stderr);
    assert.deepEqual(JSON.parse(api.requests[0].body), { chat_id: CHAT, text: 'hello' });
  } finally {
    await api.close();
    box.cleanup();
  }
});

test('a Telegram error is reported without leaking the token', { skip: !hasPython }, async () => {
  const box = sandbox({ token: TOKEN, chat_id: CHAT });
  const api = await fakeApi((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, description: 'Unauthorized' }));
  });
  try {
    const out = await run(box, ['send', 'hello'], { env: { WORK_TELEGRAM_API: api.url } });
    assert.equal(out.code, 2);
    assert.match(JSON.parse(out.stdout).error, /Unauthorized/);
    assert.ok(!out.stdout.includes(TOKEN));
    assert.ok(!out.stderr.includes(TOKEN));
  } finally {
    await api.close();
    box.cleanup();
  }
});

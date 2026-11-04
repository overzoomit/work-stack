import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const APP = `${ROOT}src-tauri/target/debug/work`;
const PORT = 4445;
const BASE = `http://127.0.0.1:${PORT}`;
const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${json.value?.message ?? res.status}`);
  return json.value;
}

async function waitForDriver(proc) {
  for (let i = 0; i < 150; i++) {
    if (proc.exitCode !== null) throw new Error(`app exited with code ${proc.exitCode}`);
    try {
      await fetch(`${BASE}/status`);
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error('embedded WebDriver server did not start');
}

export async function startApp() {
  if (!existsSync(APP)) throw new Error(`${APP} missing: run "npm run build:e2e" first`);
  const userData = mkdtempSync(join(tmpdir(), 'work-e2e-'));
  const proc = spawn(APP, [], {
    stdio: 'inherit',
    env: { ...process.env, TAURI_WEBDRIVER_PORT: String(PORT), WORK_USER_DATA: userData },
  });
  await waitForDriver(proc);
  const { sessionId } = await call('POST', '/session', { capabilities: { alwaysMatch: {} } });
  const url = (path) => `/session/${sessionId}${path}`;

  const app = {
    title: () => call('GET', url('/title')),
    screenshot: async () => Buffer.from(await call('GET', url('/screenshot')), 'base64'),
    find: async (selector) => {
      const el = await call('POST', url('/element'), { using: 'css selector', value: selector });
      return el[ELEMENT_KEY];
    },
    text: (id) => call('GET', url(`/element/${id}/text`)),
    click: (id) => call('POST', url(`/element/${id}/click`), {}),
    async waitFor(selector, timeout = 10000) {
      const deadline = Date.now() + timeout;
      for (;;) {
        try {
          return await app.find(selector);
        } catch (err) {
          if (Date.now() > deadline) throw err;
          await sleep(200);
        }
      }
    },
    async stop() {
      await call('DELETE', url('')).catch(() => {});
      proc.kill();
      rmSync(userData, { recursive: true, force: true });
    },
  };
  return app;
}

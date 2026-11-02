// ngrok Tunnel… dialog: prefill, start/stop, the public URL box, errors,
// a tunnel that closes on its own, and the chip's copy action.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { $, El, env, tick } from './helpers/renderer-env.mjs';

const N = await import('../src/renderer/ngrok.js');

const saves = [];
const changes = [];
let suggested = null;
N.initNgrok({ save: () => saves.push(1), changed: () => changes.push(1), suggestPort: () => suggested });

const project = { path: '/p', name: 'shop', run: { selected: null, custom: [] } };
const live = {
  active: true, port: 5173, protocol: 'http', domain: 'mia-app.ngrok-free.app',
  public_url: 'https://mia-app.ngrok-free.app', inspect_url: 'http://127.0.0.1:4041', error: null,
};
const off = { active: false };

const sheets = () => document.body.children.filter((c) => c.className === 'sheet ngrok-sheet' && !c.classList.contains('closing'));
const sheet = () => sheets().at(-1);
const q = (s) => sheet().querySelector(s);
const lastToast = () => $('#toasts').children.at(-1);
const click = (act) => {
  const target = new El();
  target.dataset = { act };
  sheet().onclick({ target });
};
const submit = () => q('.ng-form').onsubmit({ preventDefault() {} });
const reset = () => {
  N.closeNgrokPanel();
  env.ngrok.calls.length = 0;
  env.ngrok.status = off;
  env.ngrok.start = null;
  env.ngrok.gate = null;
  project.tunnel = null;
  project.run = { selected: null, custom: [] };
  saves.length = 0;
  suggested = null;
};

test('the dialog suggests the port a running command serves, else the last one used', async () => {
  reset();
  project.run.ngrok = { port: 8080, protocol: 'tcp', domain: 'x.ngrok.app' };
  await N.openNgrokPanel(project);
  assert.equal(sheets().length, 1);
  assert.equal(q('.ng-port').value, '8080');
  assert.equal(q('.ng-proto').value, 'tcp');
  assert.equal(q('.ng-domain').value, 'x.ngrok.app');
  assert.deepEqual(env.ngrok.calls, [['status', '/p']], 'the status is read on open');
  assert.equal(q('.ng-toggle').textContent, 'Start');
  assert.equal(q('.ng-live').hidden, true, 'no URL box before a tunnel');

  reset();
  suggested = 5173;
  await N.openNgrokPanel(project);
  assert.equal(q('.ng-port').value, '5173');
  assert.equal(q('.ng-proto').value, 'http', 'default protocol');
  await N.openNgrokPanel(project);
  assert.equal(sheets().length, 1, 'a second open does nothing');
});

test('Start opens the tunnel, saves the settings and shows the public URL', async () => {
  reset();
  await N.openNgrokPanel(project);
  q('.ng-port').value = '5173';
  q('.ng-proto').value = 'http';
  q('.ng-domain').value = '  mia-app.ngrok-free.app ';
  let release;
  env.ngrok.gate = new Promise((r) => { release = r; });
  env.ngrok.start = live;
  submit();
  await tick(0);
  assert.equal(q('.ng-toggle').textContent, 'Starting…');
  assert.equal(q('.ng-toggle').disabled, true);
  assert.ok(q('.ng-toggle').classList.contains('loading'));
  submit();
  release();
  await tick();
  assert.deepEqual(env.ngrok.calls.filter((c) => c[0] === 'start'), [['start', '/p', 5173, 'http', 'mia-app.ngrok-free.app']], 'one start, while busy');
  assert.deepEqual(project.run.ngrok, { port: 5173, protocol: 'http', domain: 'mia-app.ngrok-free.app' });
  assert.equal(saves.length, 1);
  assert.equal(lastToast().firstChild.textContent, 'Tunnel open: https://mia-app.ngrok-free.app');
  assert.equal(q('.ng-toggle').textContent, 'Stop');
  assert.ok(q('.ng-toggle').classList.contains('btn-danger'));
  assert.equal(q('.ng-port').disabled, true, 'a running tunnel is not edited');
  assert.equal(q('.ng-live').hidden, false);
  assert.equal(q('.ng-public').textContent, 'https://mia-app.ngrok-free.app');
  assert.equal(q('[data-act="open"]').hidden, false);
  assert.equal(q('.ng-inspect').textContent, 'Inspect traffic · 127.0.0.1:4041 ↗');
  assert.ok(changes.length > 0, 'the Run bar is told');

  click('copy');
  assert.equal(env.copied.at(-1), 'https://mia-app.ngrok-free.app');
  assert.equal(lastToast().firstChild.textContent, 'Copied https://mia-app.ngrok-free.app');
  const opened = env.opened.length;
  click('open');
  click('inspect');
  assert.deepEqual(env.opened.slice(opened), ['https://mia-app.ngrok-free.app', 'http://127.0.0.1:4041']);
});

test('Stop closes the tunnel and hides the URL box', async () => {
  submit();
  await tick();
  assert.deepEqual(env.ngrok.calls.at(-1), ['stop', '/p']);
  assert.equal(lastToast().firstChild.textContent, 'ngrok tunnel closed');
  assert.equal(q('.ng-live').hidden, true);
  assert.equal(q('.ng-toggle').textContent, 'Start');
  assert.equal(q('.ng-port').disabled, false);
});

test('a bad port is refused before ngrok; an ngrok failure is shown as an error', async () => {
  reset();
  await N.openNgrokPanel(project);
  for (const bad of ['', '0', '70000', '30.5']) {
    q('.ng-port').value = bad;
    submit();
    assert.match(lastToast().firstChild.textContent, /between 1 and 65535/, bad);
  }
  assert.ok(!env.ngrok.calls.some((c) => c[0] === 'start'));

  q('.ng-port').value = '3000';
  env.ngrok.start = new Error('ngrok stopped: authentication failed: Usage of ngrok requires a verified account and authtoken. (ERR_NGROK_4018)');
  submit();
  await tick();
  assert.ok(lastToast().classList.contains('error'));
  assert.match(lastToast().firstChild.textContent, /authentication failed.*ERR_NGROK_4018/);
  assert.equal(q('.ng-toggle').textContent, 'Start');
  assert.equal(q('.ng-toggle').disabled, false);
  assert.deepEqual(env.ngrok.calls.at(-1), ['start', '/p', 3000, 'http', null], 'an empty domain is sent as null');
});

test('a TCP tunnel has no Open button: its address is not a web page', async () => {
  reset();
  env.ngrok.status = { ...live, protocol: 'tcp', port: 5432, domain: null, public_url: 'tcp://0.tcp.eu.ngrok.io:12345' };
  await N.openNgrokPanel(project);
  assert.equal(q('.ng-public').textContent, 'tcp://0.tcp.eu.ngrok.io:12345');
  assert.equal(q('[data-act="open"]').hidden, true);
  assert.equal(q('.ng-port').value, '5432', 'the open tunnel fills the form');
  assert.equal(q('.ng-proto').value, 'tcp');
});

test('a tunnel that closed on its own says why, once', async () => {
  reset();
  project.tunnel = live;
  env.ngrok.status = { active: false, error: 'ngrok stopped unexpectedly (signal: 9 (SIGKILL)).' };
  await N.refreshTunnel(project);
  assert.ok(lastToast().classList.contains('error'));
  assert.equal(lastToast().firstChild.textContent, 'ngrok tunnel closed: ngrok stopped unexpectedly (signal: 9 (SIGKILL)).');
  const count = $('#toasts').children.length;
  env.ngrok.status = off;
  await N.refreshTunnel(project);
  assert.equal($('#toasts').children.length, count);
});

test('the chip copies the public URL; its toast opens the dialog', async () => {
  reset();
  project.tunnel = live;
  env.ngrok.status = live;
  N.copyTunnelUrl(project);
  assert.equal(env.copied.at(-1), 'https://mia-app.ngrok-free.app');
  const action = lastToast().children.find((c) => c.className === 'toast-action');
  assert.equal(action.textContent, 'Manage');
  action.onclick();
  await tick();
  assert.equal(sheets().length, 1);
  assert.equal(q('.ng-toggle').textContent, 'Stop');
});

test('Esc and the backdrop close the dialog', async () => {
  reset();
  await N.openNgrokPanel(project);
  env.key('Escape');
  assert.equal(sheets().length, 0);
  await N.openNgrokPanel(project);
  const s = sheet();
  s.onpointerdown({ target: s });
  assert.equal(sheets().length, 0);
});

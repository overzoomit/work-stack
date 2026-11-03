// Settings… dialog: opening from the menu/shortcut, form serialization, the
// IPC calls behind Save and Test connection, and the secret fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { $, El, env, tick } from './helpers/renderer-env.mjs';

const calls = [];
const saved = {
  plane_api_key: 'plane-secret',
  plane_base_url: 'https://plane.overzoom.it',
  plane_workspace: 'overzoom',
  jev_api_key: 'jev-secret',
  jev_endpoint: 'https://jev.example.it',
  custom_env: { OPENAI_API_KEY: 'sk-1', MODEL: 'gpt' },
};
const backend = {
  stored: { ...saved },
  test: null, // an Error rejects the Test connection
  saveFails: null,
  gate: null, // a promise that holds the next save
};
window.work.settings = {
  get: async () => { calls.push(['get']); return { ...backend.stored }; },
  save: async (settings) => {
    calls.push(['save', settings]);
    await backend.gate;
    if (backend.saveFails) throw backend.saveFails;
    backend.stored = settings;
    return settings;
  },
  testPlane: async (baseUrl, apiKey, workspace) => {
    calls.push(['testPlane', baseUrl, apiKey, workspace]);
    if (backend.test instanceof Error) throw backend.test;
    return backend.test ?? 'Connected';
  },
};
$('#modal').hidden = true; // as in index.html

const { openSettingsDialog, closeSettingsDialog, settingsFrom, fillSettings, parseEnv, formatEnv } =
  await import('../src/renderer/settings.js');
const { isSettingsKey } = await import('../src/renderer/keys.js');

const sheets = () => document.body.children.filter((c) => c.className === 'sheet settings-sheet' && !c.classList.contains('closing'));
const sheet = () => sheets().at(-1);
const field = (sel) => sheet().querySelector(sel);
const click = (act, data = {}) => {
  const target = new El();
  target.dataset = { act, ...data };
  sheet().onclick({ target });
};
const reset = async () => {
  calls.length = 0;
  backend.stored = { ...saved };
  backend.test = null;
  backend.saveFails = null;
  closeSettingsDialog();
  // The closing animation keeps the old sheet until its timer fires.
  await new Promise((r) => setTimeout(r, 5));
};

test('Ctrl+, and ⌘, open the settings dialog, without opening it twice', async () => {
  await reset();
  assert.equal(isSettingsKey({ key: ',', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }), true);
  assert.equal(isSettingsKey({ key: ',', ctrlKey: false, metaKey: true, shiftKey: false, altKey: false }), true, '⌘, on macOS');
  assert.equal(isSettingsKey({ key: ',', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }), false);
  assert.equal(isSettingsKey({ key: ',', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false }), false);

  await openSettingsDialog();
  await tick();
  assert.equal(sheets().length, 1);
  assert.match(sheet().innerHTML, /id="settings-title">Settings</);

  await openSettingsDialog();
  assert.equal(sheets().length, 1, 'a second open does not duplicate the dialog');
});

test('the form shows the saved values, with the key masked', async () => {
  await reset();
  await openSettingsDialog();
  await tick();
  assert.equal(field('.st-plane-url').value, saved.plane_base_url);
  assert.equal(field('.st-plane-ws').value, saved.plane_workspace);
  assert.equal(field('.st-plane-key').value, saved.plane_api_key);
  assert.equal(field('.st-plane-key').type, 'password', 'the key starts masked');
  assert.equal(field('.st-jev-key').value, saved.jev_api_key);
  assert.equal(field('.st-env').value, 'OPENAI_API_KEY=sk-1\nMODEL=gpt');
});

test('the eye button reveals and hides the keys', async () => {
  await reset();
  await openSettingsDialog();
  await tick();
  click('reveal', { target: 'plane' });
  assert.equal(field('.st-plane-key').type, 'text');
  click('reveal', { target: 'plane' });
  assert.equal(field('.st-plane-key').type, 'password');
  click('reveal', { target: 'jev' });
  assert.equal(field('.st-jev-key').type, 'text');
});

test('the tabs switch the visible section', async () => {
  await reset();
  await openSettingsDialog();
  await tick();
  assert.equal(field('.st-panel-plane').hidden, false);
  click('tab', { tab: 'jev' });
  assert.equal(field('.st-panel-plane').hidden, true);
  assert.equal(field('.st-panel-jev').hidden, false);
  assert.equal(field('.st-tab-jev').classList.contains('active'), true);
  click('tab', { tab: 'env' });
  assert.equal(field('.st-panel-env').hidden, false);
});

test('Save serializes every field and invokes settings_save, then reports the toast', async () => {
  await reset();
  await openSettingsDialog();
  await tick();
  field('.st-plane-url').value = 'https://plane.acme.it/';
  field('.st-plane-ws').value = 'acme';
  field('.st-plane-key').value = 'new-plane-key';
  field('.st-jev-key').value = 'new-jev-key';
  field('.st-jev-url').value = 'https://jev.acme.it';
  field('.st-env').value = '# comment\nOPENAI_API_KEY="sk-2"\nMODEL=gpt\nrotto\nPATH=a=b';

  click('save');
  await tick();
  const call = calls.find((c) => c[0] === 'save');
  assert.ok(call, 'settings_save is invoked');
  assert.deepEqual(call[1], {
    plane_api_key: 'new-plane-key',
    plane_base_url: 'https://plane.acme.it/',
    plane_workspace: 'acme',
    jev_api_key: 'new-jev-key',
    jev_endpoint: 'https://jev.acme.it',
    custom_env: { OPENAI_API_KEY: 'sk-2', MODEL: 'gpt', PATH: 'a=b' },
  });
  assert.equal($('#toasts').children.at(-1).firstChild.textContent, 'Settings saved');
});

test('a failed save keeps the dialog open and shows the error toast', async () => {
  await reset();
  backend.saveFails = new Error('cannot save settings: permission denied');
  await openSettingsDialog();
  await tick();
  click('save');
  await tick();
  assert.equal(sheets().length, 1, 'the dialog stays open');
  assert.match($('#toasts').children.at(-1).firstChild.textContent, /permission denied/);
});

test('Test connection sends the fields as typed and shows the answer', async () => {
  await reset();
  backend.test = 'Connected to https://plane.acme.it';
  await openSettingsDialog();
  await tick();
  field('.st-plane-url').value = 'https://plane.acme.it';
  field('.st-plane-ws').value = 'acme';
  field('.st-plane-key').value = 'k';
  click('test');
  await tick();
  assert.deepEqual(calls.find((c) => c[0] === 'testPlane'), ['testPlane', 'https://plane.acme.it', 'k', 'acme']);
  assert.equal(field('.st-result').textContent, 'Connected to https://plane.acme.it');
  assert.equal(field('.st-result').classList.contains('error'), false);
});

test('an empty server URL or workspace falls back to the defaults for Test', async () => {
  await reset();
  await openSettingsDialog();
  await tick();
  field('.st-plane-url').value = '';
  field('.st-plane-ws').value = '';
  field('.st-plane-key').value = 'k';
  click('test');
  await tick();
  assert.deepEqual(calls.find((c) => c[0] === 'testPlane'), ['testPlane', 'https://plane.overzoom.it', 'k', 'overzoom']);
});

test('a rejected key is shown inline as an error', async () => {
  await reset();
  backend.test = new Error('The API key was rejected');
  await openSettingsDialog();
  await tick();
  click('test');
  await tick();
  assert.equal(field('.st-result').textContent, 'The API key was rejected');
  assert.equal(field('.st-result').classList.contains('error'), true);
});

test('Cancel and Esc close the dialog without saving', async () => {
  await reset();
  await openSettingsDialog();
  await tick();
  click('cancel');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(sheets().length, 0);
  assert.equal(calls.some((c) => c[0] === 'save'), false);

  await openSettingsDialog();
  await tick();
  env.key('Escape');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(sheets().length, 0);
});

test('environment parsing keeps valid KEY=value lines and quotes out of the value', () => {
  assert.deepEqual(parseEnv('A=1\n# B=2\n\nC = "x y"\n9BAD=3\nD=a=b'), { A: '1', C: 'x y', D: 'a=b' });
  assert.deepEqual(parseEnv(''), {});
  assert.equal(formatEnv({ B: '2', A: '1' }), 'B=2\nA=1');
});

test('settingsFrom reads the form without touching the backend', async () => {
  await reset();
  await openSettingsDialog();
  await tick();
  fillSettings(sheet(), { plane_base_url: 'u', plane_workspace: 'w', custom_env: { K: 'v' } });
  assert.deepEqual(settingsFrom(sheet()), {
    plane_api_key: '',
    plane_base_url: 'u',
    plane_workspace: 'w',
    jev_api_key: '',
    jev_endpoint: '',
    custom_env: { K: 'v' },
  });
  assert.deepEqual(calls.filter((c) => c[0] !== 'get'), []);
});

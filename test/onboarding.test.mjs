// First-run Onboarding Wizard: auto-detection on clean installs,
// credential entry, backup import and save actions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { $, El, env, tick } from './helpers/renderer-env.mjs';

const calls = [];
let isConfiguredState = false;

window.work.settings = {
  isConfigured: async () => isConfiguredState,
  testPlane: async (baseUrl, apiKey, workspace) => {
    calls.push(['testPlane', baseUrl, apiKey, workspace]);
    return 'Connected!';
  },
  save: async (settings) => {
    calls.push(['save', settings]);
    return settings;
  },
  importConfig: async (json) => {
    calls.push(['importConfig', json]);
    return JSON.parse(json);
  },
};
window.work.telegram = {
  connect: async (token) => {
    calls.push(['telegram.connect', token]);
  },
};

const { openOnboardingWizard, closeOnboarding, checkOnboarding } =
  await import('../src/renderer/onboarding.js');

const wizards = () => document.body.children.filter((c) => c.className === 'sheet settings-sheet' && !c.classList.contains('closing'));
const wizard = () => wizards().at(-1);

const trigger = (el, type) => {
  for (const fn of el?.listeners?.[type] || []) {
    fn({ target: el, preventDefault() {}, stopPropagation() {} });
  }
};

const reset = async () => {
  calls.length = 0;
  closeOnboarding();
  await new Promise((r) => setTimeout(r, 5));
};

test('checkOnboarding does nothing if the system is already configured', async () => {
  await reset();
  isConfiguredState = true;
  await checkOnboarding();
  await tick();
  assert.equal(wizards().length, 0);
});

test('checkOnboarding opens wizard if the system is not configured', async () => {
  await reset();
  isConfiguredState = false;
  await checkOnboarding();
  await tick();
  assert.equal(wizards().length, 1);
  assert.match(wizard().innerHTML, /Welcome to Work Stack/);
});

test('onboarding wizard test connection validates plane key', async () => {
  await reset();
  openOnboardingWizard();
  await tick();

  const w = wizard();
  const testBtn = w.querySelector('.ob-test');
  const keyInput = w.querySelector('.ob-plane-key');
  const result = w.querySelector('.ob-result');

  // Empty key
  keyInput.value = '';
  trigger(testBtn, 'click');
  await tick();
  assert.match(result.textContent, /Enter a Plane API key/);

  // Valid key
  keyInput.value = 'plane_api_123';
  trigger(testBtn, 'click');
  await tick();
  assert.equal(result.textContent, 'Connected!');
  assert.ok(calls.some((c) => c[0] === 'testPlane'));
});

test('onboarding wizard save calls settings.save and connects telegram if token provided', async () => {
  await reset();
  let doneCalled = false;
  openOnboardingWizard({ onDone: () => { doneCalled = true; } });
  await tick();

  const w = wizard();
  w.querySelector('.ob-plane-key').value = 'plane_api_abc';
  w.querySelector('.ob-jev-key').value = 'jev_secret';
  w.querySelector('.ob-tg-token').value = 'bot123:token';

  trigger(w.querySelector('.ob-save'), 'click');
  await tick();

  assert.ok(calls.some((c) => c[0] === 'save'));
  assert.ok(calls.some((c) => c[0] === 'telegram.connect'));
  assert.equal(doneCalled, true);
});

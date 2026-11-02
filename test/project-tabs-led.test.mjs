// Unit tests for the project tab diode (LED):
// Pulsing green when a tmux terminal or agent is working, orange when idle.
import './helpers/renderer-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isProjectWorking, projectLedHtml, recordProjectActivity } from '../src/renderer/ptabled.js';

test('isProjectWorking: returns false when no terminal, run config or agent is working', () => {
  const p = { path: '/tmp/test-proj-idle', name: 'test-idle', runs: new Map() };
  assert.equal(isProjectWorking(p), false, 'idle project must not be working');
  assert.equal(isProjectWorking(null), false, 'null project is not working');
  const html = projectLedHtml(p);
  assert.match(html, /class="ptab-led idle"/, 'idle project must produce an idle diode');
});

test('recordProjectActivity: switches project to working and returns to idle after quiet delay', async () => {
  const p = { path: '/tmp/test-proj-active', name: 'test-active', runs: new Map() };
  assert.equal(isProjectWorking(p), false);

  let quietCalled = false;
  recordProjectActivity(p.path, () => {
    quietCalled = true;
  });

  assert.equal(isProjectWorking(p), true, 'active project must be working immediately');
  const html = projectLedHtml(p);
  assert.match(html, /class="ptab-led working"/, 'working project must produce a working diode');
});

test('style.css defines .ptab-led with pulsing green for working and orange for idle', () => {
  const css = readFileSync(resolve('src/renderer/style.css'), 'utf-8');
  assert.match(css, /\.ptab-led\s*\{/, 'must define .ptab-led');
  assert.match(css, /\.ptab-led\.idle\s*\{[^}]*var\(--orange\)/, 'must style .ptab-led.idle with orange');
  assert.match(css, /\.ptab-led\.working\s*\{[^}]*var\(--green\)/, 'must style .ptab-led.working with green');
  assert.match(css, /@keyframes\s+ptab-led-pulse/, 'must define ptab-led-pulse animation');
  assert.match(css, /ptab-led-pulse\s+1\.\d+s\s+ease-in-out\s+infinite/, 'must apply pulsing animation to working diode');
});

// Project tabs stay inside the window: elastic tabs, wheel scrolling, active tab in view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { keepActiveTabVisible, revealActiveTab, wheelScroll } from '../src/renderer/tabstrip.js';

const css = readFileSync(resolve('src/renderer/style.css'), 'utf-8');
const rule = (selector) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/\./g, '\\.')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';

test('body cannot grow past the viewport', () => {
  assert.match(rule('html, body'), /max-width:\s*100vw/);
  assert.match(rule('body'), /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(rule('body'), /overflow:\s*hidden/);
});

test('topbar and tab strip may shrink below their content', () => {
  assert.match(rule('.topbar'), /min-width:\s*0/);
  assert.match(rule('.topbar'), /max-width:\s*100%/);
  assert.match(rule('.project-tabs'), /min-width:\s*0/);
  assert.match(rule('.project-tabs'), /overflow-x:\s*auto/);
});

test('tabs are elastic and truncate the name with an ellipsis', () => {
  const ptab = rule('.ptab');
  assert.match(ptab, /flex:\s*1 1 180px/);
  assert.match(ptab, /min-width:\s*60px/);
  assert.match(ptab, /max-width:\s*220px/);
  assert.match(ptab, /overflow:\s*hidden/);
  assert.match(rule('.ptab-name'), /min-width:\s*0/);
  assert.match(rule('.ptab-name'), /text-overflow:\s*ellipsis/);
});

test('vertical wheel scrolls the strip horizontally and is consumed', () => {
  const strip = { scrollLeft: 10 };
  let prevented = false;
  wheelScroll(strip, { deltaX: 0, deltaY: 40, preventDefault: () => (prevented = true) });
  assert.equal(strip.scrollLeft, 50);
  assert.equal(prevented, true);
});

test('horizontal gestures are left to the browser', () => {
  const strip = { scrollLeft: 10 };
  let prevented = false;
  wheelScroll(strip, { deltaX: 30, deltaY: 5, preventDefault: () => (prevented = true) });
  assert.equal(strip.scrollLeft, 10);
  assert.equal(prevented, false);
});

test('the active tab is scrolled into view, nothing happens without one', () => {
  let args;
  const strip = { querySelector: (sel) => (sel === '.ptab.active' ? { scrollIntoView: (a) => (args = a) } : null) };
  revealActiveTab(strip);
  assert.deepEqual(args, { inline: 'nearest', block: 'nearest' });
  assert.doesNotThrow(() => revealActiveTab({ querySelector: () => null }));
});

test('the active tab is revealed again whenever the strip is resized', () => {
  const original = globalThis.ResizeObserver;
  let notify;
  let observed;
  globalThis.ResizeObserver = class {
    constructor(callback) { notify = callback; }
    observe(target) { observed = target; }
  };
  try {
    let reveals = 0;
    const strip = { querySelector: () => ({ scrollIntoView: () => reveals++ }) };
    keepActiveTabVisible(strip);
    assert.equal(observed, strip);
    notify();
    notify();
    assert.equal(reveals, 2);
  } finally {
    globalThis.ResizeObserver = original;
  }
});

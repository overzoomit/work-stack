// The window only shows Work's own page: a dropped file or a stray link must
// not replace the UI; new windows are refused, web links go to the browser.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lockNavigation } = require('../src/main/guards');

function fakeContents(url) {
  const handlers = {};
  return {
    getURL: () => url,
    on: (ev, fn) => { handlers[ev] = fn; },
    setWindowOpenHandler: (fn) => { handlers.open = fn; },
    handlers,
  };
}

test('un file trascinato sulla finestra o un link non sostituiscono l\'interfaccia di Work (regressione)', () => {
  const opened = [];
  const c = fakeContents('file:///app/src/renderer/index.html');
  lockNavigation(c, (u) => opened.push(u));
  const navigate = (url) => {
    let prevented = false;
    c.handlers['will-navigate']({ preventDefault: () => { prevented = true; } }, url);
    return prevented;
  };
  assert.equal(navigate('file:///home/u/foto.png'), true, 'a dropped file');
  assert.equal(navigate('https://example.com/'), true);
  assert.equal(navigate('file:///app/src/renderer/index.html'), false, 'reloading Work itself is fine');

  assert.deepEqual(c.handlers.open({ url: 'https://example.com/doc' }), { action: 'deny' });
  assert.deepEqual(opened, ['https://example.com/doc'], 'web links open in the browser');
  assert.deepEqual(c.handlers.open({ url: 'file:///etc/passwd' }), { action: 'deny' });
  assert.equal(opened.length, 1, 'anything else is just refused');
});

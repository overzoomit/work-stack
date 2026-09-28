// The saved state (open projects) survives bad files and interrupted writes.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

let dir;
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return { app: { getPath: () => dir } };
  return load.call(this, request, ...rest);
};
const store = require('../src/main/store');
const file = () => path.join(dir, 'state.json');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-store-'));
});

test('salva e rilegge lo stato', () => {
  store.save({ projects: [{ path: '/a' }], active: '/a' });
  assert.deepEqual(store.load(), { projects: [{ path: '/a' }], active: '/a' });
});

test('senza file o con un file rovinato parte da uno stato vuoto', () => {
  assert.deepEqual(store.load(), { projects: [], active: null });
  fs.writeFileSync(file(), '{ rotto');
  assert.deepEqual(store.load(), { projects: [], active: null });
});

test('una scrittura interrotta a metà non cancella lo stato salvato prima (regressione)', () => {
  store.save({ projects: [{ path: '/a' }, { path: '/b' }], active: '/a' });
  const write = fs.writeFileSync;
  fs.writeFileSync = (target, data, ...rest) => {
    write(target, String(data).slice(0, 10), ...rest); // disk full / crash halfway
    throw new Error('ENOSPC');
  };
  try {
    assert.throws(() => store.save({ projects: [{ path: '/c' }], active: '/c' }), /ENOSPC/);
  } finally {
    fs.writeFileSync = write;
  }
  assert.deepEqual(store.load().projects.map((p) => p.path), ['/a', '/b']);
});

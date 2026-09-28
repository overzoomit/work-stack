const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { detect } = require('../src/main/runconfigs');

function folder(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-run-'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

test('gli script npm più usati vengono prima, poi gli altri in ordine alfabetico', async () => {
  const dir = folder({ 'package.json': JSON.stringify({ scripts: { lint: 'x', zeta: 'x', build: 'x', dev: 'x', alpha: 'x' } }) });
  assert.deepEqual((await detect(dir)).map((c) => c.name), ['dev', 'build', 'lint', 'alpha', 'zeta']);
});

test('usa il gestore di pacchetti indicato dal lockfile', async () => {
  const dir = folder({ 'package.json': JSON.stringify({ scripts: { dev: 'x' } }), 'pnpm-lock.yaml': '' });
  assert.deepEqual((await detect(dir)).map((c) => c.command), ['pnpm run dev']);
});

test('rileva i target del Makefile ignorando le assegnazioni di variabili', async () => {
  const dir = folder({ Makefile: 'CC := gcc\nbuild:\n\tgo build\ntest: build\n\tgo test\n.PHONY: build\n' });
  assert.deepEqual((await detect(dir)).map((c) => c.command), ['make build', 'make test']);
});

test('una cartella senza progetti riconoscibili non ha configurazioni', async () => {
  assert.deepEqual(await detect(folder({ 'README.md': '# x' })), []);
});

test('un package.json non valido non impedisce di rilevare il resto', async () => {
  const dir = folder({ 'package.json': '{ non json', 'Cargo.toml': '[package]' });
  assert.deepEqual((await detect(dir)).map((c) => c.command), ['cargo run', 'cargo test', 'cargo build']);
});

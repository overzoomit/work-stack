const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { detect } = require('../src/main/runconfigs');
const { tempDir } = require('./helpers/tmp');

function folder(files) {
  const dir = tempDir('work-run-');
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

test('un nome di script con spazi o caratteri della shell arriva intatto come un solo argomento (regressione)', async () => {
  const names = ['e2e test', "it's", 'a;touch PWNED', '$(id)', 'build:prod'];
  const dir = folder({ 'package.json': JSON.stringify({ scripts: Object.fromEntries(names.map((n) => [n, 'x'])) }) });
  const { execFileSync } = require('child_process');
  for (const c of await detect(dir)) {
    // Replace the package manager with printf: the shell must hand over the name unchanged, as one word.
    const args = execFileSync('sh', ['-c', c.command.replace(/^npm run /, "printf '%s\\n' ")], { cwd: dir }).toString();
    assert.equal(args, `${c.name}\n`, c.command);
  }
  assert.ok(!fs.existsSync(path.join(dir, 'PWNED')));
  assert.equal((await detect(dir)).find((c) => c.name === 'build:prod').command, 'npm run build:prod', 'plain names stay unquoted');
});

test('le assegnazioni POSIX ::= e :::= non diventano target, le regole con doppio due punti sì (regressione)', async () => {
  const dir = folder({ Makefile: 'CC ::= gcc\nFLAGS :::= -O2\nclean::\n\trm -f *.o\nbuild: deps\n\tcc main.c\n' });
  assert.deepEqual((await detect(dir)).map((c) => c.name), ['clean', 'build']);
});

test('rileva Cargo, Django, Go e un solo Docker Compose anche con più file compose', async () => {
  const dir = folder({ 'Cargo.toml': '', 'manage.py': '', 'go.mod': 'module x\n', 'compose.yaml': '', 'docker-compose.yml': '' });
  assert.deepEqual((await detect(dir)).map((c) => [c.id, c.command]), [
    ['cargo:run', 'cargo run'], ['cargo:test', 'cargo test'], ['cargo:build', 'cargo build'],
    // python3, not python: Ubuntu 20.04 and recent macOS have no bare "python" (regressione).
    ['django:runserver', 'python3 manage.py runserver'],
    ['go:run', 'go run .'], ['go:test', 'go test ./...'],
    ['docker:compose up', 'docker compose up'],
  ]);
});

test('usa il gestore dichiarato in packageManager anche senza lockfile (regressione)', async () => {
  const dir = folder({ 'package.json': JSON.stringify({ packageManager: 'pnpm@9.1.0', scripts: { dev: 'x' } }) });
  assert.deepEqual((await detect(dir)).map((c) => c.command), ['pnpm run dev']);
  const yarn = folder({ 'package.json': JSON.stringify({ packageManager: 'yarn@4.0.2+sha256.abc', scripts: { dev: 'x' } }) });
  assert.deepEqual((await detect(yarn)).map((c) => c.command), ['yarn run dev']);
  const weird = folder({ 'package.json': JSON.stringify({ packageManager: 'rm -rf /@1', scripts: { dev: 'x' } }) });
  assert.deepEqual((await detect(weird)).map((c) => c.command), ['npm run dev'], 'only known managers are trusted');
});

test('Make: legge anche "makefile" e "GNUmakefile" e tutti i target di una riga (regressione)', async () => {
  const lower = folder({ makefile: 'build test: deps\n\tgo build\ndeps:\n\ttrue\n' });
  assert.deepEqual((await detect(lower)).map((c) => c.command), ['make build', 'make test', 'make deps']);
  const gnu = folder({ GNUmakefile: 'all:\n\ttrue\n', Makefile: 'ignored:\n' });
  assert.deepEqual((await detect(gnu)).map((c) => c.command), ['make all'], 'GNUmakefile wins, as in make itself');
});

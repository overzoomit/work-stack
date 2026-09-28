import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findLocalUrl } from '../src/renderer/runurl.js';

test('trova l\'indirizzo stampato dai dev server più comuni', () => {
  assert.equal(findLocalUrl('  ➜  Local:   http://localhost:5173/\n'), 'http://localhost:5173');
  assert.equal(findLocalUrl('- Local:        http://127.0.0.1:3000\n'), 'http://127.0.0.1:3000');
  assert.equal(findLocalUrl('App at http://localhost:8080/app/ ok\n'), 'http://localhost:8080/app');
  assert.equal(findLocalUrl('nessun server qui\n'), null);
});

test('ignora i colori ANSI dentro l\'indirizzo', () => {
  assert.equal(findLocalUrl('Local: \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\n'), 'http://localhost:5173');
});

test('la punteggiatura dopo l\'indirizzo non ne fa parte (regressione)', () => {
  assert.equal(findLocalUrl('Server running at http://localhost:3000.\n'), 'http://localhost:3000');
  assert.equal(findLocalUrl('Listening on http://localhost:4000, press Ctrl+C\n'), 'http://localhost:4000');
});

test('gli indirizzi jolly si aprono come localhost, anche IPv6 (regressione)', () => {
  assert.equal(findLocalUrl('http://0.0.0.0:8000/\n'), 'http://localhost:8000');
  assert.equal(findLocalUrl('Server on http://[::]:9000\n'), 'http://localhost:9000');
  assert.equal(findLocalUrl('http://[::1]:9000\n'), 'http://[::1]:9000', 'IPv6 loopback is browsable as is');
});

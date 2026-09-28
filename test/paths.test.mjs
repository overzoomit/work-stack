import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tildify } from '../src/renderer/paths.js';

test('abbrevia la home in ~ solo quando è la cartella iniziale intera (regressione)', () => {
  assert.equal(tildify('/home/ann/progetto', '/home/ann'), '~/progetto');
  assert.equal(tildify('/home/ann', '/home/ann'), '~');
  assert.equal(tildify('/home/anna/progetto', '/home/ann'), '/home/anna/progetto', 'another user whose name starts the same');
  assert.equal(tildify('/data/home/ann/x', '/home/ann'), '/data/home/ann/x', 'home in the middle of a path');
});

test('percorsi o home mancanti non producono errori', () => {
  assert.equal(tildify('', '/home/ann'), '');
  assert.equal(tildify(null, '/home/ann'), '');
  assert.equal(tildify('/tmp/x', ''), '/tmp/x');
});

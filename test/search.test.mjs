// Search palette: fuzzy match and ranking of the project's files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers/renderer-env.mjs';

const { fuzzy, rank, highlight } = await import('../src/renderer/search.js');

test('envlo mette .env.local prima di environment.loader.ts', () => {
  const files = [{ path: 'src/environment.loader.ts' }, { path: 'docs/envelope-lo.md' }, { path: '.env.local' }];
  assert.equal(rank('envlo', files)[0].path, '.env.local');
  assert.equal(rank('envlo', files).length, 3);
});

test('le lettere fuori ordine non trovano niente', () => {
  assert.equal(fuzzy('olvne', '.env.local'), null);
  assert.equal(fuzzy('xyz', 'src/app.js'), null);
  assert.deepEqual(rank('zz', [{ path: 'a.js' }]), []);
});

test('le posizioni sono quelle delle lettere trovate, prima nel nome del file', () => {
  assert.deepEqual(fuzzy('app', 'src/app/app.js').positions, [8, 9, 10], 'in the name, not in the folder');
  assert.deepEqual(fuzzy('sa', 'src/app.js').positions, [0, 4], 'across the path when the name alone has no match');
  assert.equal(highlight('app.js', [4, 5], 4), '<b>a</b><b>p</b>p.js');
  assert.equal(highlight('<a>', [1]), '&lt;<b>a</b>&gt;');
});

test('un segmento iniziale e lettere consecutive valgono più di lettere sparse', () => {
  assert.ok(fuzzy('main', 'src/main.rs').score > fuzzy('main', 'src/my_animation.rs').score);
  assert.ok(fuzzy('rs', 'a/b/c/d/e/f/g/x.rs').score < fuzzy('rs', 'x.rs').score, 'a long path costs a little');
});

test('si mostrano al massimo 200 risultati', () => {
  const files = Array.from({ length: 500 }, (_, i) => ({ path: `src/file${i}.js` }));
  assert.equal(rank('file', files).length, 200);
});

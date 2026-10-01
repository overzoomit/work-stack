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

test('nel modo Testo conta solo la risposta all\'ultima ricerca', async () => {
  const { openSearch, closeSearch } = await import('../src/renderer/search.js');
  const pending = {};
  window.work.fs = {
    files: async () => ({ files: [], truncated: false }),
    grep: (root, query) => new Promise((resolve) => { pending[query] = resolve; }),
  };
  const answer = (path, text) => ({ groups: [{ path, ignored: false, hits: [{ line: 3, col: 1, text }] }], truncated: false });
  openSearch({ path: '/p', name: 'p' }, { mode: 'text' });
  const list = document.body.children.find((c) => c.className === 'search');
  const input = list.querySelector('.search-input');
  const results = list.querySelector('.search-list');
  const foot = list.querySelector('.search-foot');

  input.value = 'DATA';
  input.oninput();
  await new Promise((r) => setTimeout(r, 150));
  input.value = 'DATABASE';
  input.oninput();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(foot.textContent, 'Cerco…');

  pending.DATABASE(answer('db.js', 'DATABASE_URL'));
  await new Promise((r) => setTimeout(r, 0));
  pending.DATA(answer('vecchio.js', 'DATA'));
  await new Promise((r) => setTimeout(r, 0));
  assert.match(results.innerHTML, /db\.js/);
  assert.doesNotMatch(results.innerHTML, /vecchio\.js/, 'the late answer to "DATA" is dropped');
  assert.match(results.innerHTML, /<b>DATABASE<\/b>_URL/);
  assert.equal(foot.textContent, '1 risultato in 1 file');
  closeSearch();
});

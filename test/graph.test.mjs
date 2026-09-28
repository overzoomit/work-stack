import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layout, refBadges, renderSvg } from '../src/renderer/graph.js';

const commit = (hash, parents = [], refs = []) => ({ hash, parents, refs, subject: hash, author: 'a', time: 0 });

test('una storia lineare resta tutta sulla prima corsia', () => {
  const g = layout([commit('c', ['b']), commit('b', ['a']), commit('a')]);
  assert.deepEqual(g.rows.map((r) => r.col), [0, 0, 0]);
});

test('un merge apre una seconda corsia per il secondo parent', () => {
  const g = layout([commit('m', ['c', 'f']), commit('c', ['a']), commit('f', ['a']), commit('a')]);
  assert.deepEqual(g.rows[0].after, ['c', 'f']);
  assert.equal(g.rows.find((r) => r.commit.hash === 'f').col, 1);
});

test('le corsie che arrivano allo stesso commit convergono e si liberano', () => {
  const g = layout([commit('m', ['c', 'f']), commit('c', ['a']), commit('f', ['a']), commit('a')]);
  const root = g.rows.find((r) => r.commit.hash === 'a');
  assert.equal(root.col, 0);
  assert.deepEqual(root.after, []);
});

test("il rientro del testo dipende dalle corsie di quella riga, non dall'intero grafo", () => {
  const g = layout([commit('m', ['c', 'f']), commit('c', ['a']), commit('f', ['a']), commit('a'), commit('z')]);
  const lastRow = g.rows.at(-1);
  assert.ok(lastRow.indent < g.width, 'a single-lane row is indented less than the widest one');
});

test('i riferimenti vengono classificati da nomi completi: HEAD, locali, remoti, tag', () => {
  const badges = refBadges([
    'HEAD -> refs/heads/main', 'refs/remotes/origin/main', 'tag: refs/tags/v1.0', 'refs/remotes/origin/HEAD',
  ]);
  assert.deepEqual(badges, [
    { cls: 'head', label: 'main' },
    { cls: 'remote', label: 'origin/main' },
    { cls: 'tag', label: 'v1.0' },
  ]);
});

test('un ramo locale con lo slash nel nome resta locale (regressione)', () => {
  assert.deepEqual(refBadges(['refs/heads/feature/x']), [{ cls: 'local', label: 'feature/x' }]);
});

test('HEAD staccato viene mostrato come HEAD', () => {
  assert.deepEqual(refBadges(['HEAD']), [{ cls: 'head', label: 'HEAD' }]);
});

test('una storia lineare disegna la corsia come un unico tratto verticale', () => {
  const commits = ['a', 'b', 'c', 'd'].map((h, i, all) => ({ hash: h, parents: all[i + 1] ? [all[i + 1]] : [], refs: [] }));
  const svg = renderSvg(layout(commits));
  assert.equal((svg.match(/<path/g) || []).length, 1);
  assert.match(svg, /<path d="M12 13V91" stroke="#0a84ff"\/>/); // from the first node down to the last
  assert.equal((svg.match(/<circle/g) || []).length, 4);
});

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

test('un merge disegna la seconda corsia che si stacca e rientra con curve, e nodi distinti per merge e HEAD', () => {
  // m merges b into the line m → x; b branches off x.
  const commits = [
    commit('m', ['x', 'b'], ['HEAD -> refs/heads/main']),
    commit('b', ['x']),
    commit('x', []),
  ];
  const svg = renderSvg(layout(commits));
  const curves = svg.match(/<path d="M[\d. ]+C[^"]+"/g) || [];
  assert.equal(curves.length, 2, 'out of the merge into lane 1, and back into lane 0 at x');
  assert.match(svg, /<circle cx="12" cy="13" r="5.5" fill="#0c0d10" stroke="#0a84ff" stroke-width="2.5"\/>/, 'HEAD: ring');
  assert.match(svg, /<circle cx="26" cy="39" r="4" fill="#30d158"\/>/, 'b sits on the second lane');
  assert.doesNotMatch(svg, /cy="13" r="3"/, 'HEAD styling wins over the merge dot');
});

test('un commit di merge senza HEAD usa un nodo più piccolo', () => {
  const svg = renderSvg(layout([commit('m', ['x', 'b']), commit('b', ['x']), commit('x', [])]));
  assert.match(svg, /<circle cx="12" cy="13" r="3" fill="#0a84ff"\/>/);
});

test('due corsie che aspettano lo stesso commit scendono dritte fino a lì, senza curve spurie (regressione)', () => {
  // m merges b; b → y → x; z (another line) is drawn between y and x.
  const svg = renderSvg(layout([
    commit('m', ['x', 'b']), commit('b', ['y']), commit('y', ['x']), commit('z', ['w']), commit('x', []), commit('w', []),
  ]));
  const curves = svg.match(/<path d="M[\d. ]+C[^"]+"/g) || [];
  assert.equal(curves.length, 2, 'only out of the merge and back in at x');
  assert.match(svg, /<path d="M26 26V104" stroke="#30d158"\/>/, 'lane 1 runs straight down to the row before x');
});

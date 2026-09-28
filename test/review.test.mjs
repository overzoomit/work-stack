// Review sheet (commit details and working-copy changes) with a minimal fake
// DOM: the tests read back the HTML each part of the sheet shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';

class El {
  constructor() {
    this.innerHTML = ''; this.textContent = ''; this.hidden = true; this.dataset = {}; this.title = '';
    this.blocks = []; this.set = new Set();
    this.classList = { add: (c) => this.set.add(c), remove: (c) => this.set.delete(c), toggle: () => {}, contains: (c) => this.set.has(c) };
  }
  append(el) { el.box = this; this.blocks.push(el); }
  after(next) { this.box.blocks.push(next); next.box = this.box; }
  appendChild(el) { this.blocks.push(el); }
  addEventListener() {}
  querySelectorAll() { return []; }
  scrollIntoView() {}
  html() { return this.innerHTML + this.blocks.map((b) => b.innerHTML).join(''); }
}
const nodes = new Map();
const $ = (s) => { if (!nodes.has(s)) nodes.set(s, new El()); return nodes.get(s); };
globalThis.document = { querySelector: $, querySelectorAll: () => [], createElement: () => new El() };
globalThis.addEventListener = () => {};
globalThis.getComputedStyle = () => ({ animationName: 'none' });

const diffs = [];
let commitReply = null;
globalThis.window = {
  work: {
    git: {
      commit: () => commitReply,
      containing: async () => [{ name: 'feature/x', remote: false }, { name: 'origin/main', remote: true }],
      fileDiff: async (repo, spec) => { diffs.push(spec); return 'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-uno\n+due\n'; },
    },
    app: { copy() {} },
  },
};

const { openCommit, openWorking, closeReview } = await import('../src/renderer/review.js');
const tick = () => new Promise((r) => setTimeout(r, 10));

const COMMIT = {
  hash: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  parents: ['ffff0000aaaa1111bbbb2222cccc3333dddd4444'],
  author: 'Anna <x>', email: 'anna@example.com', time: 0, committer: 'Anna <x>', ctime: 0,
  refs: ['HEAD -> refs/heads/main', 'tag: refs/tags/v1'],
  message: 'Titolo del commit\n\nCorpo con <tag>',
  files: [
    { code: 'M', file: 'src/app/main.js', add: 3, del: 1 },
    { code: 'R', file: 'docs/nuovo.md', oldFile: 'docs/vecchio.md', add: 0, del: 0 },
    { code: 'A', file: 'img.png', add: null, del: null },
  ],
};

test('dettaglio commit: intestazione, metadati escapati, albero dei file compattato e primo file aperto', async () => {
  diffs.length = 0;
  commitReply = Promise.resolve(COMMIT);
  await openCommit('/repo', COMMIT.hash);
  await tick();

  assert.equal($('#review-title').textContent, 'Titolo del commit');
  const info = $('#review-info').innerHTML;
  assert.match(info, /Corpo con &lt;tag&gt;/, 'the body is escaped');
  assert.match(info, /Anna &lt;x&gt; <span class="muted">&lt;anna@example.com&gt;<\/span>/);
  assert.match(info, /data-copy="ffff0000aaaa1111bbbb2222cccc3333dddd4444"[^>]*>ffff0000</, 'parent as a short, copyable hash');
  assert.match(info, /<span class="ref head">main<\/span><span class="ref tag">v1<\/span>/);

  const files = $('#review-files').innerHTML;
  assert.match(files, /3 file modificati\s*<span class="plus">\+3<\/span><span class="minus">−1<\/span>/);
  assert.match(files, /<\/span>src\/app<\/div>/, 'a folder with a single child folder is shown as one row');
  assert.match(files, /title="docs\/vecchio\.md → docs\/nuovo\.md"/, 'renames show where the file came from');
  assert.match(files, /data-file="img\.png"[\s\S]*?<span class="bin">bin<\/span>/, 'binary files have no line counts');
  assert.ok(files.indexOf('docs') < files.indexOf('src/app') && files.indexOf('src/app') < files.indexOf('img.png'), 'folders sorted, then files');

  // The first changed file opens in the diff, against the first parent.
  assert.deepEqual(diffs, [{ hash: COMMIT.hash, file: 'src/app/main.js', oldFile: undefined }]);
  assert.match($('#review-labels').innerHTML, /<span>ffff0000 \(parent\)<\/span><span>a1b2c3d4<\/span>/);
  assert.match($('#review-diff').html(), /d-row mod[\s\S]*<span class="code l">uno<\/span>[\s\S]*<span class="code r">due<\/span>/, 'old and new line side by side');
  assert.match($('#review-count').textContent, /1 modifica/);

  // Branches containing the commit, local and remote told apart.
  assert.match($('#ci-contains').innerHTML, /<span class="ref local">feature\/x<\/span> <span class="ref remote">origin\/main<\/span>/);
  closeReview();
});

test('commit iniziale: nessun parent e confronto con il vuoto', async () => {
  diffs.length = 0;
  commitReply = Promise.resolve({ ...COMMIT, parents: [], files: [{ code: 'A', file: 'a.txt', add: 1, del: 0 }] });
  await openCommit('/repo', COMMIT.hash);
  await tick();
  assert.match($('#review-info').innerHTML, /nessuno \(commit iniziale\)/);
  assert.match($('#review-labels').innerHTML, /<span>vuoto<\/span>/);
  assert.match($('#review-files').innerHTML, /1 file modificato/);
  closeReview();
});

test('una risposta arrivata dopo un altro commit aperto viene ignorata', async () => {
  let resolveSlow;
  commitReply = new Promise((r) => { resolveSlow = r; });
  const slow = openCommit('/repo', 'lento');
  commitReply = Promise.resolve({ ...COMMIT, message: 'Il più recente' });
  await openCommit('/repo', COMMIT.hash);
  resolveSlow({ ...COMMIT, message: 'Quello vecchio' });
  await slow;
  await tick();
  assert.equal($('#review-title').textContent, 'Il più recente');
  closeReview();
});

test('modifiche locali: gruppi In stage e Modifiche, file non tracciato confrontato con il vuoto', async () => {
  diffs.length = 0;
  const status = {
    branch: { name: 'main' },
    staged: [{ file: 'a.js', code: 'M' }],
    unstaged: [{ file: 'b/nuovo.txt', code: 'U' }],
  };
  await openWorking('/repo', status, null, { onToggleStage() {} });
  await tick();
  const files = $('#review-files').innerHTML;
  assert.match(files, /In stage <span class="count">1<\/span>[\s\S]*Modifiche <span class="count">1<\/span>/);
  assert.match($('#review-info').innerHTML, /Branch main · 1 in stage · 1 non in stage/);
  // Default selection: the first unstaged file; untracked, so the left side is empty.
  assert.deepEqual(diffs, [{ file: 'b/nuovo.txt', oldFile: undefined, staged: false, untracked: true }]);
  assert.match($('#review-labels').innerHTML, /<span>vuoto<\/span><span>Copia di lavoro<\/span>/);
  assert.match($('#review-tools-extra').innerHTML, /Metti in stage/);
  closeReview();
});

// Git panel wiring, on the shared fake renderer environment with a
// scriptable `window.work.git` bridge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMenuItems, tick } from './helpers/renderer-env.mjs';

const calls = [];
const statusCalls = [];
let logCalls = 0;
let statusGate = null;
let actionGate = null;
let branchesReply = [{ name: 'main', current: true, remote: false }, { name: 'dev', current: false, remote: false }];
let statusReply = { branch: { name: 'main', ahead: 0, behind: 0 }, staged: [], unstaged: [], ignored: [] };
let failCheckout = false;
Object.assign(globalThis.window.work, {
    git: {
      action: async (repo, name, params) => {
        calls.push([name, params]);
        await actionGate;
        if (name === 'checkout' && failCheckout) throw new Error('local changes would be overwritten');
      },
      status: async (repo, opts) => {
        statusCalls.push(opts);
        await statusGate;
        return structuredClone(statusReply);
      },
      branches: async () => branchesReply,
      log: async () => {
        logCalls++;
        return [{ hash: 'c1', parents: [], refs: ['HEAD -> refs/heads/main'], author: 'Anna Rossi', time: Date.now(), subject: 'primo <commit>' }];
      },
      root: async (p) => p,
      watch() {},
      commit: async (repo, hash) => ({
        hash, parents: [], author: 'Anna', email: 'a@x', time: 0, committer: 'Anna', ctime: 0,
        refs: [], message: 'primo', files: [],
      }),
      containing: async () => [],
      fileDiff: async () => '',
    },
});

const { initGit, showGit, refreshGit, setGraphVisible } = await import('../src/renderer/gitpanel.js');
const $ = (sel) => document.querySelector(sel);

test('se il checkout dal selettore fallisce, il selettore torna al ramo corrente (regressione)', async () => {
  initGit({ statusChanged() {} });
  const project = { path: '/r', root: '/r' };
  await showGit(project);
  const sel = document.querySelector('#branch-select');

  failCheckout = true;
  sel.value = 'dev';
  await sel.onchange({ target: sel });
  assert.deepEqual(calls.at(-1), ['checkout', { branch: 'dev' }]);
  assert.equal(sel.value, 'main', 'the selector must not claim a branch that was not checked out');

  failCheckout = false;
  sel.value = 'dev';
  await sel.onchange({ target: sel });
  assert.equal(sel.value, 'dev', 'a successful checkout keeps the choice');
});

test('la lista delle modifiche mostra conteggi, cartella e nome, con i caratteri HTML escapati', async () => {
  statusReply = {
    branch: { name: 'main', ahead: 2, behind: 1 },
    staged: [{ file: 'src/<a>.js', code: 'M' }],
    unstaged: [{ file: 'README.md', code: 'M' }, { file: 'nuovo.txt', code: 'U' }],
    ignored: [],
  };
  const project = { path: '/r', root: '/r' };
  await showGit(project);
  assert.equal($('#ahead').textContent, 2);
  assert.equal($('#behind').textContent, 1);
  assert.equal($('#staged-count').textContent, 1);
  assert.equal($('#unstaged-count').textContent, 2);
  assert.equal($('#changes-count').textContent, 3);
  assert.match($('#staged').innerHTML, /<bdi>src\/<b>&lt;a&gt;\.js<\/b><\/bdi>/);
  assert.match($('#staged').innerHTML, /data-act="unstage"/);
  assert.match($('#unstaged').innerHTML, /data-code="U"[\s\S]*data-act="discard"[\s\S]*data-act="stage"/);
});

test('refresh contemporanei si accorpano in uno solo di seguito, completo se uno lo chiedeva', async () => {
  const project = { path: '/r', root: '/r' };
  await showGit(project);
  statusCalls.length = 0;
  let open;
  statusGate = new Promise((r) => { open = r; });
  const first = refreshGit(project);
  refreshGit(project);
  refreshGit(project, true);
  refreshGit(project);
  open();
  statusGate = null;
  await first;
  assert.equal(statusCalls.length, 2, 'one running refresh plus one follow-up, not four');
  assert.deepEqual(statusCalls.map((o) => o.ignored), [false, true], 'the follow-up is full: it scans ignored files');
});

test('il graph si costruisce solo quando il suo tab è visibile', async () => {
  const project = { path: '/r', root: '/r' };
  setGraphVisible(false);
  logCalls = 0;
  await refreshGit(project, true);
  await showGit(project);
  assert.equal(logCalls, 0, 'hidden graph: no git log');
  setGraphVisible(true);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(logCalls, 1);
  assert.match($('#graph').innerHTML, /<svg[\s\S]*primo &lt;commit&gt;[\s\S]*Anna ·/);
  setGraphVisible(false);
});

test('scartare un file non tracciato non chiama git e rimanda al tab Project', async () => {
  const project = { path: '/r', root: '/r' };
  await showGit(project);
  const before = calls.length;
  const li = { dataset: { file: 'nuovo.txt', staged: '', code: 'U' } };
  const target = { closest: (sel) => (sel === 'li[data-file]' ? li : sel === '[data-act]' ? { dataset: { act: 'discard' } } : null) };
  const onClick = $('#unstaged').listeners?.click?.[0];
  assert.ok(onClick, 'the list handles clicks');
  await onClick({ target });
  assert.equal(calls.length, before);
});

test('un commit che finisce dopo il cambio di progetto non cancella la bozza dell\'altro progetto (regressione)', async () => {
  statusReply = { branch: { name: 'main', ahead: 0, behind: 0 }, staged: [{ file: 'a.js', code: 'M' }], unstaged: [], ignored: [] };
  const p1 = { path: '/p1', root: '/p1' };
  const p2 = { path: '/p2', root: '/p2', draft: 'bozza di p2' };
  await showGit(p1);
  $('#commit-msg').value = 'fix: qualcosa';
  let finish;
  actionGate = new Promise((r) => { finish = r; });
  const committing = $('#commit-btn').onclick();
  await showGit(p2); // the user switches project while git commits
  finish();
  actionGate = null;
  await committing;
  assert.equal(p2.draft, 'bozza di p2');
  assert.equal($('#commit-msg').value, 'bozza di p2', 'the message box still shows p2\'s draft');
  assert.equal(p1.draft, '', 'the committed project\'s draft is cleared');
});

const rowTarget = (i) => ({ closest: (sel) => (sel === '.g-row' ? { dataset: { i: String(i) }, classList: { add() {} }, click() {} } : null) });

test('graph: clic su un commit apre il dettaglio con Checkout del suo ramo; il tasto destro offre le azioni', async () => {
  statusReply = { branch: { name: 'main', ahead: 0, behind: 0 }, staged: [], unstaged: [], ignored: [] };
  const project = { path: '/g', root: '/g' };
  setGraphVisible(true);
  await showGit(project);
  await tick();
  $('#graph').onclick({ target: rowTarget(0) });
  await tick();
  assert.equal($('#review').hidden, false, 'the commit details open');
  const buttons = Object.fromEntries($('#review-actions').children.map((b) => [b.textContent, b]));
  assert.deepEqual(Object.keys(buttons), ['Checkout main', 'Nuovo branch qui', 'Cherry-pick', 'Revert']);
  buttons['Checkout main'].onclick();
  await tick();
  assert.deepEqual(calls.at(-1), ['checkout', { branch: 'main' }]);

  $('#graph').oncontextmenu({ target: rowTarget(0), preventDefault() {}, clientX: 5, clientY: 5 });
  const items = openMenuItems();
  assert.ok(items['Checkout main'] && items['Nuovo branch qui…'] && items['Cherry-pick'] && items.Revert && items['Copia hash']);
  items['Cherry-pick'].onclick();
  await tick();
  assert.deepEqual(calls.at(-1), ['cherryPick', { hash: 'c1' }]);
  setGraphVisible(false);
});

test('tasto destro su un file: stage/unstage, anteprima, e "Scarta" solo per file tracciati non in stage', async () => {
  statusReply = {
    branch: { name: 'main', ahead: 0, behind: 0 },
    staged: [{ file: 'a.js', code: 'M' }],
    unstaged: [{ file: 'b.js', code: 'M' }, { file: 'nuovo.txt', code: 'U' }, { file: 'via.js', code: 'D' }],
    ignored: [],
  };
  await showGit({ path: '/f', root: '/f' });
  const menuFor = (list, file, code, staged) => {
    const li = { dataset: { file, code, staged: staged ? '1' : '' } };
    $(list).listeners.contextmenu[0]({ target: { closest: () => li }, preventDefault() {}, clientX: 1, clientY: 1 });
    return openMenuItems();
  };
  let items = menuFor('#unstaged', 'b.js', 'M', false);
  assert.ok(items['Metti in stage'] && items['Scarta modifiche…'] && items['Anteprima file'] && items["Mostra nell'albero"]);
  items['Metti in stage'].onclick();
  await tick();
  assert.deepEqual(calls.at(-1), ['stage', { files: ['b.js'] }]);

  items = menuFor('#staged', 'a.js', 'M', true);
  assert.ok(items['Togli dallo stage'] && !items['Scarta modifiche…'], 'staged changes are not discarded from here');
  items = menuFor('#unstaged', 'nuovo.txt', 'U', false);
  assert.ok(!items['Scarta modifiche…'], 'untracked files are deleted from the Project tab, not discarded');
  items = menuFor('#unstaged', 'via.js', 'D', false);
  assert.equal(items['Anteprima file'].disabled, true, 'a deleted file has nothing to preview');
});

test('un file in conflitto non offre "Scarta" (git non può) ma solo lo stage per segnarlo risolto (regressione)', async () => {
  statusReply = { branch: { name: 'main', ahead: 0, behind: 0 }, staged: [], unstaged: [{ file: 'c.js', code: 'X' }], ignored: [] };
  await showGit({ path: '/x', root: '/x' });
  const row = $('#unstaged').innerHTML;
  assert.match(row, /data-code="X"[\s\S]*data-act="stage"/);
  assert.doesNotMatch(row, /data-act="discard"/);
  const li = { dataset: { file: 'c.js', code: 'X', staged: '' } };
  $('#unstaged').listeners.contextmenu[0]({ target: { closest: () => li }, preventDefault() {}, clientX: 1, clientY: 1 });
  const items = openMenuItems();
  assert.ok(items['Metti in stage']);
  assert.ok(!items['Scarta modifiche…']);
});

test('spuntando Amend con il messaggio vuoto si precompila il messaggio dell\'ultimo commit (regressione)', async () => {
  statusReply = { branch: { name: 'main', ahead: 0, behind: 0 }, staged: [], unstaged: [], ignored: [] };
  const p = { path: '/am', root: '/am' };
  await showGit(p);
  $('#commit-msg').value = '';
  $('#amend').checked = true;
  await $('#amend').onchange();
  assert.equal($('#commit-msg').value, 'primo', 'the last commit\'s message, ready to edit');
  assert.equal(p.draft, 'primo');

  $('#commit-msg').value = 'già scritto';
  await $('#amend').onchange();
  assert.equal($('#commit-msg').value, 'già scritto', 'a message being written is never replaced');
});

test('cambiando progetto la spunta Amend si toglie: non si modifica per sbaglio l\'ultimo commit di un altro progetto (regressione)', async () => {
  statusReply = { branch: { name: 'main', ahead: 0, behind: 0 }, staged: [{ file: 'a.js', code: 'M' }], unstaged: [], ignored: [] };
  const a = { path: '/pa', root: '/pa' };
  const b = { path: '/pb', root: '/pb' };
  await showGit(a);
  $('#amend').checked = true;
  await showGit(b);
  assert.equal($('#amend').checked, false);
  $('#commit-msg').value = 'feat: nuovo';
  calls.length = 0;
  await $('#commit-btn').onclick();
  assert.deepEqual(calls.at(-1), ['commit', { message: 'feat: nuovo', amend: false }]);
});

test('con HEAD staccato il selettore dei rami lo mostra come stato corrente, non come un ramo da scegliere', async () => {
  statusReply = { branch: { name: 'HEAD', ahead: 0, behind: 0 }, staged: [], unstaged: [], ignored: [] };
  branchesReply = [{ name: 'main', current: false, remote: false }];
  await showGit({ path: '/det', root: '/det' });
  const html = $('#branch-select').innerHTML;
  assert.match(html, /<option selected disabled value="HEAD">HEAD staccato<\/option>/);
  assert.match(html, /<option >main<\/option>/);
  branchesReply = [{ name: 'main', current: true, remote: false }, { name: 'dev', current: false, remote: false }];
});

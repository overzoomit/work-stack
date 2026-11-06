// Smart Lens: the toolbar above the diff, its event dispatch, and the generated
// commit message landing in the Git panel's commit form. The renderer DOM is
// the shared fake one, so the strings each part produces are what we assert.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { El, $, tick } from './helpers/renderer-env.mjs';

window.work.git = {
  root: async (p) => p,
  status: async () => ({
    branch: { name: 'main', ahead: 0, behind: 0 },
    staged: [],
    unstaged: [],
    ignored: [],
  }),
  branches: async () => [],
  log: async () => [],
  watch() {},
  unwatch() {},
  commit: async () => null,
  containing: async () => [],
  fileDiff: async () => '',
  action: async () => 'ok',
  explainDiff: async () => '',
  generateCommitMessage: async () => '',
};

const { smartLensHtml, renderSmartLens, bindSmartLens, setSmartLensBusy, showSmartLensOutput } =
  await import('../src/renderer/diff.js');
const { openWorking } = await import('../src/renderer/review.js');
const { initGit, showGit, setCommitMessage } = await import('../src/renderer/gitpanel.js');

const click = (box, sl, disabled = false) =>
  box.onclick({ target: { closest: () => ({ dataset: { sl }, disabled }) } });

test('la toolbar Smart Lens offre la spiegazione e, nella copia di lavoro, il messaggio di commit', () => {
  const html = smartLensHtml();
  assert.match(html, /Smart Lens/);
  assert.match(html, /data-sl="explain"/);
  assert.match(html, /data-sl="commit"/);
  assert.match(html, /data-sl-output/);
  assert.doesNotMatch(smartLensHtml({ commit: false }), /data-sl="commit"/);
});

test('i pulsanti dispatchano l’evento giusto e ignorano quelli disabilitati', () => {
  const box = new El();
  const hits = [];
  bindSmartLens(box, {
    explain: () => hits.push('explain'),
    commit: () => hits.push('commit'),
  });
  click(box, 'explain');
  click(box, 'commit');
  assert.deepEqual(hits, ['explain', 'commit']);

  hits.length = 0;
  click(box, 'explain', true);
  click(box, 'other');
  assert.deepEqual(hits, [], 'a disabled or unknown button must not run anything');
});

test('lo stato occupato e la sintesi compaiono nell’output della toolbar', () => {
  const box = new El();
  renderSmartLens(box);
  assert.equal(box.hidden, false);

  setSmartLensBusy(box, true, 'Analyzing…');
  assert.ok(box.classList.contains('busy'));
  assert.equal(box.querySelector('[data-sl-status]').textContent, 'Analyzing…');

  showSmartLensOutput(box, 'Sintesi in italiano');
  const out = box.querySelector('[data-sl-output]');
  assert.equal(out.hidden, false);
  assert.equal(out.textContent, 'Sintesi in italiano');

  setSmartLensBusy(box, false);
  assert.ok(!box.classList.contains('busy'));
});

test('dalla vista Modifiche la sintesi arriva nel pannello e il commit nel campo messaggio', async () => {
  const explained = [];
  let generated = 0;
  let used = null;
  window.work.git.explainDiff = async (repo, file) => {
    explained.push([repo, file]);
    return 'Sintesi in italiano';
  };
  window.work.git.generateCommitMessage = async (repo) => {
    generated++;
    assert.equal(repo, '/repo');
    return 'feat(diff): add smart lens';
  };

  const status = {
    branch: { name: 'main', ahead: 0, behind: 0 },
    staged: [],
    unstaged: [{ file: 'src/a.js', code: 'M' }],
    ignored: [],
  };
  await openWorking('/repo', status, { group: 'u', file: 'src/a.js' }, {
    onCommitMessage: (message) => { used = message; },
  });
  await tick();

  const box = $('#smart-lens');
  assert.equal(box.hidden, false, 'the toolbar is visible for local changes');

  click(box, 'explain');
  await tick();
  assert.deepEqual(explained, [['/repo', 'src/a.js']]);
  assert.equal(box.querySelector('[data-sl-output]').textContent, 'Sintesi in italiano');

  click(box, 'commit');
  await tick();
  assert.equal(generated, 1);
  assert.equal(used, 'feat(diff): add smart lens');
});

test('il messaggio generato viene scritto nel form di commit del pannello Git', async () => {
  initGit({ statusChanged() {} });
  const project = { path: '/r', root: '/r' };
  await showGit(project);
  await tick();

  setCommitMessage('feat(diff): add smart lens');
  assert.equal($('#commit-msg').value, 'feat(diff): add smart lens');
  assert.equal(project.draft, 'feat(diff): add smart lens');
});

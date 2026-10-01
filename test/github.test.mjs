// GitHub tab: the empty states and the repository header, on the shared fake renderer environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { El, $, tick, env, openMenuItems, answer } from './helpers/renderer-env.mjs';

let status = { installed: true, authed: true, repo: 'overzoomit/work-stack', url: 'https://github.com/overzoomit/work-stack', branch: 'main' };
let calls = 0;
let runs = [];
let jobs = [];
let workflows = [];
let secrets = [];
let secretsCalls = 0;
let setFails = null;
const saved = [];
const deleted = [];
const jobsCalls = [];
const actions = [];
const started = [];
let runsCalls = 0;
globalThis.window.work.github = {
  status: async (cwd) => {
    calls++;
    assert.equal(cwd, '/p');
    if (status instanceof Error) throw status.message;
    return status;
  },
  jobs: async (cwd, id) => {
    jobsCalls.push([cwd, id]);
    return jobs;
  },
  runAction: async (cwd, id, action) => { actions.push([cwd, id, action]); },
  workflows: async () => workflows,
  runWorkflow: async (cwd, id, branch) => { started.push([cwd, id, branch]); },
  secrets: async () => {
    secretsCalls++;
    if (secrets instanceof Error) throw secrets.message;
    return secrets;
  },
  secretSet: async (cwd, name, value) => {
    if (setFails) throw setFails;
    saved.push([cwd, name, value]);
  },
  secretDelete: async (cwd, name) => { deleted.push([cwd, name]); },
  runs: async (cwd) => {
    runsCalls++;
    assert.equal(cwd, '/p');
    if (runs instanceof Error) throw runs.message;
    return runs;
  },
};
let onFocus = null;
globalThis.window.work.app.onFocus = (fn) => { onFocus = fn; };
// The browser's storage, as a Map: the section a project last showed is kept there.
const stored = new Map();
globalThis.localStorage = { getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => stored.set(k, v) };
const { initGithub, setGithubVisible, emptyState, pollDelay, tabDot, duration, githubPushed, secretNameError } = await import('../src/renderer/github.js');

const project = { path: '/p', gitStatus: { branch: { name: 'main' } } };
const logins = [];
initGithub({ activeProject: () => project, login: (p) => logins.push(p.path) });
const body = () => $('#gh-content').innerHTML;
// A click on the button `act`, inside the row of run `id` when given.
const click = (act, id) => {
  const btn = new El();
  btn.dataset.gh = act;
  btn.textContent = act;
  const closest = (sel) => (sel === '[data-gh]' ? btn : sel === 'li[data-id]' && id ? { dataset: { id: String(id) } } : null);
  $('#gh-body').onclick({ detail: 1, target: { closest } });
  return btn;
};
// A press (or Enter, with detail 0) on the head of the row of run `id`.
const row = (id) => ({ target: { closest: (sel) => (sel === '.row-main' ? {} : sel === 'li[data-id]' ? { dataset: { id: String(id) } } : null) } });
const press = (id, e = {}) => $('#gh-body').onpointerdown({ button: 0, ...row(id), ...e });
const enter = (id) => $('#gh-body').onclick({ detail: 0, ...row(id) });
const show = async (s) => {
  status = s;
  setGithubVisible(false);
  project.gh = null;
  setGithubVisible(true);
  await tick();
};

test('senza gh il tab chiede di installarlo e apre la pagina del CLI', async () => {
  await show({ installed: false });
  assert.match(body(), /Serve GitHub CLI/);
  click('install');
  assert.deepEqual(env.opened.at(-1), 'https://cli.github.com');
});

test('un gh troppo vecchio è trattato come mancante, con il motivo', async () => {
  await show({ installed: true, old: true });
  assert.match(body(), /2\.40/);
});

test('senza login il tab propone di accedere e apre un terminale', async () => {
  await show({ installed: true, authed: false });
  assert.match(body(), /Accedi a GitHub/);
  click('login');
  assert.deepEqual(logins, ['/p']);
});

test('un progetto senza remote GitHub lo dice, senza azioni', async () => {
  await show({ installed: true, authed: true, repo: null });
  assert.match(body(), /non ha un repository su GitHub/);
  assert.doesNotMatch(body(), /data-gh=/);
});

test('con un repository mostra il nome e apre la pagina su GitHub', async () => {
  await show({ installed: true, authed: true, repo: 'overzoomit/work-stack', url: 'https://github.com/overzoomit/work-stack' });
  assert.match(body(), /overzoomit\/work-stack/);
  click('open');
  assert.equal(env.opened.at(-1), 'https://github.com/overzoomit/work-stack');
});

test('un errore di gh si vede con "Riprova", che ricarica; il nome del repository è escapato', async () => {
  await show(new Error('Impossibile raggiungere GitHub: <controlla> la connessione.'));
  assert.match(body(), /Impossibile raggiungere GitHub: &lt;controlla&gt;/);
  status = { installed: true, authed: true, repo: 'a/<b>', url: 'u' };
  click('retry');
  await tick();
  assert.match(body(), /a\/&lt;b&gt;/);
});

test('niente richieste finché il tab è nascosto; il ritorno del focus ricarica solo da visibile', async () => {
  setGithubVisible(false);
  const before = calls;
  onFocus();
  await tick();
  assert.equal(calls, before, 'hidden: no gh call');
  setGithubVisible(true);
  await tick();
  const shown = calls;
  onFocus();
  await tick();
  assert.equal(calls, shown + 1, 'visible: focus reloads');
});

test('emptyState: un repository non è uno stato vuoto', () => {
  assert.equal(emptyState({ installed: true, authed: true, repo: 'a/b' }), null);
});

const run = (id, state, extra = {}) => ({
  id, state, workflow: 'ci', title: `run ${id}`, branch: 'main', event: 'push', url: `u${id}`,
  createdAt: new Date(Date.now() - 125_000).toISOString(), updatedAt: new Date(Date.now()).toISOString(), ...extra,
});

// setTimeout calls of 10 s or more are the poll (or the post-push retry): capture them instead of waiting.
const delays = [];
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...a) => (ms >= 5000 ? (delays.push([ms, fn]), 0) : realSetTimeout(fn, ms, ...a));

test('pollDelay: 10 s con una run viva e il tab in vista, altrimenti 60 s', () => {
  assert.equal(pollDelay(true, true), 10_000);
  assert.equal(pollDelay(true, false), 60_000);
  assert.equal(pollDelay(false, true), 60_000);
  assert.equal(pollDelay(false, false), 60_000);
});

test('tabDot: rosso se l\'ultima run del branch è fallita, blu se è viva, niente altrimenti', () => {
  const r = (branch, state) => ({ branch, state });
  assert.equal(tabDot([r('dev', 'success'), r('main', 'failure'), r('main', 'success')], 'main'), 'failure', 'the newest run of the branch decides');
  assert.equal(tabDot([r('main', 'success'), r('main', 'failure')], 'main'), null, 'an older failure does not count');
  assert.equal(tabDot([r('main', 'running')], 'main'), 'running');
  assert.equal(tabDot([r('main', 'queued')], 'main'), 'running');
  assert.equal(tabDot([r('dev', 'failure')], 'main'), null, 'another branch');
  assert.equal(tabDot([], 'main'), null);
  assert.equal(tabDot(undefined, 'main'), null);
  assert.equal(tabDot([r('main', 'failure')], undefined), null);
});

test('duration: secondi, minuti, ore', () => {
  assert.equal(duration(45_000), '45s');
  assert.equal(duration(125_000), '2m 05s');
  assert.equal(duration(3_900_000), '1h 05m');
});

test('le run si vedono con stato, titolo, workflow · branch · evento e durata; il testo è escapato', async () => {
  runs = [run(3, 'running', { title: 'a <b>' }), run(2, 'failure'), run(1, 'success', { branch: 'dev' })];
  await show({ installed: true, authed: true, repo: 'a/b', url: 'u' });
  const html = body();
  assert.match(html, /dot g-running/);
  assert.match(html, /dot g-failure/);
  assert.match(html, /dot g-success/);
  assert.match(html, /a &lt;b&gt;/);
  assert.match(html, /ci · main · push/);
  assert.match(html, /<i>2m 0[45]s<\/i>/, 'a finished run shows its duration');
  assert.equal((html.match(/<i>/g) || []).length, 2, 'a live run has no duration yet');
});

test('il pallino del tab segue l\'ultima run del branch attuale', async () => {
  runs = [run(2, 'failure'), run(1, 'success')];
  await show({ installed: true, authed: true, repo: 'a/b', url: 'u' });
  assert.equal($('#gh-tab-dot').className, 'dot g-failure');
  runs = [run(3, 'running'), run(2, 'failure')];
  await show({ installed: true, authed: true, repo: 'a/b', url: 'u' });
  assert.equal($('#gh-tab-dot').className, 'dot g-running');
  runs = [run(4, 'success')];
  await show({ installed: true, authed: true, repo: 'a/b', url: 'u' });
  assert.equal($('#gh-tab-dot').className, 'dot hidden');
});

test('l\'aggiornamento è a 10 s con una run viva e a 60 s altrimenti, e rilegge solo le run', async () => {
  delays.length = 0;
  runs = [run(5, 'running')];
  await show({ installed: true, authed: true, repo: 'a/b', url: 'u' });
  assert.equal(delays.at(-1)[0], 10_000);
  const [statusBefore, runsBefore] = [calls, runsCalls];
  delays.at(-1)[1]();
  await tick();
  assert.deepEqual([calls, runsCalls], [statusBefore, runsBefore + 1], 'the poll reads the runs, not the login');

  runs = [run(5, 'success')];
  await show({ installed: true, authed: true, repo: 'a/b', url: 'u' });
  assert.equal(delays.at(-1)[0], 60_000, 'nothing live: a minute');
});

test('con il tab nascosto il ritmo resta di un minuto, anche con una run viva', async () => {
  delays.length = 0;
  runs = [run(6, 'running')];
  await show({ installed: true, authed: true, repo: 'a/b', url: 'u' });
  delays.length = 0;
  setGithubVisible(false);
  assert.equal(delays.at(-1)[0], 60_000);
});

test('un errore nel leggere le run resta nella sezione, con "Riprova"', async () => {
  runs = new Error('Non hai i permessi per farlo su questo repository.');
  await show({ installed: true, authed: true, repo: 'a/b', url: 'u' });
  assert.match(body(), /Impossibile leggere le run/);
  assert.match(body(), /Non hai i permessi/);
  assert.match(body(), /a\/b/, 'the repository header stays');
  runs = [];
  click('retry');
  await tick();
  assert.match(body(), /Nessuna run/);
});

test('dopo un push fatto da Work le run si rileggono subito e dopo qualche secondo', async () => {
  runs = [run(7, 'success')];
  await show({ installed: true, authed: true, repo: 'a/b', url: 'u' });
  delays.length = 0;
  const before = runsCalls;
  githubPushed();
  await tick();
  assert.equal(runsCalls, before + 1);
  const retry = delays.find(([ms]) => ms === 5000);
  assert.ok(retry, 'a second read is scheduled');
  retry[1]();
  await tick();
  assert.equal(runsCalls, before + 2);
});

const job = (name, state, extra = {}) => ({ name, state, startedAt: '2026-10-01T14:36:18Z', completedAt: '2026-10-01T14:36:24Z', ...extra });
const repoStatus = { installed: true, authed: true, repo: 'a/b', url: 'https://github.com/a/b' };

test('un clic sulla riga la apre e carica i job; una sola alla volta; di nuovo la chiude', async () => {
  runs = [run(11, 'success'), run(12, 'failure')];
  jobs = [job('build', 'success'), job('test', 'failure', { completedAt: '2026-10-01T14:38:00Z' })];
  jobsCalls.length = 0;
  await show(repoStatus);
  press(11);
  await tick();
  assert.equal(project.gh.open, '11');
  assert.deepEqual(jobsCalls, [['/p', 11]]);
  assert.match(body(), /<li data-id="11" class="row-item gh-item open"/);
  assert.match(body(), /gh-job-name">build</);
  assert.match(body(), /gh-job-name">test</);
  assert.match(body(), /<i>1m 42s<\/i>/, 'a job shows how long it took');

  press(12);
  assert.equal(project.gh.open, '12', 'opening another row closes the previous one');
  press(12);
  assert.equal(project.gh.open, null);
  press(11, { button: 2 });
  assert.equal(project.gh.open, null, 'only the main button opens a row');
  enter(11);
  assert.equal(project.gh.open, '11', 'Enter and Space open it too');
  $('#gh-body').onclick({ detail: 1, ...row(11) });
  assert.equal(project.gh.open, '11', 'a pointer click does not toggle twice');
});

test('le capsule dipendono dallo stato: "Riesegui falliti" solo se fallita, "Annulla" solo se viva', async () => {
  runs = [run(21, 'failure'), run(22, 'running'), run(23, 'success')];
  await show(repoStatus);
  const [failed, live, ok] = body().split('<li data-id=').slice(1);
  assert.match(failed, /data-gh="rerunFailed"/);
  assert.doesNotMatch(failed, /data-gh="cancel"/);
  assert.match(live, /data-gh="cancel"/);
  assert.doesNotMatch(live, /data-gh="rerunFailed"/);
  for (const part of [failed, live, ok]) assert.match(part, /data-gh="rerun"[\s\S]*data-gh="openRun"/);
  assert.doesNotMatch(ok, /rerunFailed|data-gh="cancel"/);
});

test('Riesegui e Riesegui falliti chiamano gh, rileggono le run e il pulsante torna com\'era', async () => {
  runs = [run(31, 'failure')];
  await show(repoStatus);
  actions.length = 0;
  const before = runsCalls;
  const btn = click('rerunFailed', 31);
  assert.equal(btn.textContent, '…', 'immediate feedback while gh works');
  await tick();
  assert.deepEqual(actions, [['/p', 31, 'rerunFailed']]);
  assert.equal(runsCalls, before + 1, 'the list is read again');
  assert.equal(btn.textContent, 'rerunFailed');
  click('rerun', 31);
  await tick();
  assert.deepEqual(actions.at(-1), ['/p', 31, 'rerun']);
});

test('Annulla chiede conferma: senza il sì non parte nulla', async () => {
  runs = [run(41, 'running', { title: 'build <x>' })];
  await show(repoStatus);
  actions.length = 0;
  click('cancel', 41);
  await tick(0);
  $('#modal-cancel').onclick();
  await tick();
  assert.deepEqual(actions, []);
  click('cancel', 41);
  await answer('');
  await tick();
  assert.deepEqual(actions, [['/p', 41, 'cancel']]);
});

test('Apri su GitHub, su una riga, apre la run', async () => {
  runs = [run(51, 'success')];
  await show(repoStatus);
  click('openRun', 51);
  assert.equal(env.opened.at(-1), 'u51');
});

test('"Esegui workflow" elenca i workflow e ne avvia uno sul branch attuale', async () => {
  runs = [];
  workflows = [{ id: 7, name: 'release' }, { id: 8, name: 'lint' }];
  await show(repoStatus);
  started.length = 0;
  click('workflow');
  await tick();
  const items = openMenuItems();
  assert.deepEqual(Object.keys(items), ['release', 'lint']);
  items.release.onclick();
  await tick();
  assert.deepEqual(started, [['/p', 7, 'main']]);
});

test('senza workflow avviabili o senza branch non parte niente', async () => {
  runs = [];
  workflows = [];
  await show(repoStatus);
  started.length = 0;
  const menus = () => document.body.children.filter((c) => c.className === 'menu').length;
  const before = menus();
  click('workflow');
  await tick();
  assert.equal(menus(), before, 'no menu without workflows');
  const branch = project.gitStatus;
  project.gitStatus = { branch: { name: null } };
  workflows = [{ id: 7, name: 'release' }];
  click('workflow');
  await tick();
  assert.equal(menus(), before, 'detached HEAD: nothing to run on');
  assert.deepEqual(started, []);
  project.gitStatus = branch;
});

test('se la run aperta sparisce dall\'elenco non resta aperto niente; i job si rileggono quando lo stato cambia', async () => {
  runs = [run(61, 'running')];
  await show(repoStatus);
  press(61);
  await tick();
  jobsCalls.length = 0;
  runs = [run(61, 'success')];
  delays.length = 0;
  await show(repoStatus); // show() resets the project; open it again and let a poll move the state
  press(61);
  await tick();
  jobsCalls.length = 0;
  runs = [run(61, 'failure')];
  delays.at(-1)[1]();
  await tick();
  assert.deepEqual(jobsCalls, [['/p', 61]], 'state moved: jobs again');
  runs = [];
  delays.at(-1)[1]();
  await tick();
  assert.equal(project.gh.open, null);
});

const secret = (name, ago_ = 3 * 86400_000) => ({ name, updatedAt: new Date(Date.now() - ago_).toISOString() });
const chooseSection = (id) => $('#gh-body').onclick({ detail: 1, target: { closest: (sel) => (sel === '[data-seg]' ? { dataset: { seg: id } } : null) } });
const sheetEl = () => $('.panel').children.filter((c) => c.className === 'gh-sheet').at(-1);
const field = (id) => sheetEl().querySelector(`#gh-secret-${id}`);
const typeIn = (id, v) => { field(id).value = v; field(id).oninput(); };
const submit = () => sheetEl().querySelector('form').onsubmit({ preventDefault() {} });
const endAnimation = (el) => el.listeners.animationend?.at(-1)?.();

test('secretNameError: la stessa regola del backend, detta mentre si scrive', () => {
  assert.equal(secretNameError(''), '', 'empty is not an error yet');
  assert.equal(secretNameError('NPM_TOKEN'), '');
  assert.equal(secretNameError('_x1'), '');
  assert.match(secretNameError('1ABC'), /cifra/);
  assert.match(secretNameError('A B'), /Solo lettere/);
  assert.match(secretNameError('A-B'), /Solo lettere/);
  assert.match(secretNameError('GITHUB_TOKEN'), /GITHUB_/);
  assert.match(secretNameError('github_x'), /GITHUB_/);
});

test('il controllo segmentato compare solo con un repository, ricorda la sezione per progetto e carica i secret', async () => {
  stored.clear();
  secrets = [secret('ZED'), secret('ALPHA', 5_000)];
  await show({ installed: false });
  assert.equal($('#gh-nav').innerHTML, '', 'no control without a repository');
  await show(repoStatus);
  assert.match($('#gh-nav').innerHTML, /data-seg="actions"[\s\S]*data-seg="secrets"/);
  assert.match(body(), /Esegui workflow/, 'Actions is the default');

  secretsCalls = 0;
  chooseSection('secrets');
  await tick();
  assert.equal(stored.get('work.gh.section:/p'), 'secrets', 'remembered per project');
  assert.equal(secretsCalls, 1);
  const html = body();
  assert.match(html, /ZED/);
  assert.match(html, /aggiornato 3 g fa/);
  assert.match(html, /aggiornato ora/);
  assert.doesNotMatch(html, /Esegui workflow/);

  // A fresh visit to the project opens on the same section.
  await show(repoStatus);
  await tick();
  assert.match(body(), /Secret del repository/);
  chooseSection('actions');
  assert.equal(stored.get('work.gh.section:/p'), 'actions');
  stored.clear();
});

test('i nomi dei secret si vedono escapati e i permessi mancanti restano nella sezione', async () => {
  stored.set('work.gh.section:/p', 'secrets');
  secrets = [secret('A<B>')];
  await show(repoStatus);
  assert.match(body(), /A&lt;B&gt;/);
  secrets = new Error('Servono i permessi di amministratore del repository per vedere i secret.');
  await show(repoStatus);
  assert.match(body(), /Servono i permessi di amministratore/);
  assert.match($('#gh-nav').innerHTML, /data-seg/, 'the other section is still one click away');
  stored.clear();
});

test('Nuovo secret: il nome è validato mentre si scrive e Salva resta spento finché non c\'è tutto', async () => {
  stored.set('work.gh.section:/p', 'secrets');
  secrets = [];
  await show(repoStatus);
  click('newSecret');
  assert.ok(sheetEl(), 'the sheet opens inside the panel');
  assert.equal(field('save').disabled, true);
  typeIn('name', '1ABC');
  assert.match(field('error').textContent, /cifra/);
  typeIn('value', 'x');
  assert.equal(field('save').disabled, true, 'a wrong name keeps Save off');
  typeIn('name', 'GITHUB_TOKEN');
  assert.match(field('error').textContent, /GITHUB_/);
  typeIn('name', 'NPM_TOKEN');
  assert.equal(field('error').textContent, '');
  assert.equal(field('save').disabled, false);
  typeIn('value', '');
  assert.equal(field('save').disabled, true, 'no value, no save');
  stored.clear();
});

test('il valore è mascherato, si mostra con l\'occhio, arriva intero a gh e sparisce alla chiusura', async () => {
  stored.set('work.gh.section:/p', 'secrets');
  secrets = [];
  saved.length = 0;
  await show(repoStatus);
  click('newSecret');
  const el = sheetEl();
  assert.ok(field('value').classList.contains('masked'), 'masked by default');
  field('eye').onclick();
  assert.equal(field('value').classList.contains('masked'), false);
  field('eye').onclick();
  assert.ok(field('value').classList.contains('masked'));

  const cert = '-----BEGIN CERT-----\nMIIB\n-----END CERT-----\n';
  typeIn('name', 'TLS_CERT');
  typeIn('value', cert);
  const before = secretsCalls;
  secrets = [secret('TLS_CERT', 1000)];
  submit();
  assert.equal(field('save').textContent, '…', 'immediate feedback');
  await tick();
  assert.deepEqual(saved, [['/p', 'TLS_CERT', cert]], 'whole, multi-line');
  assert.equal(secretsCalls, before + 1, 'the list is read again');
  assert.equal(field('value').value, '', 'the value is wiped when the sheet closes');
  endAnimation(el);
  assert.equal($('.panel').children.includes(el), false, 'the sheet is gone');
  assert.doesNotMatch(body(), /MIIB/, 'the value is nowhere in the page');
  assert.equal([...stored.values()].some((v) => v.includes('MIIB')), false, 'nor in the stored preferences');
  stored.clear();
});

test('se gh rifiuta il secret, il foglio resta aperto con il motivo e Salva torna disponibile', async () => {
  stored.set('work.gh.section:/p', 'secrets');
  secrets = [];
  await show(repoStatus);
  click('newSecret');
  typeIn('name', 'OK_NAME');
  typeIn('value', 'v');
  const label = field('save').textContent;
  setFails = 'Servono i permessi di amministratore del repository per vedere i secret.';
  submit();
  await tick();
  setFails = null;
  assert.ok(sheetEl() && !sheetEl().classList.contains('closing'), 'still open');
  assert.equal(field('save').textContent, label, 'the button reads as before');
  assert.equal(field('save').disabled, false);
  field('cancel').onclick();
  endAnimation(sheetEl());
  stored.clear();
});

test('Escape chiude il foglio e Annulla non salva niente', async () => {
  stored.set('work.gh.section:/p', 'secrets');
  secrets = [];
  saved.length = 0;
  await show(repoStatus);
  click('newSecret');
  typeIn('name', 'A');
  typeIn('value', 'v');
  const el = sheetEl();
  el.onkeydown({ key: 'Escape' });
  assert.ok(el.classList.contains('closing'));
  endAnimation(el);
  assert.deepEqual(saved, []);
  stored.clear();
});

test('Aggiorna valore: il nome è fisso e si salva sullo stesso secret', async () => {
  stored.set('work.gh.section:/p', 'secrets');
  secrets = [secret('NPM_TOKEN')];
  saved.length = 0;
  await show(repoStatus);
  click('updateSecret', 'NPM_TOKEN');
  assert.match(sheetEl().innerHTML, /readonly/);
  assert.equal(field('name').value, 'NPM_TOKEN');
  typeIn('value', 'new');
  assert.equal(field('save').disabled, false, 'the fixed name needs no check');
  submit();
  await tick();
  assert.deepEqual(saved, [['/p', 'NPM_TOKEN', 'new']]);
  endAnimation(sheetEl());
  stored.clear();
});

test('Elimina chiede conferma con il nome del secret; senza il sì non parte nulla', async () => {
  stored.set('work.gh.section:/p', 'secrets');
  secrets = [secret('NPM_TOKEN')];
  deleted.length = 0;
  await show(repoStatus);
  click('deleteSecret', 'NPM_TOKEN');
  await tick(0);
  assert.match($('#modal-text').textContent, /NPM_TOKEN/);
  $('#modal-cancel').onclick();
  await tick();
  assert.deepEqual(deleted, []);
  const before = secretsCalls;
  click('deleteSecret', 'NPM_TOKEN');
  await answer('');
  await tick();
  assert.deepEqual(deleted, [['/p', 'NPM_TOKEN']]);
  assert.equal(secretsCalls, before + 1);
  stored.clear();
});

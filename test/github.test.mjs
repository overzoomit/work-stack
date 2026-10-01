// GitHub tab: the empty states and the repository header, on the shared fake renderer environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { $, tick, env } from './helpers/renderer-env.mjs';

let status = { installed: true, authed: true, repo: 'overzoomit/work-stack', url: 'https://github.com/overzoomit/work-stack', branch: 'main' };
let calls = 0;
let runs = [];
let runsCalls = 0;
globalThis.window.work.github = {
  status: async (cwd) => {
    calls++;
    assert.equal(cwd, '/p');
    if (status instanceof Error) throw status.message;
    return status;
  },
  runs: async (cwd) => {
    runsCalls++;
    assert.equal(cwd, '/p');
    if (runs instanceof Error) throw runs.message;
    return runs;
  },
};
let onFocus = null;
globalThis.window.work.app.onFocus = (fn) => { onFocus = fn; };
const { initGithub, setGithubVisible, emptyState, pollDelay, tabDot, duration, githubPushed } = await import('../src/renderer/github.js');

const project = { path: '/p', gitStatus: { branch: { name: 'main' } } };
const logins = [];
initGithub({ activeProject: () => project, login: (p) => logins.push(p.path) });
const body = () => $('#gh-body').innerHTML;
const click = (act) => $('#gh-body').onclick({ target: { closest: () => ({ dataset: { gh: act } }) } });
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

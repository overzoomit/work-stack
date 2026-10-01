// GitHub tab: the empty states and the repository header, on the shared fake renderer environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { $, tick, env } from './helpers/renderer-env.mjs';

let status = { installed: true, authed: true, repo: 'overzoomit/work-stack', url: 'https://github.com/overzoomit/work-stack', branch: 'main' };
let calls = 0;
globalThis.window.work.github = {
  status: async (cwd) => {
    calls++;
    assert.equal(cwd, '/p');
    if (status instanceof Error) throw status.message;
    return status;
  },
};
let onFocus = null;
globalThis.window.work.app.onFocus = (fn) => { onFocus = fn; };
const { initGithub, setGithubVisible, emptyState } = await import('../src/renderer/github.js');

const project = { path: '/p' };
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

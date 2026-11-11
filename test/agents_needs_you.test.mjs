// "Needs You": the pending dogwatch prompts must surface first in the Agent
// Team popover and be answerable without leaving the UI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env, tick } from './helpers/renderer-env.mjs';

const T = await import('../src/renderer/terminals.js');
const Team = await import('../src/renderer/team.js');
T.initTerminals({ homeDir: '/home/u', changed() {} });

const project = { path: '/home/u/needs-you', focusedId: null, maximizedId: null };

let onUpdate;
const answers = [];
window.work.dogwatch = {
  onUpdate: (cb) => { onUpdate = cb; },
  inspect: async () => ({ session: 'work_needs', windows: [] }),
  answer: async (session, target, text) => { answers.push([session, target, text]); },
};

const clickWith = (dataset) => ({
  target: {
    closest: (sel) => (sel === '[data-act]' || sel === '[data-target]' ? { dataset } : null),
  },
});

const openPop = async () => {
  Team.initTeam({ activeProject: () => project });
  await Team.openTeamMenu();
  return document.body.children.filter((c) => c.className?.includes('team-pop')).at(-1);
};

const closePop = async () => {
  Team.closeTeamMenu();
  await tick(700);
};

test('la card Richiede Attenzione compare in cima e sparisce quando l’agente riprende', async () => {
  env.tmuxAvailable = true;
  env.tmuxSession = 'work_needs';
  env.tmuxWindows = [];

  const pop = await openPop();
  assert.ok(pop);
  assert.doesNotMatch(pop.innerHTML, /Needs You/, 'nessun prompt: nessuna card');

  onUpdate(
    project.path,
    'work_needs',
    [{ target: 'dev1', prompt_type: 'confirmation', question: 'Continue with the deploy? [y/N]', options: ['Yes', 'No'] }],
    true,
    [{ id: '@1', name: 'dev1', state: 'blocked', rule: 'opencode-confirmation', agent: 'opencode' }],
  );
  await tick();

  assert.match(pop.innerHTML, /Richiede Attenzione \/ Needs You/, 'la card è visibile');
  assert.match(pop.innerHTML, /Continue with the deploy\? \[y\/N\]/, 'mostra la domanda reale');
  assert.match(pop.innerHTML, /\[DEV1\]/, 'mostra il ruolo dell’agente');
  assert.match(pop.innerHTML, /data-act="dw-answer" data-target="dev1" data-answer="y"/, 'pulsante Sì');
  assert.match(pop.innerHTML, /data-act="dw-answer" data-target="dev1" data-answer="n"/, 'pulsante No');
  assert.match(pop.innerHTML, /data-dw-form data-target="dev1"/, 'campo per la risposta personalizzata');
  assert.ok(
    pop.innerHTML.indexOf('Needs You') < pop.innerHTML.indexOf('Project Manager'),
    'la card è in cima alla lista della squadra',
  );

  await pop.listeners.click[0](clickWith({ act: 'dw-answer', target: 'dev1', answer: 'y' }));
  await tick();
  assert.deepEqual(answers.at(-1), ['work_needs', 'dev1', 'y'], 'il clic invia y alla finestra tmux');
  assert.doesNotMatch(pop.innerHTML, /Needs You/, 'la card sparisce subito dopo la risposta');

  // Il watcher conferma lo sblocco: nessuna card da ripristinare.
  onUpdate(project.path, 'work_needs', [], true, [
    { id: '@1', name: 'dev1', state: 'working', rule: 'opencode-spinner', agent: 'opencode' },
  ]);
  await tick();
  assert.doesNotMatch(pop.innerHTML, /Needs You/);

  await closePop();
  env.tmuxAvailable = false;
});

test('il campo personalizzato invia il testo libero dell’utente', async () => {
  env.tmuxAvailable = true;
  env.tmuxSession = 'work_needs';
  env.tmuxWindows = [];

  const pop = await openPop();
  onUpdate(
    project.path,
    'work_needs',
    [{ target: 'qa1', prompt_type: 'question', question: 'Which file should I edit?', options: [] }],
    true,
    [{ id: '@2', name: 'qa1', state: 'blocked', rule: 'codex-question', agent: 'codex' }],
  );
  await tick();
  assert.match(pop.innerHTML, /Which file should I edit\?/);
  assert.doesNotMatch(pop.innerHTML, /data-answer="y"/, 'una domanda aperta non ha il pulsante Sì');

  const form = { dataset: { target: 'qa1' } };
  const input = { value: 'src/renderer/team.js', focus() {} };
  const event = {
    preventDefault() {},
    target: {
      closest: (sel) => (sel === '[data-dw-form]' ? form : null),
      querySelector: (sel) => (sel === '[data-dw-input]' ? input : null),
    },
  };
  await pop.listeners.submit[0](event);
  await tick();

  assert.deepEqual(answers.at(-1), ['work_needs', 'qa1', 'src/renderer/team.js']);
  assert.doesNotMatch(pop.innerHTML, /Needs You/, 'la card sparisce dopo l’invio');

  await closePop();
  env.tmuxAvailable = false;
});

test('una card con relayed_to_pm mostra che il PM ha già la domanda', () => {
  const relayed = Team.needsYouHtml([
    { target: 'dev1', prompt_type: 'question', question: 'Why?', relayed_to_pm: true },
  ]);
  assert.match(relayed, /Relayed to PM/);
  const pending = Team.needsYouHtml([
    { target: 'dev1', prompt_type: 'question', question: 'Why?', relayed_to_pm: false },
  ]);
  assert.doesNotMatch(pending, /Relayed to PM/, 'senza inoltro nessuna etichetta');
});

test('needsYouHtml aggrega più agenti, esclude le voci senza target e scappa il testo', () => {
  const html = Team.needsYouHtml([
    { target: 'dev1', prompt_type: 'confirmation', question: 'Proceed? [y/N]', options: ['Yes', 'No'] },
    { target: 'qa2', prompt: { prompt_type: 'permission', question: 'Allow <rm>?', options: ['Yes', 'No'] } },
    { question: 'no target' },
  ]);
  assert.match(html, /Needs You/);
  assert.match(html, /data-target="dev1"/);
  assert.match(html, /data-target="qa2"/);
  assert.doesNotMatch(html, /data-target="undefined"/);
  assert.match(html, /Allow &lt;rm&gt;\?/, 'la domanda è HTML-escaped');
  assert.match(html, /tp-needs-count">2</, 'conta i prompt pendenti');
  assert.equal(Team.needsYouHtml([]), '', 'nessun prompt, nessuna card');
  assert.deepEqual(
    Team.needsYouEntries([{ target: 'dev1', prompt: { prompt_type: 'question', question: 'Why?' } }]),
    [{ target: 'dev1', prompt_type: 'question', question: 'Why?' }],
    'normalizza il formato dell’evento e quello dell’inspection',
  );
});

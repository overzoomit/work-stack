// Claude Code transcript parsing and the session watcher, on temp folders.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECTS = fs.mkdtempSync(path.join(os.tmpdir(), 'work-agents-'));
process.env.WORK_CLAUDE_PROJECTS = PROJECTS; // read at require time
const { AgentWatcher, Session, SESSION_FILE } = require('../src/main/agents');

const UUID = '12345678-1234-1234-1234-123456789abc';
const line = (o) => `${JSON.stringify({ timestamp: new Date().toISOString(), cwd: '/work/proj', ...o })}\n`;
const user = (text) => line({ type: 'user', message: { role: 'user', content: text } });
const toolUse = (name, input) => line({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name, input }] } });
const reply = (text) => line({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } });

function transcript(name, ...lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-session-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.join(''));
  return file;
}

test('una sessione che ha appena chiesto un tool risulta al lavoro su quel tool', () => {
  const s = new Session(transcript(`${UUID}.jsonl`, user('sistema il bug'), toolUse('Bash', { command: 'npm test' })));
  s.read();
  assert.deepEqual(s.status, { state: 'working', label: 'Esegue Bash' });
  assert.deepEqual(s.events.map((e) => [e.kind, e.text]), [['user', 'sistema il bug'], ['tool', 'npm test']]);
});

test('una sessione che ha risposto attende il tuo input', () => {
  const s = new Session(transcript(`${UUID}.jsonl`, user('ciao'), reply('Fatto.')));
  s.read();
  assert.equal(s.status.state, 'waiting');
});

test('un tool senza risultato da più di 15 s viene letto come richiesta di permesso', () => {
  const s = new Session(transcript(`${UUID}.jsonl`, toolUse('Edit', { file_path: '/x.js' })));
  s.read();
  s.mtime = Date.now() - 20000;
  assert.deepEqual(s.status, { state: 'blocked', label: 'Attende permesso: Edit' });
});

test('una sessione ferma da oltre 10 minuti è inattiva', () => {
  const s = new Session(transcript(`${UUID}.jsonl`, reply('ok')));
  s.read();
  s.mtime = Date.now() - 11 * 60 * 1000;
  assert.equal(s.status.state, 'idle');
});

test('il titolo preferisce il nome agente, poi il titolo AI, poi il primo messaggio', () => {
  const s = new Session(transcript(`${UUID}.jsonl`,
    user('primo messaggio'),
    line({ type: 'ai-title', aiTitle: 'Titolo AI' }),
    line({ type: 'agent-name', agentName: 'nome-agente' })));
  s.read();
  assert.equal(s.toJSON().title, 'nome-agente');
});

test('legge solo le righe nuove tra una lettura e l\'altra', () => {
  const file = transcript(`${UUID}.jsonl`, user('uno'));
  const s = new Session(file);
  s.read();
  fs.appendFileSync(file, user('due'));
  assert.equal(s.read(), true);
  assert.equal(s.read(), false, 'nothing new → no change');
  assert.deepEqual(s.events.map((e) => e.text), ['uno', 'due']);
});

test('accetta solo file di sessione con nome UUID (regressione)', () => {
  assert.ok(SESSION_FILE.test(`${UUID}.jsonl`));
  assert.ok(!SESSION_FILE.test('x; touch PWNED.jsonl'));
  assert.ok(!SESSION_FILE.test(`${UUID}.jsonl.bak`));
});

// The watcher owns timers and fs watchers: always stop it, even when an
// assertion throws, or the test process never exits.
function watcher(t) {
  const w = new AgentWatcher(() => {});
  t.after(() => w.stop());
  w.start();
  return w;
}

test('il watcher ignora i file con nomi non validi (regressione)', (t) => {
  const dir = path.join(PROJECTS, '-proj-a');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${UUID}.jsonl`), user('valida'));
  fs.writeFileSync(path.join(dir, 'x; touch PWNED.jsonl'), user('malevola'));
  const w = watcher(t);
  assert.deepEqual(w.list().map((a) => a.id), [UUID]);
});

test('le sessioni più vecchie di 24 ore escono dalla lista (regressione)', (t) => {
  const dir = path.join(PROJECTS, '-proj-b');
  fs.mkdirSync(dir, { recursive: true });
  const other = '22222222-2222-2222-2222-222222222222';
  fs.writeFileSync(path.join(dir, `${other}.jsonl`), user('recente'));
  const w = watcher(t);
  [...w.sessions.values()].find((s) => s.id === other).mtime = Date.now() - 25 * 3600 * 1000;
  assert.ok(!w.list().some((a) => a.id === other));
});

test('le sessioni più vecchie di 24 ore vengono rimosse dalla memoria (regressione)', (t) => {
  const dir = path.join(PROJECTS, '-proj-c');
  fs.mkdirSync(dir, { recursive: true });
  const other = '33333333-3333-3333-3333-333333333333';
  fs.writeFileSync(path.join(dir, `${other}.jsonl`), user('recente'));
  const w = watcher(t);
  [...w.sessions.values()].find((s) => s.id === other).mtime = Date.now() - 25 * 3600 * 1000;
  w.prune();
  assert.ok(![...w.sessions.values()].some((s) => s.id === other));
});

test('la lista inviata all\'interfaccia non contiene gli eventi, che si chiedono per id', (t) => {
  const dir = path.join(PROJECTS, '-proj-events');
  fs.mkdirSync(dir, { recursive: true });
  const id = '44444444-4444-4444-4444-444444444444';
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), user('ciao') + reply('fatto'));
  const w = watcher(t);
  const a = w.list().find((x) => x.id === id);
  assert.equal(a.events, undefined);
  assert.equal(a.eventSeq, 2);
  assert.deepEqual(w.events(id).map((e) => e.text), ['ciao', 'fatto']);
  assert.deepEqual(w.events('sconosciuto'), []);
});

test('il contatore degli eventi continua a crescere oltre il limite di 60', () => {
  const lines = Array.from({ length: 70 }, (_, i) => user(`messaggio ${i}`));
  const s = new Session(transcript(`${UUID}.jsonl`, ...lines));
  s.read();
  assert.equal(s.events.length, 60);
  assert.equal(s.toJSON().eventSeq, 70);
});

test('con lo stesso id in due cartelle, gli eventi sono quelli della sessione più recente', (t) => {
  const id = '55555555-5555-5555-5555-555555555555';
  for (const [folder, text] of [['-proj-old', 'vecchia'], ['-proj-new', 'nuova']]) {
    fs.mkdirSync(path.join(PROJECTS, folder), { recursive: true });
    fs.writeFileSync(path.join(PROJECTS, folder, `${id}.jsonl`), user(text));
  }
  const w = watcher(t);
  const sessions = [...w.sessions.values()].filter((s) => s.id === id);
  sessions.find((s) => s.events[0].text === 'vecchia').mtime = Date.now() - 3600 * 1000;
  assert.deepEqual(w.events(id).map((e) => e.text), ['nuova']);
});

const toolResult = (isError, text) => line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', is_error: isError, content: [{ type: 'text', text }] }] } });
const toolCall = (name, input, usage) => line({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', usage, content: [{ type: 'tool_use', name, input }] } });

test('il riepilogo di un tool mostra il campo più utile del suo input', () => {
  const s = new Session(transcript(`${UUID}.jsonl`,
    toolCall('Read', { file_path: '/src/a.js', limit: 10 }),
    toolCall('Grep', { pattern: 'TODO', path: '.' }),
    toolCall('Custom', { x: 1 }),
    toolCall('Empty', {})));
  s.read();
  assert.deepEqual(s.events.map((e) => [e.tool, e.text]), [['Read', '/src/a.js'], ['Grep', 'TODO'], ['Custom', '{"x":1}'], ['Empty', '']]);
});

test('un tool fallito diventa un evento di errore, un tool riuscito no', () => {
  const s = new Session(transcript(`${UUID}.jsonl`, toolCall('Bash', { command: 'ls' }), toolResult(true, 'permesso negato'), toolResult(false, 'ok')));
  s.read();
  assert.deepEqual(s.events.map((e) => [e.kind, e.text]), [['tool', 'ls'], ['error', 'permesso negato']]);
  assert.equal(s.status.label, 'Sta ragionando…', 'a tool result means the model is thinking again');
});

test('promemoria di sistema e messaggi dei sotto-agenti non entrano nella timeline', () => {
  const s = new Session(transcript(`${UUID}.jsonl`,
    user('<system-reminder>ignora</system-reminder>'),
    line({ type: 'user', isSidechain: true, message: { role: 'user', content: 'dal sotto-agente' } }),
    user('vero messaggio')));
  s.read();
  assert.deepEqual(s.events.map((e) => e.text), ['vero messaggio']);
  assert.equal(s.toJSON().title, 'vero messaggio');
});

test('i token di contesto sommano input, cache e output dell\'ultima risposta', () => {
  const s = new Session(transcript(`${UUID}.jsonl`, toolCall('Bash', { command: 'x' }, { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 5 })));
  s.read();
  assert.equal(s.toJSON().tokens, 1215);
});

test('lo stato passa ad "attende permesso" dopo 15 s su un tool e a "inattivo" dopo 10 minuti', () => {
  const s = new Session(transcript(`${UUID}.jsonl`, toolCall('Bash', { command: 'rm -rf build' })));
  s.read();
  s.mtime = Date.now() - 16 * 1000;
  assert.deepEqual(s.status, { state: 'blocked', label: 'Attende permesso: Bash' });
  s.mtime = Date.now() - 11 * 60 * 1000;
  assert.equal(s.status.state, 'idle');
});

test('se il transcript viene riscritto da capo, la riga incompleta precedente non sporca la prima nuova (regressione)', () => {
  const file = transcript(`${UUID}.jsonl`, user('primo'), '{"type":"user","message":{"role":"user","content":"a metà');
  const s = new Session(file);
  s.read();
  fs.writeFileSync(file, user('nuovo inizio')); // shorter than before: rewritten from scratch
  s.read();
  assert.deepEqual(s.events.map((e) => e.text), ['primo', 'nuovo inizio']);
});

test('una raffica di scritture su un transcript produce un solo aggiornamento con tutti i messaggi', async (t) => {
  const dir = path.join(PROJECTS, '-proj-live');
  fs.mkdirSync(dir, { recursive: true });
  const id = '77777777-7777-7777-7777-777777777777';
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, user('inizio'));
  const updates = [];
  const w = new AgentWatcher((list) => updates.push(list));
  t.after(() => w.stop());
  w.start();
  await new Promise((r) => setTimeout(r, 150));
  updates.length = 0;
  for (const text of ['uno', 'due', 'tre']) fs.appendFileSync(file, user(text)); // streaming reply
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(updates.length, 1, 'writes within 250 ms are coalesced');
  assert.equal(updates[0].find((a) => a.id === id).eventSeq, 4);
  assert.deepEqual(w.events(id).map((e) => e.text), ['inizio', 'uno', 'due', 'tre']);
});

test('dopo stop non arrivano più aggiornamenti, nemmeno da scritture appena avvenute (regressione)', async () => {
  const dir = path.join(PROJECTS, '-proj-stop');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '88888888-8888-8888-8888-888888888888.jsonl');
  fs.writeFileSync(file, user('inizio'));
  let updates = 0;
  const w = new AgentWatcher(() => updates++);
  w.start();
  await new Promise((r) => setTimeout(r, 150));
  updates = 0;
  fs.appendFileSync(file, user('ultima'));
  await new Promise((r) => setTimeout(r, 100)); // the write is seen, its flush is pending
  w.stop();
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(updates, 0);
});

test('una sessione in una cartella di progetto appena creata compare senza aspettare altre scritture (regressione)', async (t) => {
  const updates = [];
  const w = new AgentWatcher((list) => updates.push(list));
  t.after(() => w.stop());
  w.start();
  await new Promise((r) => setTimeout(r, 150));
  const id = '99999999-9999-9999-9999-999999999999';
  const dir = path.join(PROJECTS, '-proj-nuovo');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), user('prima riga'));
  await new Promise((r) => setTimeout(r, 800));
  assert.ok(w.list().some((a) => a.id === id), 'listed');
  assert.ok(updates.some((l) => l.some((a) => a.id === id)), 'and sent to the UI');
});

test('una sessione il cui file viene cancellato sparisce dalla lista (regressione)', async (t) => {
  const dir = path.join(PROJECTS, '-proj-del');
  fs.mkdirSync(dir, { recursive: true });
  const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, user('da cancellare'));
  const updates = [];
  const w = new AgentWatcher((list) => updates.push(list));
  t.after(() => w.stop());
  w.start();
  assert.ok(w.list().some((a) => a.id === id));
  fs.unlinkSync(file);
  await new Promise((r) => setTimeout(r, 700));
  assert.ok(!w.list().some((a) => a.id === id), 'gone from the list');
  assert.ok(!updates.at(-1).some((a) => a.id === id), 'and the UI was told');
});

const interrupt = (text, withToolResult) => line({ type: 'user', message: { role: 'user', content: [
  ...(withToolResult ? [{ type: 'tool_result', is_error: true, content: 'The user doesn\'t want to proceed with this tool use.' }] : []),
  { type: 'text', text },
] } });

test('dopo un\'interruzione l\'agente attende il tuo input, non "sta ragionando" (regressione)', () => {
  const s = new Session(transcript(`${UUID}.jsonl`, user('fai il deploy'), reply('Inizio…'), interrupt('[Request interrupted by user]')));
  s.read();
  assert.equal(s.status.state, 'waiting');
  assert.deepEqual(s.events.map((e) => e.text), ['fai il deploy', 'Inizio…'], 'the marker is not shown as your message');
});

test('anche l\'interruzione durante un tool lascia l\'agente in attesa (regressione)', () => {
  const s = new Session(transcript(`${UUID}.jsonl`, user('pulisci'), toolCall('Bash', { command: 'rm -rf dist' }),
    interrupt('[Request interrupted by user for tool use]', true)));
  s.read();
  assert.equal(s.status.state, 'waiting');
});

test('un carattere accentato spezzato tra due letture arriva intatto nella timeline (regressione)', () => {
  const file = transcript(`${UUID}.jsonl`);
  const bytes = Buffer.from(user('perché è così'));
  const cut = bytes.indexOf(Buffer.from('è')) + 1; // in the middle of the two bytes of "è"
  fs.writeFileSync(file, bytes.subarray(0, cut));
  const s = new Session(file);
  s.read();
  fs.appendFileSync(file, bytes.subarray(cut));
  s.read();
  assert.deepEqual(s.events.map((e) => e.text), ['perché è così']);
});

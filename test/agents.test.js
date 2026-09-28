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

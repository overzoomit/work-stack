// Live Claude Code processes from ~/.claude/sessions/<pid>.json, on a temp
// folder and real child processes standing in for Claude Code.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { tempDir } = require('./helpers/tmp');

const DIR = tempDir('work-procs-');
process.env.WORK_CLAUDE_SESSIONS = DIR; // read at require time
const procs = require('../src/main/claudeprocs');

const SID = '11111111-2222-3333-4444-555555555555';
const children = [];
function fakeClaude({ ignoreTerm = false } = {}) {
  const code = `${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''} setInterval(() => {}, 1000); process.send?.('up');`;
  const c = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  children.push(c);
  return new Promise((r) => c.once('message', () => r(c)));
}
const record = (pid, fields) => fs.writeFileSync(path.join(DIR, `${pid}.json`), JSON.stringify({ pid, ...fields }));
const exited = (c) => (c.exitCode !== null || c.signalCode !== null ? Promise.resolve(c.signalCode) : new Promise((r) => c.once('exit', (_code, sig) => r(sig))));
test.after(() => children.forEach((c) => c.kill('SIGKILL')));

test('le sessioni aperte sono quelle con un processo vivo e lo stesso di quando è stato registrato', async () => {
  const c = await fakeClaude();
  record(c.pid, { sessionId: SID, procStart: procs.procStart(c.pid) });
  record(999999, { sessionId: 'morto' }); // process gone
  const reused = await fakeClaude();
  record(reused.pid, { sessionId: 'pid-riusato', procStart: '1' }); // same pid, another process
  fs.writeFileSync(path.join(DIR, '12.json'), JSON.stringify({ pid: c.pid, sessionId: 'nome-sbagliato' }));
  fs.writeFileSync(path.join(DIR, '13.json'), '{ non json');
  const live = procs.live();
  assert.ok(procs.tracked());
  assert.deepEqual([...live.keys()], [SID]);
  assert.equal(live.get(SID).pid, c.pid);
});

test('chiudere una sessione termina il suo processo con SIGTERM', async () => {
  const c = await fakeClaude();
  const id = 'aaaaaaaa-0000-0000-0000-000000000001';
  record(c.pid, { sessionId: id, procStart: procs.procStart(c.pid) });
  await procs.stop(id);
  assert.equal(await exited(c), 'SIGTERM');
});

test('un processo che ignora SIGTERM viene chiuso con SIGKILL dopo l\'attesa', async () => {
  const c = await fakeClaude({ ignoreTerm: true });
  const id = 'aaaaaaaa-0000-0000-0000-000000000002';
  record(c.pid, { sessionId: id, procStart: procs.procStart(c.pid) });
  await procs.stop(id, { grace: 300 });
  assert.equal(await exited(c), 'SIGKILL');
});

test('chiudere una sessione non aperta è un errore chiaro e non tocca nessun processo', async () => {
  await assert.rejects(procs.stop('non-esiste'), /non è più aperta/);
  await assert.rejects(procs.stop('pid-riusato'), /non è più aperta/, 'a reused pid is never signalled');
});

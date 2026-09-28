// Integration: real shell through the Python PTY bridge.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PtyManager } = require('../src/main/pty');

function runInPty(command) {
  const ptys = new PtyManager();
  let out = '';
  return new Promise((resolve) => {
    ptys.create({ cwd: '/tmp', cols: 80, rows: 24, command }, (_id, data) => { out += data; }, (_id, code) => resolve({ out, code }));
  });
}

test('i caratteri multi-byte spezzati tra due blocchi arrivano intatti (regressione)', async () => {
  // Prints "è─✓" one byte at a time: every multi-byte character is split across writes.
  const script = "import os,time\nfor b in 'è─✓'.encode():\n  os.write(1,bytes([b])); time.sleep(0.02)";
  const { out } = await runInPty(`python3 -c "${script}"`);
  assert.equal(out.trim(), 'è─✓');
});

test('il codice di uscita del comando viene riportato', async () => {
  const { code } = await runInPty('exit 3');
  assert.equal(code, 3);
});

test('il terminale ha la dimensione richiesta', async () => {
  const { out } = await runInPty('stty size');
  assert.equal(out.trim(), '24 80');
});

test('il terminale si presenta come xterm con colori completi', async () => {
  const { out } = await runInPty('echo "$TERM $COLORTERM"');
  assert.equal(out.trim(), 'xterm-256color truecolor');
});

test('cwd legge la cartella corrente della shell senza bloccare', async () => {
  const ptys = new PtyManager();
  const dir = require('fs').realpathSync(require('os').tmpdir());
  const id = ptys.create({ cwd: dir, cols: 80, rows: 24 }, () => {}, () => {});
  await new Promise((r) => setTimeout(r, 300));
  const pending = ptys.cwd(id);
  assert.ok(pending instanceof Promise);
  assert.equal(await pending, dir);
  ptys.killAll();
});

test('l\'output viene accorpato in pochi messaggi', async () => {
  const ptys = new PtyManager();
  let messages = 0;
  let out = '';
  await new Promise((resolve) => {
    const id = ptys.create({ cwd: '/tmp', cols: 80, rows: 24, command: 'seq 1 200000' }, (_id, data) => {
      messages++;
      out += data;
      ptys.ack(id, data.length);
    }, resolve);
  });
  assert.ok(out.includes('200000'));
  assert.ok(messages < 200, `messaggi: ${messages}`);
});

test('senza conferme dal terminale la shell viene messa in pausa, con le conferme finisce', async () => {
  const ptys = new PtyManager();
  let received = 0;
  let exited = false;
  const id = ptys.create({ cwd: '/tmp', cols: 80, rows: 24, command: 'seq 1 2000000' }, (_id, data) => {
    received += data.length;
  }, () => { exited = true; });
  await new Promise((r) => setTimeout(r, 1500));
  // ~14 MB in total: it must stop a little past the 1 MB high-water mark.
  assert.equal(exited, false);
  assert.ok(received < 2 * 1024 * 1024, `ricevuti ${received}`);
  // Acknowledge everything as it arrives: the command runs to the end.
  assert.equal(ptys.sessions.get(id).paused, true);
  await new Promise((resolve) => {
    const tick = setInterval(() => {
      if (exited) {
        clearInterval(tick);
        resolve();
        return;
      }
      ptys.ack(id, Number.MAX_SAFE_INTEGER);
    }, 20);
  });
  assert.equal(exited, true);
});

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

test('chiudere una sessione in pausa per il controllo di flusso la fa terminare comunque', async () => {
  const ptys = new PtyManager();
  let exited = false;
  const id = ptys.create({ cwd: '/tmp', cols: 80, rows: 24, command: 'seq 1 5000000' }, () => {}, () => { exited = true; });
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(ptys.sessions.get(id).paused, true, 'nobody acked: the shell is paused');
  ptys.kill(id);
  for (let i = 0; i < 50 && !exited; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(exited, true);
});

test('write invia l\'input alla shell e resize cambia la dimensione vista dai programmi', async () => {
  const ptys = new PtyManager();
  let out = '';
  const id = ptys.create({ cwd: '/tmp', cols: 80, rows: 24, command: 'read line; echo "got:$line"; sleep 0.3; stty size' }, (_id, d) => {
    out += d;
    ptys.ack(_id, d.length);
  }, () => {});
  await new Promise((r) => setTimeout(r, 300));
  ptys.resize(id, 100, 30);
  ptys.write(id, 'ciao\r');
  for (let i = 0; i < 40 && !/\d+ \d+/.test(out.split('got:')[1] || ''); i++) await new Promise((r) => setTimeout(r, 50));
  assert.match(out, /got:ciao/);
  assert.match(out, /30 100/);
  ptys.killAll();
});

test('le shell non ereditano le variabili npm_* del processo che ha avviato Work (regressione)', async () => {
  process.env.npm_config_prefix = '/tmp/prefisso';
  process.env.npm_lifecycle_event = 'start';
  try {
    const { out } = await runInPty('env | grep -c "^npm_" ; echo "HOME=$HOME"');
    assert.match(out, /^0\s/, 'no npm_* variables (nvm refuses to run with npm_config_prefix set)');
    assert.match(out, /HOME=\//, 'the rest of the environment is kept');
  } finally {
    delete process.env.npm_config_prefix;
    delete process.env.npm_lifecycle_event;
  }
});

test('l\'helper funziona anche con Python 3.8, il python3 di Ubuntu 20.04 (regressione)', { skip: !require('fs').existsSync('/usr/bin/python3.8') && 'python3.8 non installato' }, async () => {
  const { spawn } = require('child_process');
  const helper = require('path').join(__dirname, '..', 'src', 'main', 'pty-helper.py');
  const run = (cmd) => new Promise((resolve) => {
    const p = spawn('/usr/bin/python3.8', [helper, '80', '24', '/bin/sh', '-c', cmd], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => resolve({ code, err }));
  });
  assert.deepEqual(await run('exit 3'), { code: 3, err: '' });
  assert.deepEqual(await run('kill -TERM $$'), { code: 128 + 15, err: '' }, 'killed by a signal: shell convention');
});

test('un terminale aperto in una cartella che non esiste più parte dalla home invece di far crashare Work (regressione)', async () => {
  const { out, code } = await new Promise((resolve) => {
    const ptys = new PtyManager();
    let text = '';
    ptys.create({ cwd: '/cartella/che/non/esiste', cols: 80, rows: 24, command: 'pwd' }, (_id, d) => { text += d; }, (_id, c) => resolve({ out: text, code: c }));
  });
  assert.equal(code, 0);
  assert.equal(out.trim(), require('fs').realpathSync(require('os').homedir()));
});

test('tasti e ridimensionamenti inviati mentre la shell esce non fanno crashare Work (regressione)', async () => {
  let crash = null;
  const onCrash = (e) => { crash = e; };
  process.on('uncaughtException', onCrash);
  try {
    const ptys = new PtyManager();
    await Promise.all(Array.from({ length: 20 }, () => new Promise((resolve) => {
      const id = ptys.create({ cwd: '/tmp', cols: 80, rows: 24, command: 'exit 0' }, () => {}, resolve);
      const spam = setInterval(() => {
        if (!ptys.sessions.has(id)) return clearInterval(spam);
        ptys.write(id, 'x'.repeat(1000));
        ptys.resize(id, 80, 24);
      }, 0);
    })));
    await new Promise((r) => setTimeout(r, 300)); // late EPIPE errors surface asynchronously
  } finally {
    process.off('uncaughtException', onCrash);
  }
  assert.equal(crash, null, crash && `${crash.code} ${crash.message}`);
});

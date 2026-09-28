// PtyManager: one shell per terminal, bridged through pty-helper.py
// (no native modules, works on Linux and macOS).
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HELPER = path.join(__dirname, 'pty-helper.py');
const execFileAsync = promisify(execFile);
const FLUSH_MS = 8;
const FLUSH_SIZE = 16 * 1024; // larger chunks make xterm block the UI longer per write
const HIGH_WATER = 1024 * 1024; // chars sent but not yet processed by xterm
const LOW_WATER = 256 * 1024;

// The user's environment, minus what `npm start` adds to Work's own process:
// npm_* variables leak into every shell and break tools like nvm.
function shellEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^npm_/i.test(k)) delete env[k];
  return env;
}

class PtyManager {
  constructor() {
    this.sessions = new Map();
    this.nextId = 1;
  }

  create({ cwd, cols, rows, command }, onData, onExit) {
    const id = this.nextId++;
    const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
    const argv = command ? [shell, '-lc', command] : [shell, '-l'];

    const proc = spawn('python3', [HELPER, String(cols), String(rows), ...argv], {
      cwd: cwd || os.homedir(),
      env: shellEnv(),
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });

    // setEncoding keeps multi-byte characters split across chunks intact
    // (decoding each Buffer on its own turns them into U+FFFD).
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    const session = { proc, cwd, buffer: '', timer: null, unacked: 0, paused: false };
    // Output is coalesced into one message every few ms (a busy command
    // prints thousands of small chunks) and flushed right away past 64 KB.
    const flush = () => {
      clearTimeout(session.timer);
      session.timer = null;
      if (!session.buffer) return;
      const text = session.buffer;
      session.buffer = '';
      session.unacked += text.length;
      onData(id, text);
      // Flow control: stop reading while the terminal is far behind.
      if (session.unacked > HIGH_WATER && !session.paused) this.setPaused(session, true);
    };
    const push = (text) => {
      session.buffer += text;
      if (session.buffer.length >= FLUSH_SIZE) flush();
      else if (!session.timer) session.timer = setTimeout(flush, FLUSH_MS);
    };
    proc.stdout.on('data', push);
    proc.stderr.on('data', push);
    proc.on('exit', (code) => {
      flush();
      this.sessions.delete(id);
      onExit(id, code);
    });

    this.sessions.set(id, session);
    return id;
  }

  // The renderer confirms how much output xterm has processed.
  ack(id, chars) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.unacked = Math.max(0, s.unacked - chars);
    if (s.paused && s.unacked < LOW_WATER) this.setPaused(s, false);
  }

  setPaused(s, paused) {
    s.paused = paused;
    for (const stream of [s.proc.stdout, s.proc.stderr]) {
      if (paused) stream.pause();
      else stream.resume();
    }
  }

  write(id, data) {
    this.sessions.get(id)?.proc.stdin.write(data);
  }

  resize(id, cols, rows) {
    this.sessions.get(id)?.proc.stdio[3].write(`${cols} ${rows}\n`);
  }

  // Current working directory of the shell (Linux: /proc, macOS: lsof).
  // Asynchronous: this runs often and must not block the main process.
  async cwd(id) {
    const s = this.sessions.get(id);
    if (!s) return null;
    try {
      // The shell is the only child of the python helper; its pid never changes.
      if (!s.shellPid) {
        const { stdout } = await execFileAsync('pgrep', ['-P', String(s.proc.pid)]);
        s.shellPid = stdout.trim().split('\n')[0];
      }
      const shellPid = s.shellPid;
      if (process.platform === 'linux') return await fs.promises.readlink(`/proc/${shellPid}/cwd`);
      const { stdout: out } = await execFileAsync('lsof', ['-a', '-p', shellPid, '-d', 'cwd', '-Fn']);
      return out.split('\n').find((l) => l.startsWith('n'))?.slice(1) || s.cwd;
    } catch {
      return s.cwd;
    }
  }

  kill(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.paused) this.setPaused(s, false); // nobody will ack any more: let it drain and exit
    s.proc.kill('SIGHUP');
  }

  killAll() {
    for (const { proc } of this.sessions.values()) proc.kill('SIGHUP');
  }
}

module.exports = { PtyManager };

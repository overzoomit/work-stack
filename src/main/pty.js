// PtyManager: one shell per terminal, bridged through pty-helper.py
// (no native modules, works on Linux and macOS).
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HELPER = path.join(__dirname, 'pty-helper.py');
const execFileAsync = promisify(execFile);

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
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });

    // setEncoding keeps multi-byte characters split across chunks intact
    // (decoding each Buffer on its own turns them into U+FFFD).
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (text) => onData(id, text));
    proc.stderr.on('data', (text) => onData(id, text));
    proc.on('exit', (code) => {
      this.sessions.delete(id);
      onExit(id, code);
    });

    this.sessions.set(id, { proc, cwd });
    return id;
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
    this.sessions.get(id)?.proc.kill('SIGHUP');
  }

  killAll() {
    for (const { proc } of this.sessions.values()) proc.kill('SIGHUP');
  }
}

module.exports = { PtyManager };

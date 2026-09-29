// Live Claude Code processes. Claude Code writes ~/.claude/sessions/<pid>.json
// while it runs ({ pid, sessionId, procStart, ... }) and removes it on exit:
// the only reliable way to tell a session that is still open from one whose
// transcript simply hasn't been written for a while.
const fs = require('fs');
const os = require('os');
const path = require('path');

const SESSIONS_DIR = process.env.WORK_CLAUDE_SESSIONS || path.join(os.homedir(), '.claude', 'sessions');

// Start time of a process in clock ticks since boot (field 22 of
// /proc/<pid>/stat), as Claude Code records it in procStart. null off Linux.
function procStart(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } catch {
    return null;
  }
}

// Alive, and still the same process: a pid can be reused after Claude exits
// without removing its file (crash, kill -9).
function alive(entry) {
  try {
    process.kill(entry.pid, 0);
  } catch (e) {
    if (e.code !== 'EPERM') return false;
  }
  const start = procStart(entry.pid);
  return !entry.procStart || start === null || start === String(entry.procStart);
}

// false when this Claude Code version doesn't keep the folder: then nothing
// can be said about which sessions are open.
function tracked() {
  try {
    return fs.statSync(SESSIONS_DIR).isDirectory();
  } catch {
    return false;
  }
}

// sessionId -> { pid, procStart } for every Claude Code process still running.
function live() {
  const map = new Map();
  let files = [];
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => /^\d+\.json$/.test(f));
  } catch {
    return map;
  }
  for (const f of files) {
    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
    } catch {
      continue; // being written or removed right now
    }
    if (!Number.isInteger(entry?.pid) || entry.pid <= 1 || typeof entry.sessionId !== 'string') continue;
    if (String(entry.pid) !== f.slice(0, -5)) continue; // the file name is the pid
    if (alive(entry)) map.set(entry.sessionId, { pid: entry.pid, procStart: entry.procStart });
  }
  return map;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Close a session's Claude Code process: SIGTERM lets it exit cleanly (the
// transcript stays resumable); if it's still there after `grace` ms, SIGKILL.
async function stop(sessionId, { grace = 3000 } = {}) {
  const entry = live().get(sessionId);
  if (!entry) throw new Error('La sessione non è più aperta');
  process.kill(entry.pid, 'SIGTERM');
  for (let t = 0; t < grace; t += 100) {
    await sleep(100);
    if (!alive(entry)) return;
  }
  try {
    process.kill(entry.pid, 'SIGKILL');
  } catch {
    // exited between the last check and now
  }
}

module.exports = { SESSIONS_DIR, live, tracked, stop, procStart };

// AgentWatcher: follows Claude Code session transcripts
// (~/.claude/projects/<project>/<session>.jsonl) and turns them into a
// live picture of what each agent is doing.
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const os = require('os');
const procs = require('./claudeprocs');

const PROJECTS_DIR = process.env.WORK_CLAUDE_PROJECTS || path.join(os.homedir(), '.claude', 'projects');
const WINDOW_MS = 24 * 3600 * 1000; // sessions touched in the last 24h
const TAIL_BYTES = 256 * 1024;
const MAX_EVENTS = 60;
// Claude Code names transcripts <session-uuid>.jsonl. The id ends up in a
// shell command ("claude --resume <id>"), so anything else is ignored.
const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

// The most telling field of a tool call's input, in order of preference.
const SUMMARY_FIELDS = ['command', 'file_path', 'pattern', 'url', 'description', 'prompt'];

function summarizeInput(input = {}) {
  const field = SUMMARY_FIELDS.find((f) => input[f]);
  if (field) return input[field];
  const s = JSON.stringify(input);
  return s.length > 2 ? s : '';
}

// First n characters without cutting an emoji (a surrogate pair) in half.
function clip(s, n) {
  const c = s.slice(0, n);
  return /[\uD800-\uDBFF]$/.test(c) ? c.slice(0, -1) : c;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

// The permission mode is written once per turn: a long autonomous run can
// push it out of the tail read at start. Look for its last value before
// `end`, reading backwards in blocks.
const MODE = /"permissionMode":"(\w+)"/g;
function lastModeBefore(file, end) {
  const BLOCK = 1024 * 1024;
  const fd = fs.openSync(file, 'r');
  try {
    for (let pos = end; pos > 0; pos -= BLOCK) {
      const start = Math.max(0, pos - BLOCK);
      const buf = Buffer.alloc(Math.min(end, pos + 64) - start); // overlap: a match cut at a block edge
      fs.readSync(fd, buf, 0, buf.length, start);
      const found = [...buf.toString('latin1').matchAll(MODE)].pop();
      if (found) return found[1];
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

class Session {
  constructor(file) {
    this.file = file;
    this.id = path.basename(file, '.jsonl');
    this.offset = 0;
    this.partial = '';
    // Keeps a multi-byte character cut by a read in the middle of a write.
    this.decoder = new StringDecoder('utf8');
    this.events = [];
    this.eventSeq = 0; // grows with every event, even once the list is capped
    this.cwd = null;
    this.title = null;
    this.lastKind = null; // user | assistant-tool | assistant-end | tool-result
    this.lastTool = null;
    this.mtime = 0;
    this.tokens = 0;
    this.permissionMode = null;
  }

  read() {
    const st = fs.statSync(this.file);
    if (st.size < this.offset) {
      // Truncated / rewritten: start over, dropping the half line read before.
      this.offset = 0;
      this.partial = '';
      this.decoder = new StringDecoder('utf8');
    }
    if (st.size === this.offset) return false;
    let skipped = 0;
    if (this.offset === 0 && st.size > TAIL_BYTES) this.offset = skipped = st.size - TAIL_BYTES;

    const fd = fs.openSync(this.file, 'r');
    const buf = Buffer.alloc(st.size - this.offset);
    fs.readSync(fd, buf, 0, buf.length, this.offset);
    fs.closeSync(fd);
    this.offset = st.size;
    this.mtime = st.mtimeMs;

    const lines = (this.partial + this.decoder.write(buf)).split('\n');
    this.partial = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        this.ingest(JSON.parse(line));
      } catch {
        // first line of a tail read may be cut in half
      }
    }
    if (skipped && !this.permissionMode) this.permissionMode = lastModeBefore(this.file, skipped);
    return true;
  }

  push(ev) {
    this.eventSeq++;
    this.events.push(ev);
    if (this.events.length > MAX_EVENTS) this.events.shift();
  }

  ingest(e) {
    if (e.cwd) this.cwd = e.cwd;
    // "permission-mode" entries (and user messages) carry the session's mode.
    if (e.permissionMode) this.permissionMode = e.permissionMode;
    // Title priority: explicit agent name > AI title > first prompt
    if (e.type === 'agent-name' && e.agentName) this.agentName = e.agentName;
    if (e.type === 'ai-title' && e.aiTitle) this.aiTitle = e.aiTitle;
    if (e.type === 'last-prompt' && e.lastPrompt && !this.title) this.title = clip(e.lastPrompt, 80);
    const ts = e.timestamp ? Date.parse(e.timestamp) : Date.now();
    const msg = e.message;
    if (!msg || e.isSidechain) return;

    if (e.type === 'user') {
      const content = msg.content;
      // Esc / Ctrl+C in Claude Code: the turn is over and it waits for you.
      if (textOf(content).startsWith('[Request interrupted by user')) {
        this.lastKind = 'assistant-end';
        return;
      }
      if (Array.isArray(content) && content.some((c) => c.type === 'tool_result')) {
        const r = content.find((c) => c.type === 'tool_result');
        this.lastKind = 'tool-result';
        if (r.is_error) this.push({ ts, kind: 'error', text: clip(textOf(r.content), 300) || 'errore tool' });
        return;
      }
      const text = textOf(content).trim();
      if (!text || text.startsWith('<')) return; // system reminders, command wrappers
      if (!this.title) this.title = clip(text, 80);
      this.lastKind = 'user';
      this.push({ ts, kind: 'user', text: clip(text, 400) });
      return;
    }

    if (e.type === 'assistant') {
      const u = msg.usage;
      if (u) this.tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
      for (const c of msg.content || []) {
        if (c.type === 'text' && c.text.trim()) {
          this.push({ ts, kind: 'text', text: clip(c.text.trim(), 400) });
        } else if (c.type === 'tool_use') {
          this.lastTool = c.name;
          this.push({ ts, kind: 'tool', tool: c.name, text: clip(summarizeInput(c.input), 300) });
        }
      }
      if (msg.stop_reason === 'tool_use') this.lastKind = 'assistant-tool';
      else if (msg.stop_reason === 'end_turn') this.lastKind = 'assistant-end';
    }
  }

  get status() {
    const idle = Date.now() - this.mtime;
    if (idle > 10 * 60 * 1000) return { state: 'idle', label: 'Inattivo' };
    if (this.lastKind === 'assistant-end') return { state: 'waiting', label: 'Attende il tuo input' };
    if (this.lastKind === 'assistant-tool') {
      // A tool call with no result for a while usually means a permission
      // prompt, unless permissions are bypassed: then it's just a long tool.
      if (idle > 15000 && this.permissionMode !== 'bypassPermissions') {
        return { state: 'blocked', label: `Attende permesso: ${this.lastTool}` };
      }
      return { state: 'working', label: `Esegue ${this.lastTool}` };
    }
    return { state: 'working', label: 'Sta ragionando…' };
  }

  // open: true/false when Claude Code says whether the process is running,
  // null when it can't be known (older versions without ~/.claude/sessions).
  toJSON(open = null) {
    let status = this.status;
    // A closed session is not working nor waiting, whatever its transcript says.
    if (open === false && status.state !== 'idle') status = { state: 'idle', label: 'Chiusa' };
    return {
      id: this.id,
      cwd: this.cwd,
      project: this.cwd ? path.basename(this.cwd) : path.basename(path.dirname(this.file)),
      title: this.agentName || this.aiTitle || this.title || 'Sessione',
      mtime: this.mtime,
      tokens: this.tokens,
      status,
      live: open === true,
      // Events stay out of the list (it goes to the UI several times a second);
      // the detail view asks for them with events(id) when eventSeq moves.
      eventSeq: this.eventSeq,
    };
  }
}

// Event-driven: inotify/FSEvents tell us which transcript changed, so idle
// cost is ~zero. A full scan runs once at start and every 60 s as a safety
// net (missed events, new project folders); a light 10 s tick only refreshes
// time-based states ("Inattivo", "Attende permesso") without touching disk.
class AgentWatcher {
  constructor(onUpdate) {
    this.onUpdate = onUpdate;
    this.sessions = new Map();
    this.watchers = new Map(); // dir -> FSWatcher
    this.timers = [];
    this.dirty = new Set();
    this.flushTimer = null;
    this.lastStates = '';
  }

  start() {
    this.scan();
    this.emit();
    this.watchRoot();
    this.watchProcs();
    this.started = true;
    this.timers.push(setInterval(() => {
      this.prune();
      this.scan();
      this.emit();
    }, 60000));
    this.timers.push(setInterval(() => this.emitIfStatesChanged(), 10000));
  }

  stop() {
    this.timers.forEach(clearInterval);
    clearTimeout(this.flushTimer); // a burst still being coalesced must not emit after stop
    clearTimeout(this.procsTimer);
    this.flushTimer = null;
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
  }

  // Claude Code adds/removes ~/.claude/sessions/<pid>.json as sessions open
  // and close: refresh "Chiusa" and the close button without waiting a tick.
  watchProcs() {
    try {
      const w = fs.watch(procs.SESSIONS_DIR, () => {
        clearTimeout(this.procsTimer);
        this.procsTimer = setTimeout(() => this.emitIfStatesChanged(), 300);
      });
      w.on('error', () => {});
      this.watchers.set(procs.SESSIONS_DIR, w);
    } catch {
      // folder missing: the 10 s tick still notices
    }
  }

  watchRoot() {
    try {
      const w = fs.watch(PROJECTS_DIR, () => this.watchDirs());
      w.on('error', () => {});
      this.watchers.set(PROJECTS_DIR, w);
    } catch {
      // no ~/.claude/projects yet: the 60 s scan will pick it up
    }
    this.watchDirs();
  }

  watchDirs() {
    let dirs = [];
    try {
      dirs = fs.readdirSync(PROJECTS_DIR);
    } catch {
      return;
    }
    for (const d of dirs) {
      const dir = path.join(PROJECTS_DIR, d);
      if (this.watchers.has(dir)) continue;
      try {
        const w = fs.watch(dir, (_ev, name) => {
          if (name && SESSION_FILE.test(name)) this.touch(path.join(dir, name));
        });
        w.on('error', () => {
          w.close();
          this.watchers.delete(dir);
        });
        this.watchers.set(dir, w);
      } catch {
        continue; // not a directory or vanished
      }
      // A project folder that appeared after start may already hold a session
      // written before its watcher existed: read it now, not at its next write.
      if (!this.started) continue;
      try {
        for (const f of fs.readdirSync(dir)) if (SESSION_FILE.test(f)) this.touch(path.join(dir, f));
      } catch {
        // vanished right after appearing
      }
    }
  }

  // Coalesce bursts of writes (a streaming reply writes many lines) into one update.
  touch(file) {
    this.dirty.add(file);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const files = [...this.dirty];
      this.dirty.clear();
      let changed = false;
      for (const f of files) changed = this.readFile(f) || changed;
      if (changed) this.emit();
    }, 250);
  }

  readFile(file) {
    let s = this.sessions.get(file);
    if (!s) {
      s = new Session(file);
      this.sessions.set(file, s);
    }
    try {
      return s.read();
    } catch (e) {
      if (e.code !== 'ENOENT') return false;
      this.sessions.delete(file); // transcript deleted: drop the session
      return true;
    }
  }

  scan() {
    const now = Date.now();
    let dirs = [];
    try {
      dirs = fs.readdirSync(PROJECTS_DIR);
    } catch {
      return;
    }
    for (const d of dirs) {
      const dir = path.join(PROJECTS_DIR, d);
      let files = [];
      try {
        files = fs.readdirSync(dir).filter((f) => SESSION_FILE.test(f));
      } catch {
        continue;
      }
      for (const f of files) {
        const file = path.join(dir, f);
        try {
          if (now - fs.statSync(file).mtimeMs > WINDOW_MS) continue;
        } catch {
          continue;
        }
        this.readFile(file);
      }
    }
    this.watchDirs();
  }

  emit() {
    const list = this.list();
    this.lastStates = stateKey(list);
    this.onUpdate(list);
  }

  emitIfStatesChanged() {
    const states = stateKey(this.list());
    if (states !== this.lastStates) this.emit();
  }

  // The same id can live in two project folders (a session resumed elsewhere):
  // the most recently written one is the one the list shows as active.
  events(id) {
    let best = null;
    for (const s of this.sessions.values()) if (s.id === id && (!best || s.mtime > best.mtime)) best = s;
    return best ? best.events : [];
  }

  // Sessions untouched for longer than the window are dropped, so the map
  // (and the list sent to the UI) doesn't grow while the app stays open.
  prune() {
    const cutoff = Date.now() - WINDOW_MS;
    for (const [file, s] of this.sessions) if (s.mtime && s.mtime < cutoff) this.sessions.delete(file);
  }

  list() {
    const cutoff = Date.now() - WINDOW_MS;
    const open = procs.tracked() ? procs.live() : null;
    return [...this.sessions.values()]
      .filter((s) => s.events.length && s.mtime >= cutoff)
      .sort((a, b) => b.mtime - a.mtime)
      .map((s) => s.toJSON(open ? open.has(s.id) : null));
  }
}

const stateKey = (list) => list.map((a) => `${a.status.state}:${a.status.label}:${a.live}`).join();

module.exports = { AgentWatcher, Session, SESSION_FILE };

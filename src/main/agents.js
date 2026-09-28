// AgentWatcher: follows Claude Code session transcripts
// (~/.claude/projects/<project>/<session>.jsonl) and turns them into a
// live picture of what each agent is doing.
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS_DIR = process.env.WORK_CLAUDE_PROJECTS || path.join(os.homedir(), '.claude', 'projects');
const WINDOW_MS = 24 * 3600 * 1000; // sessions touched in the last 24h
const TAIL_BYTES = 256 * 1024;
const MAX_EVENTS = 60;
// Claude Code names transcripts <session-uuid>.jsonl. The id ends up in a
// shell command ("claude --resume <id>"), so anything else is ignored.
const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

function summarizeInput(name, input = {}) {
  if (input.command) return input.command;
  if (input.file_path) return input.file_path;
  if (input.pattern) return input.pattern;
  if (input.url) return input.url;
  if (input.description) return input.description;
  if (input.prompt) return input.prompt;
  const s = JSON.stringify(input);
  return s.length > 2 ? s : '';
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

class Session {
  constructor(file) {
    this.file = file;
    this.id = path.basename(file, '.jsonl');
    this.offset = 0;
    this.partial = '';
    this.events = [];
    this.cwd = null;
    this.title = null;
    this.lastKind = null; // user | assistant-tool | assistant-end | tool-result
    this.lastTool = null;
    this.mtime = 0;
    this.tokens = 0;
  }

  read() {
    const st = fs.statSync(this.file);
    if (st.size < this.offset) this.offset = 0; // truncated / rewritten
    if (st.size === this.offset) return false;
    if (this.offset === 0 && st.size > TAIL_BYTES) this.offset = st.size - TAIL_BYTES;

    const fd = fs.openSync(this.file, 'r');
    const buf = Buffer.alloc(st.size - this.offset);
    fs.readSync(fd, buf, 0, buf.length, this.offset);
    fs.closeSync(fd);
    this.offset = st.size;
    this.mtime = st.mtimeMs;

    const lines = (this.partial + buf.toString('utf8')).split('\n');
    this.partial = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        this.ingest(JSON.parse(line));
      } catch {
        // first line of a tail read may be cut in half
      }
    }
    return true;
  }

  push(ev) {
    this.events.push(ev);
    if (this.events.length > MAX_EVENTS) this.events.shift();
  }

  ingest(e) {
    if (e.cwd) this.cwd = e.cwd;
    // Title priority: explicit agent name > AI title > first prompt
    if (e.type === 'agent-name' && e.agentName) this.agentName = e.agentName;
    if (e.type === 'ai-title' && e.aiTitle) this.aiTitle = e.aiTitle;
    if (e.type === 'last-prompt' && e.lastPrompt && !this.title) this.title = e.lastPrompt.slice(0, 80);
    const ts = e.timestamp ? Date.parse(e.timestamp) : Date.now();
    const msg = e.message;
    if (!msg || e.isSidechain) return;

    if (e.type === 'user') {
      const content = msg.content;
      if (Array.isArray(content) && content.some((c) => c.type === 'tool_result')) {
        const r = content.find((c) => c.type === 'tool_result');
        this.lastKind = 'tool-result';
        if (r.is_error) this.push({ ts, kind: 'error', text: textOf(r.content).slice(0, 300) || 'errore tool' });
        return;
      }
      const text = textOf(content).trim();
      if (!text || text.startsWith('<')) return; // system reminders, command wrappers
      if (!this.title) this.title = text.slice(0, 80);
      this.lastKind = 'user';
      this.push({ ts, kind: 'user', text: text.slice(0, 400) });
      return;
    }

    if (e.type === 'assistant') {
      const u = msg.usage;
      if (u) this.tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
      for (const c of msg.content || []) {
        if (c.type === 'text' && c.text.trim()) {
          this.push({ ts, kind: 'text', text: c.text.trim().slice(0, 400) });
        } else if (c.type === 'tool_use') {
          this.lastTool = c.name;
          this.push({ ts, kind: 'tool', tool: c.name, text: summarizeInput(c.name, c.input).slice(0, 300) });
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
      // A tool call with no result for a while usually means a permission prompt.
      if (idle > 15000) return { state: 'blocked', label: `Attende permesso: ${this.lastTool}` };
      return { state: 'working', label: `Esegue ${this.lastTool}` };
    }
    return { state: 'working', label: 'Sta ragionando…' };
  }

  toJSON() {
    return {
      id: this.id,
      cwd: this.cwd,
      project: this.cwd ? path.basename(this.cwd) : path.basename(path.dirname(this.file)),
      title: this.agentName || this.aiTitle || this.title || 'Sessione',
      mtime: this.mtime,
      tokens: this.tokens,
      status: this.status,
      events: this.events,
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
    this.timers.push(setInterval(() => {
      this.scan();
      this.emit();
    }, 60000));
    this.timers.push(setInterval(() => this.emitIfStatesChanged(), 10000));
  }

  stop() {
    this.timers.forEach(clearInterval);
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
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
        // not a directory or vanished
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
    } catch {
      return false; // vanished between event and read
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
    this.lastStates = list.map((a) => a.status.state).join();
    this.onUpdate(list);
  }

  emitIfStatesChanged() {
    const states = this.list().map((a) => a.status.state).join();
    if (states !== this.lastStates) this.emit();
  }

  list() {
    return [...this.sessions.values()]
      .filter((s) => s.events.length)
      .sort((a, b) => b.mtime - a.mtime)
      .map((s) => s.toJSON());
  }
}

module.exports = { AgentWatcher };

// Command palette (Ctrl/Cmd+K): one field for project files, Git branches and
// actions, agent/tmux windows and quick commands. The sources arrive
// asynchronously from hooks that app.js wires to the rest of the app; ranking
// and painting stay in the page, so typing never waits for a backend call.
import { esc, leave, toastError } from './ui.js';
import { AGENTS } from './agentcatalog.js';

const MAX_FILES = 5000;
const MAX_ROWS = 80;
// With an empty field a handful from each category is enough to orient.
const EMPTY_LIMIT = { command: 8, file: 6, git: 8, agent: 8, ticket: 5 };
const CATEGORIES = {
  command: { label: 'Commands', cls: 'command' },
  file: { label: 'Files', cls: 'file' },
  git: { label: 'Git', cls: 'git' },
  agent: { label: 'Agents', cls: 'agent' },
  ticket: { label: 'Tickets', cls: 'ticket' },
};
const ORDER = ['command', 'file', 'git', 'agent', 'ticket'];
const BOUNDARY = new Set([' ', '/', '\\', ':', '.', '_', '-', '(', '[', '@', '+', ',']);
const AGENT_ALIASES = new Set(['agent', 'agente', 'agents', 'agenti']);

const noop = () => {};
let hooks = {
  defaultAgent: () => AGENTS[0],
  files: async () => [],
  branches: async () => [],
  windows: async () => [],
  tickets: async () => [],
  openFile: noop,
  checkout: noop,
  gitAction: noop,
  focusWindow: noop,
  newTerminal: noop,
  launchAgent: noop,
  split: noop,
  ngrok: noop,
  openTicket: noop,
};

// app.js injects the project-aware actions; tests inject fakes.
export function initPalette(h = {}) {
  hooks = { ...hooks, ...h };
}

// ── Fuzzy matching ──────────────────────────────────────────
// A subsequence, rewarded for word starts and runs. The label is the primary
// target; the detail and keywords are fallbacks, so "@codex" can find a
// command whose label does not contain the agent id.
export function fuzzyScore(query, text) {
  const q = String(query ?? '').toLowerCase().replace(/\s+/g, '');
  if (!q) return null;
  const t = String(text ?? '').toLowerCase();
  if (!t) return null;
  const positions = [];
  let from = 0;
  for (const c of q) {
    const i = t.indexOf(c, from);
    if (i < 0) return null;
    positions.push(i);
    from = i + 1;
  }
  let score = 0;
  positions.forEach((i, k) => {
    score += 1;
    if (i === 0 || BOUNDARY.has(t[i - 1])) score += 6;
    if (k && positions[k - 1] === i - 1) score += 4;
    else if (k) score -= Math.min(3, (i - positions[k - 1] - 1) * 0.15);
  });
  if (positions[0] === 0) score += 3;
  score -= t.length * 0.01;
  return { score, positions };
}

function match(query, entry) {
  const label = fuzzyScore(query, entry.label);
  if (label) return { ...entry, score: label.score + 3, positions: label.positions };
  const detail = entry.detail && fuzzyScore(query, entry.detail);
  if (detail) return { ...entry, score: detail.score, positions: null };
  const keywords = entry.keywords && fuzzyScore(query, entry.keywords);
  if (keywords) return { ...entry, score: keywords.score - 2, positions: null };
  return null;
}

export function rank(query, entries) {
  if (!String(query ?? '').trim()) return entries.slice(0, MAX_ROWS);
  return entries
    .map((e) => match(query, e))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.label.length - b.label.length)
    .slice(0, MAX_ROWS);
}

export function highlight(text, positions) {
  const on = new Set(positions || []);
  return [...String(text)].map((c, i) => (on.has(i) ? `<b>${esc(c)}</b>` : esc(c))).join('');
}

// ── Quick command syntax ────────────────────────────────────
// "@agente <prompt>" (or any agent id) starts an agent; "/split" and "/ngrok"
// run the matching command. Everything else is a plain fuzzy search.
export function parseCommand(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;
  if (text === '/split' || text.startsWith('/split ')) return { type: 'split', text };
  if (text === '/ngrok' || text.startsWith('/ngrok ')) return { type: 'ngrok', text };
  if (!text.startsWith('@')) return null;
  const m = text.match(/^@([^\s]*)(?:\s+([\s\S]*))?$/);
  const name = (m?.[1] || '').toLowerCase();
  const prompt = (m?.[2] || '').trim();
  const agent = AGENTS.find((a) => a.id === name || a.bin === name || a.name.toLowerCase() === name) || null;
  if (agent || AGENT_ALIASES.has(name) || !name) return { type: 'agent', agent, prompt, text };
  return null;
}

function commandEntry(parsed) {
  if (parsed.type === 'split') {
    return {
      kind: 'command', label: 'Split the focused terminal', detail: '/split',
      keywords: 'split pane terminal dividi', action: (project) => hooks.split(project),
    };
  }
  if (parsed.type === 'ngrok') {
    return {
      kind: 'command', label: 'Open the ngrok tunnel', detail: '/ngrok',
      keywords: 'tunnel public url', action: (project) => hooks.ngrok(project),
    };
  }
  const agent = parsed.agent || (hooks.defaultAgent?.() || AGENTS[0]);
  const prompt = parsed.prompt;
  return {
    kind: 'command',
    label: prompt ? `Start ${agent.name}: ${prompt}` : `Start ${agent.name}`,
    detail: prompt ? 'send this prompt' : 'new agent terminal',
    keywords: `agent agente ${agent.id} ${agent.bin || ''}`,
    action: (project) => hooks.launchAgent(project, prompt, agent.id),
  };
}

function baseCommands() {
  return [
    {
      kind: 'command', label: 'Start an agent with a prompt', detail: '@agent <prompt>',
      keywords: '@agent agente claude codex opencode', action: (project) => hooks.launchAgent(project, '', null),
    },
    {
      kind: 'command', label: 'Split the focused terminal', detail: '/split',
      keywords: 'split pane terminal dividi', action: (project) => hooks.split(project),
    },
    {
      kind: 'command', label: 'Open the ngrok tunnel', detail: '/ngrok',
      keywords: 'tunnel public url', action: (project) => hooks.ngrok(project),
    },
    {
      kind: 'command', label: 'New terminal', detail: 'Ctrl+Shift+T',
      keywords: 'shell bash zsh', action: (project) => hooks.newTerminal(project),
    },
  ];
}

const GIT_ACTIONS = [
  ['fetch', 'Fetch'],
  ['pull', 'Pull (ff-only)'],
  ['push', 'Push'],
  ['stageAll', 'Stage all changes'],
  ['stash', 'Stash changes'],
  ['stashPop', 'Restore stashed changes'],
];

function gitActions() {
  return GIT_ACTIONS.map(([name, label]) => ({
    kind: 'git', label, detail: `git ${name}`, keywords: `git ${name}`,
    action: (project) => hooks.gitAction(project, name),
  }));
}

function branchEntries(branches) {
  return (branches || []).map((b) => ({
    kind: 'git',
    label: b.name,
    detail: b.current ? 'current branch' : b.remote ? 'remote branch' : 'branch',
    keywords: `branch ${b.name}`,
    current: !!b.current,
    action: (project) => hooks.checkout(project, b.name),
  }));
}

function fileEntries(files) {
  return (files || []).slice(0, MAX_FILES).map((path) => {
    const at = path.lastIndexOf('/') + 1;
    return {
      kind: 'file',
      label: path.slice(at),
      detail: path.slice(0, Math.max(0, at - 1)),
      keywords: path,
      path,
      action: (project) => hooks.openFile(project, path),
    };
  });
}

function windowEntries(windows) {
  return (windows || []).map((w) => ({
    kind: 'agent',
    label: w.name || 'window',
    detail: w.detail || (w.kind === 'agent' ? 'agent window' : 'terminal window'),
    keywords: `${w.name || ''} ${w.detail || ''} ${w.kind || ''}`,
    window: w,
    action: (project) => hooks.focusWindow(project, w),
  }));
}

function ticketEntries(tickets) {
  return (tickets || []).map((t) => ({
    kind: 'ticket',
    label: `#${t.issue ?? '?'} ${t.name || ''}`.trim(),
    detail: t.state || 'ticket',
    keywords: `ticket plane ${t.issue ?? ''} ${t.name || ''}`,
    ticket: t,
    action: (project) => hooks.openTicket(project, t),
  }));
}

// ── Palette ─────────────────────────────────────────────────

let s = null; // the open palette: { project, el, veil, input, list, foot, ... }
// Monotone across every open: a response from a palette that was closed (or
// replaced by another project) can never match the current token.
let generation = 0;

export const paletteOpen = () => !!s;

export function openPalette(project) {
  if (!project) return;
  if (s) {
    s.input.focus();
    return;
  }
  const veil = document.createElement('div');
  veil.className = 'palette-veil';
  const el = document.createElement('div');
  el.className = 'palette';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', 'Command palette');
  el.innerHTML = `
    <div class="palette-head">
      <span class="palette-icon" aria-hidden="true">⌘</span>
      <input class="palette-input" role="combobox" aria-expanded="true" aria-controls="palette-list"
        aria-autocomplete="list" spellcheck="false" autocomplete="off"
        placeholder="Search files, branches, agents or type a command…">
      <kbd class="palette-esc">esc</kbd>
    </div>
    <ul class="palette-list" id="palette-list" role="listbox"></ul>
    <footer class="palette-foot"></footer>`;
  document.body.appendChild(veil);
  document.body.appendChild(el);
  const input = el.querySelector('.palette-input');
  input.value = '';
  s = {
    project,
    el,
    veil,
    input,
    list: el.querySelector('.palette-list'),
    foot: el.querySelector('.palette-foot'),
    back: document.activeElement,
    sel: 0,
    groups: [],
    rows: [],
    sources: {
      command: baseCommands(),
      file: [],
      git: project.root ? gitActions() : [],
      agent: [],
      ticket: [],
    },
    loading: { file: !project.remote, git: !!project.root, agent: true, ticket: true },
    errors: [],
    token: ++generation,
  };
  input.oninput = () => {
    if (!s) return;
    s.sel = 0;
    apply();
  };
  el.onkeydown = onKey;
  s.list.onpointermove = (e) => {
    const li = e.target?.closest?.('.palette-row');
    if (!li || !s) return;
    const i = Number(li.dataset.i);
    if (i !== s.sel) {
      s.sel = i;
      paint();
    }
  };
  s.list.onclick = (e) => {
    const li = e.target?.closest?.('.palette-row');
    if (li) run(Number(li.dataset.i));
  };
  veil.onpointerdown = () => closePalette();
  apply();
  input.focus();
  loadSources(project, s.token);
}

function loadSources(project, token) {
  const alive = () => !!s && s.token === token;
  const done = (kind, update) => {
    if (!alive()) return;
    update();
    s.loading[kind] = false;
    apply();
  };
  const failed = (kind, e) => {
    if (!alive()) return;
    s.loading[kind] = false;
    s.errors.push(`${CATEGORIES[kind].label}: ${e?.message || e}`);
    apply();
  };

  if (!project.remote) {
    Promise.resolve()
      .then(() => hooks.files(project))
      .then((files) => done('file', () => { s.sources.file = fileEntries(files); }), (e) => failed('file', e));
  }
  Promise.resolve()
    .then(() => (project.root ? hooks.branches(project) : []))
    .then((branches) => done('git', () => {
      s.sources.git = project.root ? [...gitActions(), ...branchEntries(branches)] : [];
    }), (e) => failed('git', e));
  Promise.resolve()
    .then(() => hooks.windows(project))
    .then((windows) => done('agent', () => { s.sources.agent = windowEntries(windows); }), (e) => failed('agent', e));
  Promise.resolve()
    .then(() => hooks.tickets(project))
    .then((tickets) => done('ticket', () => { s.sources.ticket = ticketEntries(tickets); }), (e) => failed('ticket', e));
}

function apply() {
  if (!s) return;
  const query = String(s.input.value ?? '');
  const parsed = parseCommand(query);
  const groups = [];
  if (parsed) groups.push({ kind: 'command', entries: [commandEntry(parsed)], dynamic: true });
  for (const kind of ORDER) {
    let list = s.sources[kind] || [];
    // The dynamic row already represents the command being typed.
    if (parsed) {
      const prefix = parsed.type === 'agent' ? '@' : `/${parsed.type}`;
      list = list.filter((e) => !(e.kind === 'command' && String(e.detail || '').toLowerCase().startsWith(prefix)));
    }
    list = query.trim() ? rank(query, list) : list.slice(0, EMPTY_LIMIT[kind]);
    if (list.length) groups.push({ kind, entries: list });
  }
  s.groups = groups;
  s.rows = groups.flatMap((g) => g.entries);
  s.sel = Math.min(s.sel, Math.max(0, s.rows.length - 1));
  paint();
}

function paint() {
  if (!s) return;
  const { rows, groups, sel } = s;
  let i = 0;
  if (!rows.length) {
    const loading = Object.values(s.loading).some(Boolean);
    const query = String(s.input.value ?? '').trim();
    s.list.innerHTML = `<li class="palette-empty" role="presentation">${
      loading ? 'Loading…' : query ? `No results for “${esc(query)}”.` : 'Nothing to show here.'
    }</li>`;
  } else {
    s.list.innerHTML = groups.map((g) => {
      const cat = CATEGORIES[g.kind];
      return `<li class="palette-group" role="presentation">
          <span class="palette-cat ${cat.cls}">${cat.label}</span>
          <span class="palette-count">${g.entries.length}</span>
        </li>${g.entries.map((e) => {
          const idx = i++;
          return `<li class="palette-row${idx === sel ? ' sel' : ''}" role="option" id="palette-row-${idx}" data-i="${idx}" aria-selected="${idx === sel}">
            <span class="palette-name">${e.positions ? highlight(e.label, e.positions) : esc(e.label)}</span>
            ${e.detail ? `<span class="palette-detail" title="${esc(e.detail)}">${esc(e.detail)}</span>` : ''}
            ${e.current ? '<span class="palette-tag">current</span>' : ''}
          </li>`;
        }).join('')}`;
    }).join('');
  }
  s.input.setAttribute('aria-activedescendant', rows.length ? `palette-row-${sel}` : '');
  const loading = Object.values(s.loading).filter(Boolean).length;
  const count = rows.length;
  const unavailable = s.errors.length;
  s.foot.innerHTML = `<span>${count} ${count === 1 ? 'result' : 'results'}${loading ? ` · loading ${loading} more` : ''}${unavailable ? ` · ${unavailable} source${unavailable === 1 ? '' : 's'} unavailable` : ''}</span>
    <span class="palette-keys"><kbd>↑</kbd><kbd>↓</kbd> move <kbd>↵</kbd> run <kbd>esc</kbd> close</span>`;
  s.list.querySelector?.(`#palette-row-${sel}`)?.scrollIntoView?.({ block: 'nearest' });
}

function select(i) {
  if (!s || !s.rows.length) return;
  s.sel = (i + s.rows.length) % s.rows.length;
  paint();
}

function run(i = s?.sel) {
  if (!s) return;
  const entry = s.rows[i];
  if (!entry) return;
  const project = s.project;
  closePalette({ restoreFocus: false });
  Promise.resolve()
    .then(() => entry.action(project))
    .catch(toastError);
}

function onKey(e) {
  if (!s) return;
  const key = e.key;
  if (key === 'Escape') {
    e.preventDefault?.();
    e.stopPropagation?.();
    closePalette();
    return;
  }
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    e.preventDefault?.();
    e.stopPropagation?.();
    select(s.sel + (key === 'ArrowDown' ? 1 : -1));
    return;
  }
  if (key === 'Home' || key === 'End') {
    e.preventDefault?.();
    e.stopPropagation?.();
    select(key === 'Home' ? 0 : s.rows.length - 1);
    return;
  }
  if (key === 'Enter') {
    e.preventDefault?.();
    e.stopPropagation?.();
    run(s.sel);
  }
}

export function closePalette({ restoreFocus = true } = {}) {
  if (!s) return;
  const { el, veil, back } = s;
  s = null;
  leave(el, () => el.remove());
  leave(veil, () => veil.remove());
  if (restoreFocus) back?.focus?.();
}

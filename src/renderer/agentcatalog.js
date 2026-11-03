// Agent catalog shared by the launcher and the terminal header. The `tint`
// pair is the same one the team picker uses for an agent's tile, so the badge
// in a pane always matches what the user selected.
export const AGENTS = [
  { id: 'claude', name: 'Claude Code', by: 'Anthropic', desc: 'Coding agent in the terminal', mono: 'C', tint: ['#e08a67', '#c2573a'], bin: 'claude', command: 'claude', bypass: '--dangerously-skip-permissions', install: 'curl -fsSL https://claude.ai/install.sh | bash', continueCommand: 'claude --continue' },
  { id: 'antigravity', name: 'Antigravity (AGY)', by: 'Google DeepMind', desc: 'Antigravity CLI agent', mono: 'AG', tint: ['#4285f4', '#34a853'], bin: 'agy', command: 'agy', bypass: '--dangerously-skip-permissions', install: 'npm i -g @google/antigravity' },
  { id: 'codex', name: 'Codex', by: 'OpenAI', desc: 'OpenAI CLI agent', mono: 'Cx', tint: ['#5b6272', '#2b2f38'], bin: 'codex', command: 'codex', bypass: '--dangerously-bypass-approvals-and-sandbox', install: 'npm i -g @openai/codex' },
  { id: 'gemini', name: 'Gemini CLI', by: 'Google', desc: 'Google open source agent', mono: 'G', tint: ['#5b8cff', '#8a5cf6'], bin: 'gemini', command: 'gemini', bypass: '--yolo', install: 'npm i -g @google/gemini-cli' },
  { id: 'copilot', name: 'Copilot CLI', by: 'GitHub', desc: 'Copilot in the terminal', mono: 'Co', tint: ['#a371f7', '#6e40c9'], bin: 'copilot', command: 'copilot', bypass: '--allow-all-tools', install: 'npm i -g @github/copilot' },
  { id: 'opencode', name: 'OpenCode', by: 'Open source', desc: 'Multi-model agent', mono: 'OC', tint: ['#4fb3bf', '#2d6f86'], bin: 'opencode', command: 'opencode', install: 'npm i -g opencode-ai' },
  { id: 'ollama', name: 'Ollama OpenCode', by: 'Ollama', desc: 'OpenCode with DeepSeek cloud model', mono: 'Ol', tint: ['#ea580c', '#c2410c'], bin: 'ollama', command: 'ollama launch opencode --model deepseek-v4.1-flash:cloud', install: 'curl -fsSL https://ollama.com/install.sh | sh' },
  { id: 'aider', name: 'Aider', by: 'Open source', desc: 'Pair programming with git', mono: 'Ai', tint: ['#4cc38a', '#23875a'], bin: 'aider', command: 'aider', bypass: '--yes-always', install: 'pipx install aider-chat' },
  { id: 'cursor-agent', name: 'Cursor Agent', by: 'Cursor', desc: "Cursor's agent for the terminal", mono: 'Cu', tint: ['#6f7480', '#1c1e24'], bin: 'cursor-agent', command: 'cursor-agent', bypass: '--force', install: 'curl https://cursor.com/install -fsS | bash' },
  { id: 'amp', name: 'Amp', by: 'Sourcegraph', desc: 'Sourcegraph coding agent', mono: 'A', tint: ['#ff6b6b', '#c92a5a'], bin: 'amp', command: 'amp', bypass: '--dangerously-allow-all', install: 'npm i -g @sourcegraph/amp' },
  { id: 'qwen', name: 'Qwen Code', by: 'Alibaba', desc: 'Qwen-based agent', mono: 'Q', tint: ['#7c83ff', '#4b3fd6'], bin: 'qwen', command: 'qwen', bypass: '--yolo', install: 'npm i -g @qwen-code/qwen-code' },
  { id: 'goose', name: 'Goose', by: 'Block', desc: 'Extensible open source agent', mono: 'Go', tint: ['#f5b53d', '#c47a12'], bin: 'goose', command: 'goose session', install: 'curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | bash' },
];

// Dogwatch reports the CLI actually running in a pane. Ollama launches
// OpenCode, so the badge uses the same short name as its OpenCode manifest.
const BADGE_ALIASES = { ollama: 'opencode' };
const FALLBACK_TINT = ['#94a3b8', '#64748b'];

export const agentById = (id) => AGENTS.find((a) => a.id === id) || null;

// The pane badge for an agent id: uppercase short name plus the catalog tint.
// Unknown ids (e.g. dogwatch's "generic") still get a readable neutral badge.
export function agentBadgeFor(id) {
  const key = String(id || '').trim().toLowerCase();
  if (!key) return null;
  const agent = agentById(key);
  return {
    id: agent?.id || key,
    text: (BADGE_ALIASES[key] || key).toUpperCase(),
    name: agent?.name || key,
    tint: agent?.tint || FALLBACK_TINT,
  };
}

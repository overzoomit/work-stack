// Canonical squad roles. Kept free of other imports so the terminal restore
// logic can resolve a role's default command without pulling in the squad UI.

export const TEAM_ROLES = [
  {
    id: 'pm',
    name: 'pm',
    role: 'PM',
    title: 'Senior PM & Architect',
    agent: 'Antigravity (AGY)',
    agentId: 'antigravity',
    command: 'agy --dangerously-skip-permissions',
  },
  {
    id: 'dev1',
    name: 'dev1',
    role: 'DEV1',
    title: 'Senior Developer #1',
    agent: 'OpenCode (Ollama DeepSeek)',
    agentId: 'ollama',
    command: 'ollama launch opencode --model deepseek-v4.1-flash:cloud',
  },
  {
    id: 'dev2',
    name: 'dev2',
    role: 'DEV2',
    title: 'Senior Developer #2',
    agent: 'OpenCode (Ollama DeepSeek)',
    agentId: 'ollama',
    command: 'ollama launch opencode --model deepseek-v4.1-flash:cloud',
  },
  {
    id: 'qa',
    name: 'qa',
    role: 'QA',
    title: 'QA Engineer',
    agent: 'OpenAI Codex',
    agentId: 'codex',
    command: 'codex --dangerously-bypass-approvals-and-sandbox',
  },
];

// Squad roles can be numbered (dev3, qa1…): the default command comes from
// the role family, while the concrete name stays the one tmux uses.
export function roleFor(name) {
  if (!name) return null;
  const n = String(name).toLowerCase();
  const exact = TEAM_ROLES.find((r) => r.id === n || r.name === n);
  if (exact) return exact;
  if (/^dev\d+$/.test(n)) return TEAM_ROLES.find((r) => r.id === 'dev1');
  if (/^qa\d*$/.test(n)) return TEAM_ROLES.find((r) => r.id === 'qa');
  return null;
}

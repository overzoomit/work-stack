// One knowledge base for every agent CLI (docs/adr/0006): the entry files and
// the skill folders are symlinks to a single canonical copy in the repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const link = (path) => {
  const full = join(ROOT, path);
  assert.ok(lstatSync(full).isSymbolicLink(), `${path} must be a symlink`);
  return readlinkSync(full);
};

test('CLAUDE.md and GEMINI.md are symlinks to the canonical AGENTS.md', () => {
  assert.equal(link('CLAUDE.md'), 'AGENTS.md');
  assert.equal(link('GEMINI.md'), 'AGENTS.md');
  assert.ok(lstatSync(join(ROOT, 'AGENTS.md')).isFile());
});

test('AGENTS.md makes the Knowledge Base and the ADRs the binding source before any change', () => {
  const [head] = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8').split('\n---\n');
  const rule = head.split('\n').find((l) => l.includes('Fonte primaria vincolante'));
  assert.ok(rule, 'the binding rule sits above the first section');
  assert.match(rule, /`docs\/KNOWLEDGE_BASE\.md`/);
  assert.match(rule, /`docs\/adr\/`/);
  assert.ok(existsSync(join(ROOT, 'docs', 'KNOWLEDGE_BASE.md')));
  assert.ok(existsSync(join(ROOT, 'docs', 'adr')));
});

test('.claude/skills and .opencode/skills share docs/agents/skills, and every skill has its SKILL.md', () => {
  assert.equal(link('.claude/skills'), '../docs/agents/skills');
  assert.equal(link('.opencode/skills'), '../docs/agents/skills');
  const dir = join(ROOT, 'docs', 'agents', 'skills');
  const skills = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  assert.ok(skills.length > 0);
  for (const name of skills) assert.ok(existsSync(join(dir, name, 'SKILL.md')), `${name}/SKILL.md`);
});

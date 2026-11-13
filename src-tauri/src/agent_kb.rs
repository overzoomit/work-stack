// The shared agent knowledge base of a project (docs/adr/0006): AGENTS.md is
// the one entry file, CLAUDE.md and GEMINI.md link to it, and Claude Code and
// OpenCode share one skills folder. Provisioning is idempotent and never
// overwrites: whatever already sits at a path is left as it is and reported.
use crate::fsops::{guard, Roots};
use serde::Serialize;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use tauri::State;

const ENTRY: &str = "AGENTS.md";
const SKILLS: &str = "docs/agents/skills";
// (link, relative target, what the target is from the root)
const LINKS: [(&str, &str, &str); 4] = [
    ("CLAUDE.md", ENTRY, ENTRY),
    ("GEMINI.md", ENTRY, ENTRY),
    (".claude/skills", "../docs/agents/skills", SKILLS),
    (".opencode/skills", "../docs/agents/skills", SKILLS),
];

const TEMPLATE: &str = "# Agent guide

Shared instructions for every coding agent on this project (Claude Code, Gemini CLI, Codex, OpenCode).
`CLAUDE.md` and `GEMINI.md` are symlinks to this file: edit it here.

> **Binding source:** before changing any code, read `docs/KNOWLEDGE_BASE.md` (architecture, IPC/API contracts,
> events, data schema) and the decisions in `docs/adr/`. Every change must respect them; when a task contradicts
> them, tell the PM instead of diverging. If they do not exist yet, ask the PM before assuming.

## Ralph Loop

Every task, and every fresh session after `/clear` or `/new`, follows the same loop:

1. **[R] Read** the acceptance criteria of the ticket and the knowledge base above.
2. **[A] Align** the planned change with the existing contracts, events and data schema.
3. **[L] Lock & Implement** the change with focused unit or integration tests (QA: verify it end to end).
4. **[P] Prove** it with the full test suite and the linters; go back to [L] until everything passes.
5. **[H] Hand off**: move the ticket on the issue tracker with a technical comment listing changed files and tests.

## Team

- Only the PM assigns tickets. Dev and QA agents never pick one on their own: they report ready and wait.
- A dev moves its ticket to Test when done, never straight to Done. QA moves it to Done, or to Re-open with a
  detailed report.
- Shared skills live in `docs/agents/skills/`; `.claude/skills` and `.opencode/skills` link there.
";

#[derive(Debug, Default, PartialEq, Serialize)]
pub struct KbProvisionReport {
    // Paths created now, relative to the project root.
    pub created: Vec<String>,
    // Regular files moved to AGENTS.md and linked back (an existing CLAUDE.md).
    pub adopted: Vec<String>,
    // Paths holding something else, or reaching outside the project: untouched.
    pub skipped: Vec<String>,
}

fn present(path: &Path) -> bool {
    path.symlink_metadata().is_ok()
}

pub fn ensure_project_agent_kb(project_root: &Path) -> Result<KbProvisionReport, String> {
    let real_root = project_root
        .canonicalize()
        .map_err(|e| format!("{}: {e}", project_root.display()))?;
    if !real_root.is_dir() {
        return Err(format!("Not a folder: {}", project_root.display()));
    }
    let failed = |path: &str, e: std::io::Error| format!("{path}: {e}");
    // A symlinked docs/ or .claude/ must not carry a write outside the project.
    let outside = |path: &PathBuf| guard(std::slice::from_ref(&real_root), path, false).is_err();
    let mut report = KbProvisionReport::default();

    let entry = real_root.join(ENTRY);
    let claude = real_root.join("CLAUDE.md");
    if !present(&entry) {
        match claude.symlink_metadata() {
            Ok(meta) if meta.is_file() => {
                std::fs::rename(&claude, &entry).map_err(|e| failed("CLAUDE.md", e))?;
                report.adopted.push("CLAUDE.md".into());
            }
            // The user's own link or folder: no second entry beside it.
            Ok(_) => {}
            Err(_) => {
                std::fs::write(&entry, TEMPLATE).map_err(|e| failed(ENTRY, e))?;
                report.created.push(ENTRY.into());
            }
        }
    }

    let skills = real_root.join(SKILLS);
    if !present(&skills) {
        if outside(&skills) {
            report.skipped.push(SKILLS.into());
        } else {
            std::fs::create_dir_all(&skills).map_err(|e| failed(SKILLS, e))?;
            report.created.push(SKILLS.into());
        }
    }

    for (link, target, real) in LINKS {
        let path = real_root.join(link);
        if let Ok(found) = std::fs::read_link(&path) {
            if found != Path::new(target) {
                report.skipped.push(link.into());
            }
            continue;
        }
        let dir = path.parent().unwrap_or(&real_root);
        // A link to a missing entry or skills folder would dangle.
        if present(&path)
            || outside(&path)
            || !real_root.join(real).exists()
            || (present(dir) && !dir.is_dir())
        {
            report.skipped.push(link.into());
            continue;
        }
        std::fs::create_dir_all(dir).map_err(|e| failed(link, e))?;
        symlink(target, &path).map_err(|e| failed(link, e))?;
        report.created.push(link.into());
    }
    Ok(report)
}

#[tauri::command]
pub fn agent_kb_provision(
    roots: State<'_, Roots>,
    path: String,
) -> Result<KbProvisionReport, String> {
    let root = guard(&roots.get(), Path::new(&path), true)?;
    ensure_project_agent_kb(&root)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(root: &Path, path: &str) -> String {
        std::fs::read_link(root.join(path))
            .unwrap()
            .to_string_lossy()
            .into_owned()
    }

    fn read(root: &Path, path: &str) -> String {
        std::fs::read_to_string(root.join(path)).unwrap()
    }

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn an_empty_project_gets_the_whole_knowledge_base() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let report = ensure_project_agent_kb(root).unwrap();
        assert_eq!(
            report.created,
            strings(&[
                "AGENTS.md",
                "docs/agents/skills",
                "CLAUDE.md",
                "GEMINI.md",
                ".claude/skills",
                ".opencode/skills"
            ])
        );
        assert!(report.adopted.is_empty() && report.skipped.is_empty());
        let agents = read(root, "AGENTS.md");
        for needle in [
            "docs/KNOWLEDGE_BASE.md",
            "docs/adr/",
            "Ralph Loop",
            "[H] Hand off",
        ] {
            assert!(agents.contains(needle), "{needle}");
        }
        assert_eq!(link(root, "CLAUDE.md"), "AGENTS.md");
        assert_eq!(link(root, "GEMINI.md"), "AGENTS.md");
        assert_eq!(link(root, ".claude/skills"), "../docs/agents/skills");
        assert_eq!(link(root, ".opencode/skills"), "../docs/agents/skills");
        assert_eq!(read(root, "CLAUDE.md"), agents, "the link resolves");
        assert!(root.join(".opencode/skills").is_dir());
    }

    #[test]
    fn a_second_run_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        ensure_project_agent_kb(dir.path()).unwrap();
        let before = std::fs::metadata(dir.path().join("AGENTS.md"))
            .unwrap()
            .modified()
            .unwrap();
        for _ in 0..2 {
            assert_eq!(
                ensure_project_agent_kb(dir.path()).unwrap(),
                KbProvisionReport::default()
            );
        }
        let after = std::fs::metadata(dir.path().join("AGENTS.md"))
            .unwrap()
            .modified()
            .unwrap();
        assert_eq!(before, after);
    }

    #[test]
    fn an_existing_claude_md_becomes_agents_md_and_links_back() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join("CLAUDE.md"), "# Our rules\n").unwrap();
        let report = ensure_project_agent_kb(root).unwrap();
        assert_eq!(report.adopted, strings(&["CLAUDE.md"]));
        assert!(!report.created.contains(&"AGENTS.md".to_string()));
        assert_eq!(read(root, "AGENTS.md"), "# Our rules\n");
        assert_eq!(link(root, "CLAUDE.md"), "AGENTS.md");
        assert_eq!(link(root, "GEMINI.md"), "AGENTS.md");
    }

    #[test]
    fn user_files_and_foreign_links_are_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join("AGENTS.md"), "own agents\n").unwrap();
        std::fs::write(root.join("GEMINI.md"), "own gemini\n").unwrap();
        std::fs::create_dir_all(root.join(".claude/skills/mine")).unwrap();
        std::fs::write(root.join(".claude/skills/mine/SKILL.md"), "mine\n").unwrap();
        std::fs::create_dir(root.join(".opencode")).unwrap();
        symlink("elsewhere", root.join(".opencode/skills")).unwrap();

        let report = ensure_project_agent_kb(root).unwrap();
        assert_eq!(
            report.created,
            strings(&["docs/agents/skills", "CLAUDE.md"])
        );
        assert_eq!(
            report.skipped,
            strings(&["GEMINI.md", ".claude/skills", ".opencode/skills"])
        );
        assert_eq!(read(root, "AGENTS.md"), "own agents\n");
        assert_eq!(read(root, "GEMINI.md"), "own gemini\n");
        assert_eq!(read(root, ".claude/skills/mine/SKILL.md"), "mine\n");
        assert_eq!(link(root, ".opencode/skills"), "elsewhere");
    }

    #[test]
    fn a_claude_md_link_of_the_user_gets_no_template_beside_it() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join("RULES.md"), "rules\n").unwrap();
        symlink("RULES.md", root.join("CLAUDE.md")).unwrap();
        let report = ensure_project_agent_kb(root).unwrap();
        assert!(!root.join("AGENTS.md").exists());
        assert_eq!(report.skipped, strings(&["CLAUDE.md", "GEMINI.md"]));
        assert!(
            !present(&root.join("GEMINI.md")),
            "no link to a missing entry"
        );
    }

    #[test]
    fn nothing_is_written_through_a_symlink_leaving_the_project() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = dir.path();
        symlink(outside.path(), root.join("docs")).unwrap();
        symlink(outside.path(), root.join(".claude")).unwrap();
        let report = ensure_project_agent_kb(root).unwrap();
        assert_eq!(
            report.skipped,
            strings(&["docs/agents/skills", ".claude/skills", ".opencode/skills"])
        );
        assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
        assert!(
            !present(&root.join(".opencode")),
            "no folder for a link that would dangle"
        );
    }
}

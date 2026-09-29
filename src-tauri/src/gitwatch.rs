// Watches each open repository's .git folder so the UI refreshes when git
// state changes (commit, checkout, stage, fetch…) instead of polling.
// Working-tree edits are caught by the renderer from terminal activity.
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

// /\.lock$|^objects|^logs|^COMMIT_EDITMSG$/
fn ignored(name: &str) -> bool {
    name.ends_with(".lock")
        || name.starts_with("objects")
        || name.starts_with("logs")
        || name == "COMMIT_EDITMSG"
}

// A repository's own git folder and the one holding shared refs. In a linked
// worktree `.git` is a file ("gitdir: <main>/.git/worktrees/<name>"): HEAD and
// index live there, branches in the main repository (see its "commondir").
fn git_dirs(repo: &Path) -> Option<(PathBuf, PathBuf)> {
    let dot_git = repo.join(".git");
    if fs::metadata(&dot_git).ok()?.is_dir() {
        return Some((dot_git.clone(), dot_git));
    }
    let text = fs::read_to_string(&dot_git).ok()?;
    let target = text
        .lines()
        .find_map(|l| l.strip_prefix("gitdir: ").filter(|t| !t.is_empty()))?;
    let git_dir = repo.join(target.trim());
    // No commondir: refs are in gitDir itself.
    let common_dir = fs::read_to_string(git_dir.join("commondir"))
        .map_or_else(|_| git_dir.clone(), |c| git_dir.join(c.trim()));
    Some((git_dir, common_dir))
}

type Callback = Arc<dyn Fn(String, &'static str) + Send + Sync>;

pub struct GitWatcher {
    on_change: Callback,
    // None: no readable git folder; kept so the repo is not retried (polling covers it).
    repos: Mutex<HashMap<String, Option<RecommendedWatcher>>>,
}

impl GitWatcher {
    pub fn new(on_change: impl Fn(String, &'static str) + Send + Sync + 'static) -> Self {
        GitWatcher {
            on_change: Arc::new(on_change),
            repos: Mutex::default(),
        }
    }

    pub fn watch(&self, repo: &str) {
        let mut repos = self.repos.lock().unwrap();
        if repo.is_empty() || repos.contains_key(repo) {
            return;
        }
        let watcher = git_dirs(Path::new(repo))
            .and_then(|(git_dir, common_dir)| self.start(repo, &git_dir, &common_dir.join("refs")));
        repos.insert(repo.to_string(), watcher);
    }

    fn start(&self, repo: &str, git_dir: &Path, refs: &Path) -> Option<RecommendedWatcher> {
        // Real paths: FSEvents reports /private/var/… for /var/…, and names are
        // taken relative to the watched folders.
        let git_dir = fs::canonicalize(git_dir).ok()?;
        let refs = fs::canonicalize(refs).ok();
        let (tx, rx) = mpsc::channel::<bool>();
        let refs_root = refs.clone();
        let root = git_dir.clone();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            let Ok(ev) = res else { return };
            // fs.watch reports writes, not reads (inotify's IN_OPEN/IN_ACCESS, close-after-write).
            if matches!(ev.kind, EventKind::Access(_)) {
                return;
            }
            for p in &ev.paths {
                // refs: anything below (branches, tags, remotes: never named "index");
                // the git folder: its own entries only, like a non-recursive fs.watch.
                let name = match refs_root.as_deref().and_then(|r| p.strip_prefix(r).ok()) {
                    Some(rel) => rel,
                    None => match p.strip_prefix(&root) {
                        Ok(rel) if rel.components().count() == 1 => rel,
                        _ => continue,
                    },
                };
                let name = name.to_string_lossy();
                if name.is_empty() || ignored(&name) {
                    continue;
                }
                let _ = tx.send(name == "index");
            }
        })
        .ok()?;
        let _ = watcher.watch(&git_dir, RecursiveMode::NonRecursive); // HEAD, index, FETCH_HEAD, MERGE_HEAD…
        if let Some(refs) = &refs {
            let _ = watcher.watch(refs, RecursiveMode::Recursive);
        } // else: folder missing

        // Changes are batched for 300 ms. If only the index moved (git add, or a
        // shell prompt running `git status`) the UI needs the status alone;
        // anything else (HEAD, refs, FETCH_HEAD…) may change branches and graph.
        // The thread ends, dropping any pending batch, when the watcher is dropped.
        let (repo, on_change) = (repo.to_string(), self.on_change.clone());
        std::thread::spawn(move || {
            while let Ok(first) = rx.recv() {
                let mut only_index = first;
                loop {
                    match rx.recv_timeout(Duration::from_millis(300)) {
                        Ok(index) => only_index &= index,
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                }
                on_change(repo.clone(), if only_index { "index" } else { "full" });
            }
        });
        Some(watcher)
    }

    pub fn unwatch(&self, repo: &str) {
        self.repos.lock().unwrap().remove(repo);
    }
}

// Sync commands run in call order, like ipcMain.on: an unwatch followed by a
// watch of the same repo (project switch) must not be reordered. Both are cheap.
#[tauri::command]
pub fn git_watch(w: tauri::State<GitWatcher>, repo: String) {
    w.watch(&repo);
}

#[tauri::command]
pub fn git_unwatch(w: tauri::State<GitWatcher>, repo: String) {
    w.unwatch(&repo);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::thread::sleep;

    fn run(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn repo() -> tempfile::TempDir {
        let d = tempfile::Builder::new()
            .prefix("work-watch-")
            .tempdir()
            .unwrap();
        run(d.path(), &["init", "-q"]);
        run(d.path(), &["config", "user.email", "t@example.com"]);
        run(d.path(), &["config", "user.name", "Test"]);
        fs::write(d.path().join("a.txt"), "1\n").unwrap();
        run(d.path(), &["add", "-A"]);
        run(d.path(), &["commit", "-qm", "init"]);
        d
    }

    // The kinds reported within 900 ms after `action` runs.
    fn events_after(dir: &Path, action: impl FnOnce()) -> Vec<&'static str> {
        let kinds = Arc::new(Mutex::new(vec![]));
        let k = kinds.clone();
        let w = GitWatcher::new(move |_repo, kind| k.lock().unwrap().push(kind));
        w.watch(dir.to_str().unwrap());
        // FSEvents can deliver the setup's own writes (e.g. `worktree add`) after
        // watch(): let their 300 ms batch go out, then forget it.
        sleep(Duration::from_millis(600));
        kinds.lock().unwrap().clear();
        action();
        sleep(Duration::from_millis(900));
        drop(w); // like stop(): every watcher closed
        let out = kinds.lock().unwrap().clone();
        out
    }

    #[test]
    fn uno_stage_cambia_solo_l_index_e_viene_segnalato_come_index() {
        let r = repo();
        fs::write(r.path().join("a.txt"), "2\n").unwrap();
        assert_eq!(
            events_after(r.path(), || run(r.path(), &["add", "a.txt"])),
            ["index"]
        );
    }

    #[test]
    fn un_commit_sposta_il_ramo_e_viene_segnalato_come_full() {
        let r = repo();
        fs::write(r.path().join("a.txt"), "2\n").unwrap();
        run(r.path(), &["add", "a.txt"]);
        assert_eq!(
            events_after(r.path(), || run(r.path(), &["commit", "-qm", "second"])),
            ["full"]
        );
    }

    #[test]
    fn un_nuovo_ramo_viene_segnalato_come_full() {
        let r = repo();
        assert_eq!(
            events_after(r.path(), || run(r.path(), &["branch", "feature/x"])),
            ["full"]
        );
    }

    #[test]
    fn anche_in_un_git_worktree_uno_stage_e_un_commit_vengono_segnalati_regressione() {
        let r = repo();
        let parent = tempfile::Builder::new()
            .prefix("work-wt-")
            .tempdir()
            .unwrap();
        let wt = parent.path().join("wt");
        run(
            r.path(),
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "agente",
                wt.to_str().unwrap(),
            ],
        );
        fs::write(wt.join("a.txt"), "2\n").unwrap();
        assert_eq!(events_after(&wt, || run(&wt, &["add", "a.txt"])), ["index"]);
        assert_eq!(
            events_after(&wt, || run(&wt, &["commit", "-qm", "dal worktree"])),
            ["full"]
        );
    }

    #[test]
    fn un_file_git_illeggibile_o_anomalo_non_fa_fallire_il_watcher() {
        let dir = tempfile::Builder::new()
            .prefix("work-badgit-")
            .tempdir()
            .unwrap();
        fs::write(dir.path().join(".git"), "non è un puntatore gitdir\n").unwrap();
        let nogit = tempfile::Builder::new()
            .prefix("work-nogit-")
            .tempdir()
            .unwrap();
        let kinds = Arc::new(Mutex::new(vec![]));
        let k = kinds.clone();
        let w = GitWatcher::new(move |_repo, kind| k.lock().unwrap().push(kind));
        w.watch(dir.path().to_str().unwrap());
        w.watch(nogit.path().to_str().unwrap());
        drop(w); // like stop(): every watcher closed
        assert!(kinds.lock().unwrap().is_empty());
    }

    #[test]
    fn un_gitdir_relativo_e_il_commondir_vengono_risolti() {
        let d = tempfile::tempdir().unwrap();
        let wt = d.path().join("wt");
        fs::create_dir_all(d.path().join("main/.git/worktrees/wt")).unwrap();
        fs::create_dir(&wt).unwrap();
        fs::write(wt.join(".git"), "gitdir: ../main/.git/worktrees/wt\n").unwrap();
        fs::write(d.path().join("main/.git/worktrees/wt/commondir"), "../..\n").unwrap();
        let (git_dir, common) = git_dirs(&wt).unwrap();
        assert_eq!(
            fs::canonicalize(git_dir).unwrap(),
            fs::canonicalize(d.path().join("main/.git/worktrees/wt")).unwrap()
        );
        assert_eq!(
            fs::canonicalize(common).unwrap(),
            fs::canonicalize(d.path().join("main/.git")).unwrap()
        );
    }
}

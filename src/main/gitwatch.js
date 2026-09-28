// Watches each open repository's .git folder so the UI refreshes when git
// state changes (commit, checkout, stage, fetch…) instead of polling.
// Working-tree edits are caught by the renderer from terminal activity.
const fs = require('fs');
const path = require('path');

const IGNORED = /\.lock$|^objects|^logs|^COMMIT_EDITMSG$/;

// A repository's own git folder and the one holding shared refs. In a linked
// worktree `.git` is a file ("gitdir: <main>/.git/worktrees/<name>"): HEAD and
// index live there, branches in the main repository (see its "commondir").
function gitDirs(repo) {
  const dotGit = path.join(repo, '.git');
  try {
    if (fs.statSync(dotGit).isDirectory()) return { gitDir: dotGit, commonDir: dotGit };
    const gitDir = path.resolve(repo, fs.readFileSync(dotGit, 'utf8').match(/^gitdir: (.+)$/m)[1].trim());
    let commonDir = gitDir;
    try {
      commonDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
    } catch {
      // no commondir: refs are in gitDir itself
    }
    return { gitDir, commonDir };
  } catch {
    return null;
  }
}

class GitWatcher {
  constructor(onChange) {
    this.onChange = onChange;
    this.repos = new Map(); // repo -> { watchers, timer }
  }

  watch(repo) {
    if (!repo || this.repos.has(repo)) return;
    const entry = { watchers: [], timer: null };
    this.repos.set(repo, entry);
    const dirs = gitDirs(repo);
    if (!dirs) return; // unreadable: the polling fallback covers it

    // Changes are batched for 300 ms. If only the index moved (git add, or a
    // shell prompt running `git status`) the UI needs the status alone;
    // anything else (HEAD, refs, FETCH_HEAD…) may change branches and graph.
    let onlyIndex = true;
    const fire = (name) => {
      if (name && IGNORED.test(name)) return;
      if (name !== 'index') onlyIndex = false;
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        const kind = onlyIndex ? 'index' : 'full';
        onlyIndex = true;
        this.onChange(repo, kind);
      }, 300);
    };
    const add = (dir, opts = {}) => {
      try {
        const w = fs.watch(dir, opts, (_ev, name) => fire(name));
        w.on('error', () => w.close());
        entry.watchers.push(w);
      } catch {
        // folder missing (e.g. no refs/remotes yet)
      }
    };
    add(dirs.gitDir); // HEAD, index, FETCH_HEAD, MERGE_HEAD…
    add(path.join(dirs.commonDir, 'refs'), { recursive: true }); // branches, tags, remotes (never named "index")
  }

  unwatch(repo) {
    const entry = this.repos.get(repo);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.watchers.forEach((w) => w.close());
    this.repos.delete(repo);
  }

  stop() {
    for (const repo of [...this.repos.keys()]) this.unwatch(repo);
  }
}

module.exports = { GitWatcher };

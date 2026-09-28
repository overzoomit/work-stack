// Watches each open repository's .git folder so the UI refreshes when git
// state changes (commit, checkout, stage, fetch…) instead of polling.
// Working-tree edits are caught by the renderer from terminal activity.
const fs = require('fs');
const path = require('path');

const IGNORED = /\.lock$|^objects|^logs|^COMMIT_EDITMSG$/;

class GitWatcher {
  constructor(onChange) {
    this.onChange = onChange;
    this.repos = new Map(); // repo -> { watchers, timer }
  }

  watch(repo) {
    if (!repo || this.repos.has(repo)) return;
    const entry = { watchers: [], timer: null };
    this.repos.set(repo, entry);
    const gitDir = path.join(repo, '.git');
    let isDir = false;
    try {
      isDir = fs.statSync(gitDir).isDirectory();
    } catch {
      return; // not a normal repo (e.g. worktree .git file): polling fallback covers it
    }
    if (!isDir) return;

    const fire = (name) => {
      if (name && IGNORED.test(name)) return;
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => this.onChange(repo), 300);
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
    add(gitDir); // HEAD, index, FETCH_HEAD, MERGE_HEAD…
    add(path.join(gitDir, 'refs'), { recursive: true }); // branches, tags, remotes
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

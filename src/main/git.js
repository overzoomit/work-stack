// GitService: every operation goes through the git CLI so the user's
// config, hooks, credentials and signing keep working as usual.
const { execFile } = require('child_process');

const SEP = '\x1f';
const REC = '\x1e';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const FULL_CONTEXT = '-U100000'; // whole file, the viewer collapses unchanged runs itself

// okCodes: `git diff --no-index` exits 1 when files differ, which is not an error.
function git(cwd, args, { input, okCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } },
      (err, stdout, stderr) => {
        if (err && !okCodes.includes(err.code)) reject(new Error((stderr || err.message).trim()));
        else resolve(stdout);
      });
    if (input !== undefined) child.stdin.end(input);
  });
}

async function root(cwd) {
  try {
    return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    return null;
  }
}

// "## <branch>[...<upstream>][ [ahead N, behind M]]" from `git status -b`.
// Branch names may contain dots (release/1.2) but never spaces or "...".
function parseBranchHeader(head) {
  let rest = head.replace(/^## /, '');
  let info = '';
  const bracket = rest.match(/ \[([^\]]*)\]$/);
  if (bracket) {
    info = bracket[1];
    rest = rest.slice(0, bracket.index);
  }
  rest = rest.replace(/^(No commits yet on|Initial commit on) /, '');
  const detached = !rest || rest.startsWith('HEAD (no branch)');
  const [name, upstream] = detached ? ['HEAD', null] : rest.split('...');
  return {
    name,
    upstream: upstream || null,
    ahead: Number(info.match(/ahead (\d+)/)?.[1] || 0),
    behind: Number(info.match(/behind (\d+)/)?.[1] || 0),
  };
}

// `ignored: false` skips the ignored-files scan (it walks the whole working
// tree): the caller keeps the previous list for frequent refreshes.
async function status(repo, { ignored: withIgnored = true } = {}) {
  const [out, ign] = await Promise.all([
    git(repo, ['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all']),
    // Ignored entries collapsed to their top folder (node_modules/, dist/…).
    withIgnored
      ? git(repo, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']).catch(() => '')
      : null,
  ]);
  const entries = out.split('\0').filter(Boolean);
  const branch = parseBranchHeader(entries.shift() || '');

  const staged = [];
  const unstaged = [];
  const ignored = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const x = e[0];
    const y = e[1];
    const file = e.slice(3);
    // The rename source follows as its own entry, for renames in the index (R_)
    // and in the working tree (_R, e.g. after `git add -N`).
    if ('RC'.includes(x) || 'RC'.includes(y)) i++;
    if (x === '?' && y === '?') {
      unstaged.push({ file, code: 'U' });
      continue;
    }
    if (x !== ' ') staged.push({ file, code: x });
    if (y !== ' ') unstaged.push({ file, code: y });
  }
  if (ign === null) return { branch, staged, unstaged, ignored: null };
  for (const f of ign.split('\0')) if (f) ignored.push(f.replace(/\/$/, ''));
  return { branch, staged, unstaged, ignored };
}

async function log(repo, limit = 400) {
  const fmt = ['%H', '%P', '%D', '%an', '%at', '%s'].join(SEP) + REC;
  let out;
  try {
    out = await git(repo, ['log', '--all', '--date-order', '--decorate=full', `-n${limit}`, `--format=${fmt}`]);
  } catch {
    return []; // repo without commits
  }
  return out.split(REC).map((r) => r.trim()).filter(Boolean).map((r) => {
    const [hash, parents, refs, author, time, subject] = r.split(SEP);
    return {
      hash,
      parents: parents ? parents.split(' ') : [],
      refs: refs ? refs.split(', ') : [],
      author,
      time: Number(time) * 1000,
      subject,
    };
  });
}

// Local and remote branches are told apart by their full ref name: a local
// "feature/x" contains a slash too. origin/HEAD only points at another branch.
async function branches(repo) {
  const out = await git(repo, ['branch', '-a', `--format=%(HEAD)${SEP}%(refname)${SEP}%(refname:short)`]);
  return out.split('\n').filter(Boolean).map((l) => {
    const [head, ref, name] = l.split(SEP);
    return { ref, name, current: head === '*', remote: ref.startsWith('refs/remotes/') };
  }).filter((b) => !(b.remote && b.ref.endsWith('/HEAD'))).map(({ ref, ...b }) => b);
}

// Parent to diff a commit against: first parent, or the empty tree for a root commit.
async function parentOf(repo, hash) {
  const line = (await git(repo, ['rev-list', '--parents', '-n1', hash])).trim().split(' ');
  return line[1] || EMPTY_TREE;
}

// name-status + numstat of a commit, joined per file.
async function commitFiles(repo, hash) {
  const parent = await parentOf(repo, hash);
  const [ns, num] = await Promise.all([
    git(repo, ['diff', '--name-status', '-M', '-z', parent, hash]),
    git(repo, ['diff', '--numstat', '-M', '-z', parent, hash]),
  ]);

  const files = [];
  const t = ns.split('\0').filter((x) => x !== '');
  for (let i = 0; i < t.length; i++) {
    const code = t[i][0];
    if (code === 'R' || code === 'C') files.push({ code, oldFile: t[++i], file: t[++i] });
    else files.push({ code, file: t[++i] });
  }

  // numstat -z: "add\tdel\tpath\0" or, for renames, "add\tdel\t\0old\0new\0"
  const stats = new Map();
  const n = num.split('\0');
  for (let i = 0; i < n.length; i++) {
    if (!n[i]) continue;
    const [add, del, p] = n[i].split('\t');
    const file = p === '' ? (i += 2, n[i]) : p;
    stats.set(file, { add: add === '-' ? null : Number(add), del: del === '-' ? null : Number(del) });
  }
  for (const f of files) Object.assign(f, stats.get(f.file) || { add: 0, del: 0 });
  return { parent, files };
}

async function commit(repo, hash) {
  const fmt = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ct', '%D', '%B'].join(SEP);
  const out = await git(repo, ['show', '-s', '--decorate=full', `--format=${fmt}`, hash]);
  const [h, parents, author, email, time, committer, ctime, refs, body] = out.split(SEP);
  const { files } = await commitFiles(repo, h);
  return {
    hash: h,
    parents: parents ? parents.split(' ') : [],
    author, email, time: Number(time) * 1000,
    committer, ctime: Number(ctime) * 1000,
    refs: refs ? refs.split(', ') : [],
    message: body.trim(),
    files,
  };
}

async function containing(repo, hash) {
  try {
    const out = await git(repo, ['branch', '-a', '--contains', hash, '--format=%(refname:short)']);
    return out.split('\n').filter((b) => b && !b.endsWith('/HEAD'));
  } catch {
    return [];
  }
}

// Unified diff with the whole file as context.
//  - commit: { hash, file, oldFile }
//  - working copy: { file, staged, untracked }
async function fileDiff(repo, { hash, file, oldFile, staged, untracked }) {
  if (hash) {
    const parent = await parentOf(repo, hash);
    const paths = oldFile && oldFile !== file ? [oldFile, file] : [file];
    return git(repo, ['diff', FULL_CONTEXT, '-M', '--no-color', parent, hash, '--', ...paths]);
  }
  if (untracked) {
    return git(repo, ['diff', FULL_CONTEXT, '--no-color', '--no-index', '--', '/dev/null', file], { okCodes: [0, 1] });
  }
  return git(repo, ['diff', FULL_CONTEXT, '--no-color', ...(staged ? ['--cached'] : []), '--', file]);
}

const isRef = (repo, ref) => git(repo, ['rev-parse', '--verify', '--quiet', ref]).then(() => true, () => false);

// A remote branch ("upstream/feature", any remote) is checked out as the local
// branch that tracks it, created on first use, instead of a detached HEAD.
async function checkout(repo, branch) {
  if (await isRef(repo, `refs/heads/${branch}`)) return git(repo, ['checkout', branch]);
  const remotes = (await git(repo, ['remote'])).split('\n').filter(Boolean);
  const remote = remotes.find((r) => branch.startsWith(`${r}/`));
  if (!remote) return git(repo, ['checkout', branch]); // tag or commit
  const local = branch.slice(remote.length + 1);
  if (await isRef(repo, `refs/heads/${local}`)) return git(repo, ['checkout', local]);
  return git(repo, ['checkout', '--track', branch]);
}

const actions = {
  stage: (repo, { files }) => git(repo, ['add', '--', ...files]),
  unstage: (repo, { files }) => git(repo, ['restore', '--staged', '--', ...files]),
  discard: (repo, { files }) => git(repo, ['checkout', '--', ...files]),
  stageAll: (repo) => git(repo, ['add', '-A']),
  commit: (repo, { message, amend }) => git(repo, ['commit', '-F', '-', ...(amend ? ['--amend'] : [])], { input: message }),
  checkout: (repo, { branch }) => checkout(repo, branch),
  createBranch: (repo, { name, from }) => git(repo, ['checkout', '-b', name, ...(from ? [from] : [])]),
  fetch: (repo) => git(repo, ['fetch', '--all', '--prune']),
  pull: (repo) => git(repo, ['pull', '--ff-only']),
  push: (repo) => git(repo, ['push', '-u', 'origin', 'HEAD']),
  stash: (repo) => git(repo, ['stash', 'push', '-u']),
  stashPop: (repo) => git(repo, ['stash', 'pop']),
  merge: (repo, { branch }) => git(repo, ['merge', '--no-edit', branch]),
  cherryPick: (repo, { hash }) => git(repo, ['cherry-pick', hash]),
  revert: (repo, { hash }) => git(repo, ['revert', '--no-edit', hash]),
  resetSoft: (repo, { hash }) => git(repo, ['reset', '--soft', hash]),
  worktreeAdd: (repo, { path, branch }) => git(repo, ['worktree', 'add', '-b', branch, path]),
  init: (repo) => git(repo, ['init']),
};

async function action(repo, name, params = {}) {
  if (!actions[name]) throw new Error(`Azione git sconosciuta: ${name}`);
  return actions[name](repo, params);
}

module.exports = { root, status, log, branches, action, commit, containing, fileDiff, parseBranchHeader };

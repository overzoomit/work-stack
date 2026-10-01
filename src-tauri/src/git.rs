// GitService: every operation goes through the git CLI so the user's
// config, hooks, credentials and signing keep working as usual.
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io;
use std::process::Stdio;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

const SEP: char = '\x1f';
const REC: char = '\x1e';

const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const FULL_CONTEXT: &str = "-U100000"; // whole file, the viewer collapses unchanged runs itself
                                       // The viewer parses unified diffs: a user's diff.external (difftastic…) must not run.
const PLAIN: [&str; 2] = ["--no-ext-diff", "--no-color"];

struct Opts<'a> {
    input: Option<&'a str>,
    // `git diff --no-index` exits 1 when files differ, which is not an error.
    ok_codes: &'a [i32],
    max_buffer: usize,
    too_big: Option<&'a str>,
}

const DEFAULT: Opts<'static> = Opts {
    input: None,
    ok_codes: &[0],
    max_buffer: 64 * 1024 * 1024,
    too_big: None,
};

// The viewer parses the whole diff at once: past ~200k lines it would freeze.
const DIFF_LIMIT: Opts<'static> = Opts {
    max_buffer: 8 * 1024 * 1024,
    too_big: Some("Differenze troppo grandi da mostrare (oltre 8 MB)."),
    ..DEFAULT
};

// String.prototype.trim: Rust's trim also strips U+0085 and keeps U+FEFF.
fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}

// Err(None): the stream went past `max` bytes (Node's maxBuffer).
async fn read_capped(
    mut r: impl AsyncRead + Unpin,
    max: usize,
) -> Result<Vec<u8>, Option<io::Error>> {
    let mut buf = Vec::new();
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        let n = r.read(&mut chunk).await.map_err(Some)?;
        if n == 0 {
            return Ok(buf);
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.len() > max {
            return Err(None);
        }
    }
}

// Every git call is logged here: DEBUG always, start and end of the network
// actions (a start without an end is a hung command), WARN on an error or
// past 10 s. Commit messages go through stdin and never reach the log.
async fn git_with(cwd: &str, args: &[&str], o: Opts<'_>) -> Result<String, String> {
    use crate::diag::{log, Level};
    let cmd = args.join(" ");
    let net = matches!(args.first(), Some(&("fetch" | "pull" | "push")));
    if net {
        log(Level::Info, "git", format!("{cmd} in {cwd}: inizio"));
    }
    let start = std::time::Instant::now();
    let mut exit = None;
    let o_has_input = o.input.is_some();
    let res = run_git(cwd, args, o, &mut exit).await;
    let ms = start.elapsed().as_millis();
    let exit = exit.map_or("-".to_string(), |c: i32| c.to_string());
    log(
        Level::Debug,
        "git",
        format!("{cmd} in {cwd}: exit {exit} in {ms} ms"),
    );
    if net {
        log(
            Level::Info,
            "git",
            format!("{cmd} in {cwd}: fine, exit {exit} in {ms} ms"),
        );
    }
    match &res {
        // A commit's stderr is its hooks' output: commitlint quotes the
        // message, linters print source lines. Neither belongs in the log.
        Err(_) if o_has_input => log(
            Level::Warn,
            "git",
            format!("{cmd} in {cwd}: exit {exit} dopo {ms} ms"),
        ),
        Err(e) => log(
            Level::Warn,
            "git",
            format!("{cmd} in {cwd}: exit {exit} dopo {ms} ms: {}", tail(e, 500)),
        ),
        Ok(_) if ms > 10_000 => log(
            Level::Warn,
            "git",
            format!("{cmd} in {cwd}: exit {exit} dopo {ms} ms"),
        ),
        Ok(_) => {}
    }
    res
}

// The last `n` characters: git's error is at the end of its stderr.
fn tail(s: &str, n: usize) -> &str {
    let skip = s.chars().count().saturating_sub(n);
    s.char_indices().nth(skip).map_or("", |(i, _)| &s[i..])
}

async fn run_git(
    cwd: &str,
    args: &[&str],
    o: Opts<'_>,
    exit: &mut Option<i32>,
) -> Result<String, String> {
    let mut child = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(if o.input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            if e.kind() == io::ErrorKind::NotFound {
                "spawn git ENOENT".to_string()
            } else {
                e.to_string()
            }
        })?;
    let stdin = child.stdin.take();
    let write = async {
        if let (Some(mut s), Some(text)) = (stdin, o.input) {
            // A git that exits without reading closes the pipe: not an error here.
            let _ = s.write_all(text.as_bytes()).await;
        } // dropped: git reads EOF
        Ok(())
    };
    let (stdout, stderr) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    let (out, err, ()) = match tokio::try_join!(
        read_capped(stdout, o.max_buffer),
        read_capped(stderr, o.max_buffer),
        write
    ) {
        Ok(v) => v,
        Err(e) => {
            let _ = child.kill().await;
            return Err(match (e, o.too_big) {
                (None, Some(msg)) => msg.to_string(),
                (None, None) => "stdout maxBuffer length exceeded".to_string(),
                (Some(e), _) => e.to_string(),
            });
        }
    };
    let status = child.wait().await.map_err(|e| e.to_string())?;
    *exit = status.code();
    if status.code().is_some_and(|c| o.ok_codes.contains(&c)) {
        return Ok(String::from_utf8_lossy(&out).into_owned());
    }
    let stderr = String::from_utf8_lossy(&err);
    let msg = if stderr.is_empty() {
        format!("Command failed: git {}", args.join(" "))
    } else {
        stderr.into_owned()
    };
    Err(js_trim(&msg).to_string())
}

async fn git(cwd: &str, args: &[&str]) -> Result<String, String> {
    git_with(cwd, args, DEFAULT).await
}

pub async fn root(cwd: &str) -> Option<String> {
    git(cwd, &["rev-parse", "--show-toplevel"])
        .await
        .ok()
        .map(|s| js_trim(&s).to_string())
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Branch {
    pub name: String,
    pub upstream: Option<String>,
    pub ahead: u64,
    pub behind: u64,
}

// First "<word> <digits>" in `info`, like /ahead (\d+)/.
fn count(info: &str, word: &str) -> u64 {
    let key = format!("{word} ");
    info.match_indices(&key)
        .find_map(|(i, _)| {
            let digits: String = info[i + key.len()..]
                .chars()
                .take_while(char::is_ascii_digit)
                .collect();
            digits.parse().ok()
        })
        .unwrap_or(0)
}

// "## <branch>[...<upstream>][ [ahead N, behind M]]" from `git status -b`.
// Branch names may contain dots (release/1.2) but never spaces or "...".
pub fn parse_branch_header(head: &str) -> Branch {
    let mut rest = head.strip_prefix("## ").unwrap_or(head);
    let mut info = "";
    // / \[([^\]]*)\]$/: the first " [" after the last inner "]".
    if let Some(inner) = rest.strip_suffix(']') {
        let from = inner.rfind(']').map_or(0, |i| i + 1);
        if let Some(i) = inner[from..].find(" [") {
            info = &inner[from + i + 2..];
            rest = &rest[..from + i];
        }
    }
    for prefix in ["No commits yet on ", "Initial commit on "] {
        if let Some(r) = rest.strip_prefix(prefix) {
            rest = r;
            break;
        }
    }
    let detached = rest.is_empty() || rest.starts_with("HEAD (no branch)");
    let (name, upstream) = if detached {
        ("HEAD", None)
    } else {
        let mut parts = rest.split("...");
        (
            parts.next().unwrap_or(""),
            parts.next().filter(|u| !u.is_empty()),
        )
    };
    Branch {
        name: name.into(),
        upstream: upstream.map(String::from),
        ahead: count(info, "ahead"),
        behind: count(info, "behind"),
    }
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub file: String,
    pub code: char,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_file: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct Status {
    pub branch: Branch,
    pub staged: Vec<Change>,
    pub unstaged: Vec<Change>,
    pub ignored: Option<Vec<String>>,
}

const CONFLICTS: [&str; 7] = ["DD", "AU", "UD", "UA", "DU", "AA", "UU"];

// `with_ignored: false` skips the ignored-files scan (it walks the whole working
// tree): the caller keeps the previous list for frequent refreshes.
pub async fn status(repo: &str, with_ignored: bool) -> Result<Status, String> {
    let ls = async {
        // Ignored entries collapsed to their top folder (node_modules/, dist/…).
        if with_ignored {
            let args = [
                "ls-files",
                "--others",
                "--ignored",
                "--exclude-standard",
                "--directory",
                "-z",
            ];
            Some(git(repo, &args).await.unwrap_or_default())
        } else {
            None
        }
    };
    let (out, ign) = tokio::join!(
        git(
            repo,
            &[
                "status",
                "--porcelain=v1",
                "-b",
                "-z",
                "--untracked-files=all"
            ]
        ),
        ls
    );
    let out = out?;
    let mut entries = out.split('\0').filter(|e| !e.is_empty());
    let branch = parse_branch_header(entries.next().unwrap_or(""));

    let rc = |c: Option<char>| matches!(c, Some('R' | 'C'));
    let (mut staged, mut unstaged) = (vec![], vec![]);
    while let Some(e) = entries.next() {
        let mut chars = e.chars();
        let (x, y) = (chars.next(), chars.next());
        let file = e.get(3..).unwrap_or("").to_string();
        // The rename source follows as its own entry, for renames in the index (R_)
        // and in the working tree (_R, e.g. after `git add -N`); the diff needs it.
        let old_file = if rc(x) || rc(y) {
            entries.next().map(String::from)
        } else {
            None
        };
        if x == Some('?') && y == Some('?') {
            unstaged.push(Change {
                file,
                code: 'U',
                old_file: None,
            });
            continue;
        }
        // Merge conflicts (UU, AA, DU…): one entry with its own code; "U" means untracked here.
        let xy: String = x.into_iter().chain(y).collect();
        if CONFLICTS.contains(&xy.as_str()) {
            unstaged.push(Change {
                file,
                code: 'X',
                old_file: None,
            });
            continue;
        }
        let entry = |code: char| Change {
            file: file.clone(),
            code,
            old_file: old_file.clone().filter(|_| rc(Some(code))),
        };
        if let Some(x) = x.filter(|&c| c != ' ') {
            staged.push(entry(x));
        }
        if let Some(y) = y.filter(|&c| c != ' ') {
            unstaged.push(entry(y));
        }
    }
    let ignored = ign.map(|ign| {
        ign.split('\0')
            .filter(|f| !f.is_empty())
            .map(|f| f.strip_suffix('/').unwrap_or(f).to_string())
            .collect()
    });
    Ok(Status {
        branch,
        staged,
        unstaged,
        ignored,
    })
}

fn words(s: &str, sep: &str) -> Vec<String> {
    if s.is_empty() {
        vec![]
    } else {
        s.split(sep).map(String::from).collect()
    }
}

// Unix seconds to ms, like Number(time) * 1000.
fn ms(s: &str) -> i64 {
    js_trim(s).parse::<i64>().unwrap_or(0) * 1000
}

#[derive(Serialize, Debug)]
pub struct LogEntry {
    pub hash: String,
    pub parents: Vec<String>,
    pub refs: Vec<String>,
    pub author: String,
    pub time: i64,
    pub subject: String,
}

pub async fn log(repo: &str, limit: u32) -> Vec<LogEntry> {
    let fmt = format!(
        "--format={}{REC}",
        ["%H", "%P", "%D", "%an", "%at", "%s"].join(&SEP.to_string())
    );
    let n = format!("-n{limit}");
    // Stashes are not history: their internal WIP/index commits stay out of the graph.
    // --no-show-signature: with log.showSignature set, gpg's lines would mix into the output.
    let args = [
        "log",
        "--no-show-signature",
        "--exclude=refs/stash",
        "--all",
        "--date-order",
        "--decorate=full",
        &n,
        &fmt,
    ];
    let Ok(out) = git(repo, &args).await else {
        return vec![]; // repo without commits
    };
    out.split(REC)
        .map(js_trim)
        .filter(|r| !r.is_empty())
        .map(|r| {
            let p: Vec<&str> = r.split(SEP).collect();
            let f = |i: usize| p.get(i).copied().unwrap_or("");
            LogEntry {
                hash: f(0).into(),
                parents: words(f(1), " "),
                refs: words(f(2), ", "),
                author: f(3).into(),
                time: ms(f(4)),
                subject: f(5).into(),
            }
        })
        .collect()
}

fn short_ref(r: &str) -> &str {
    r.strip_prefix("refs/heads/")
        .or_else(|| r.strip_prefix("refs/remotes/"))
        .unwrap_or(r)
}

#[derive(Serialize, Debug, PartialEq)]
pub struct BranchItem {
    pub name: String,
    pub current: bool,
    pub remote: bool,
}

// Local and remote branches are told apart by their full ref name: a local
// "feature/x" contains a slash too. Names come from the full ref as well:
// refname:short turns a branch named like a tag into "heads/v1.2", which
// checks out as a detached HEAD. origin/HEAD only points at another branch.
pub async fn branches(repo: &str) -> Result<Vec<BranchItem>, String> {
    let fmt = format!("--format=%(HEAD){SEP}%(refname)");
    let out = git(repo, &["branch", "-a", &fmt]).await?;
    Ok(out
        .split('\n')
        .filter_map(|l| {
            let mut p = l.split(SEP);
            let (head, r) = (p.next()?, p.next()?);
            let remote = r.starts_with("refs/remotes/");
            // Detached HEAD shows up as a pseudo-entry "(HEAD detached at …)": not a branch.
            (r.starts_with("refs/") && !(remote && r.ends_with("/HEAD"))).then(|| BranchItem {
                name: short_ref(r).into(),
                current: head == "*",
                remote,
            })
        })
        .collect())
}

async fn parents(repo: &str, hash: &str) -> Result<Vec<String>, String> {
    let out = git(repo, &["rev-list", "--parents", "-n1", hash]).await?;
    Ok(js_trim(&out).split(' ').map(String::from).collect())
}

// Parent to diff a commit against: first parent, or the empty tree for a root commit.
async fn parent_of(repo: &str, hash: &str) -> Result<String, String> {
    Ok(parents(repo, hash)
        .await?
        .into_iter()
        .nth(1)
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| EMPTY_TREE.into()))
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    pub code: char,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_file: Option<String>,
    pub file: String,
    pub add: Option<u64>,
    pub del: Option<u64>,
}

fn lines_count(s: &str) -> Option<u64> {
    (s != "-").then(|| js_trim(s).parse().unwrap_or(0))
}

// name-status + numstat of a commit, joined per file.
async fn commit_files(repo: &str, hash: &str) -> Result<Vec<CommitFile>, String> {
    let parent = parent_of(repo, hash).await?;
    let ns_args = ["diff", "--name-status", "-M", "-z", &parent, hash];
    let num_args = ["diff", "--numstat", "-M", "-z", &parent, hash];
    let (ns, num) = tokio::join!(git(repo, &ns_args), git(repo, &num_args));
    let (ns, num) = (ns?, num?);

    let mut files = vec![];
    let mut t = ns.split('\0').filter(|x| !x.is_empty());
    while let Some(status) = t.next() {
        let code = status.chars().next().unwrap_or_default();
        let mut next = || t.next().unwrap_or("").to_string();
        let old_file = matches!(code, 'R' | 'C').then(&mut next);
        files.push(CommitFile {
            code,
            old_file,
            file: next(),
            add: Some(0),
            del: Some(0),
        });
    }

    // numstat -z: "add\tdel\tpath\0" or, for renames, "add\tdel\t\0old\0new\0"
    let mut stats = HashMap::new();
    let n: Vec<&str> = num.split('\0').collect();
    let mut i = 0;
    while i < n.len() {
        if !n[i].is_empty() {
            let mut parts = n[i].split('\t');
            let (add, del, p) = (
                parts.next().unwrap_or(""),
                parts.next().unwrap_or(""),
                parts.next(),
            );
            let file = if p == Some("") {
                i += 2;
                n.get(i).copied()
            } else {
                p
            };
            stats.insert(file, (lines_count(add), lines_count(del)));
        }
        i += 1;
    }
    for f in &mut files {
        if let Some(&(add, del)) = stats.get(&Some(f.file.as_str())) {
            (f.add, f.del) = (add, del);
        }
    }
    Ok(files)
}

#[derive(Serialize, Debug)]
pub struct CommitDetail {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub committer: String,
    pub ctime: i64,
    pub refs: Vec<String>,
    pub message: String,
    pub files: Vec<CommitFile>,
}

pub async fn commit(repo: &str, hash: &str) -> Result<CommitDetail, String> {
    let fmt = format!(
        "--format={}",
        ["%H", "%P", "%an", "%ae", "%at", "%cn", "%ct", "%D", "%B"].join(&SEP.to_string())
    );
    let out = git(
        repo,
        &[
            "show",
            "-s",
            "--no-show-signature",
            "--decorate=full",
            &fmt,
            hash,
        ],
    )
    .await?;
    let p: Vec<&str> = out.split(SEP).collect();
    let f = |i: usize| p.get(i).copied().unwrap_or("");
    let files = commit_files(repo, f(0)).await?;
    Ok(CommitDetail {
        hash: f(0).into(),
        parents: words(f(1), " "),
        author: f(2).into(),
        email: f(3).into(),
        time: ms(f(4)),
        committer: f(5).into(),
        ctime: ms(f(6)),
        refs: words(f(7), ", "),
        message: js_trim(f(8)).into(),
        files,
    })
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Containing {
    pub name: String,
    pub remote: bool,
}

pub async fn containing(repo: &str, hash: &str) -> Vec<Containing> {
    let Ok(out) = git(
        repo,
        &["branch", "-a", "--contains", hash, "--format=%(refname)"],
    )
    .await
    else {
        return vec![];
    };
    // Full ref names: a local feature/x must not look like a remote branch.
    out.split('\n')
        .filter(|r| !r.is_empty() && !r.ends_with("/HEAD"))
        .map(|r| Containing {
            name: short_ref(r).into(),
            remote: r.starts_with("refs/remotes/"),
        })
        .collect()
}

// JavaScript truthiness of an optional parameter.
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn opt_str<'a>(p: &'a Value, key: &str) -> Option<&'a str> {
    p.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

fn req_str<'a>(p: &'a Value, key: &str) -> Result<&'a str, String> {
    p.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Parametro mancante: {key}"))
}

// Unified diff with the whole file as context.
//  - commit: { hash, file, oldFile }
//  - working copy: { file, staged, untracked }
pub async fn file_diff(repo: &str, spec: &Value) -> Result<String, String> {
    let file = req_str(spec, "file")?;
    let old_file = opt_str(spec, "oldFile").filter(|&o| o != file);
    if let Some(hash) = opt_str(spec, "hash") {
        let parent = parent_of(repo, hash).await?;
        let mut args = vec![
            "diff",
            FULL_CONTEXT,
            "-M",
            PLAIN[0],
            PLAIN[1],
            &parent,
            hash,
            "--",
        ];
        args.extend(old_file);
        args.push(file);
        return git_with(repo, &args, DIFF_LIMIT).await;
    }
    if truthy(spec.get("untracked")) {
        let args = [
            "diff",
            FULL_CONTEXT,
            PLAIN[0],
            PLAIN[1],
            "--no-index",
            "--",
            "/dev/null",
            file,
        ];
        return git_with(
            repo,
            &args,
            Opts {
                ok_codes: &[0, 1],
                ..DIFF_LIMIT
            },
        )
        .await;
    }
    // --ours (-2) only affects conflicted files: a plain diff against our side,
    // with the conflict markers as added lines, instead of a combined "@@@" diff.
    let mut args = vec![
        "diff",
        FULL_CONTEXT,
        PLAIN[0],
        PLAIN[1],
        if truthy(spec.get("staged")) {
            "--cached"
        } else {
            "--ours"
        },
    ];
    match old_file {
        Some(old) => args.extend(["-M", "--", old, file]),
        None => args.extend(["--", file]),
    }
    git_with(repo, &args, DIFF_LIMIT).await
}

async fn is_ref(repo: &str, r: &str) -> bool {
    git(repo, &["rev-parse", "--verify", "--quiet", r])
        .await
        .is_ok()
}

async fn remotes(repo: &str) -> Result<Vec<String>, String> {
    Ok(git(repo, &["remote"])
        .await?
        .split('\n')
        .filter(|r| !r.is_empty())
        .map(String::from)
        .collect())
}

// A remote branch ("upstream/feature", any remote) is checked out as the local
// branch that tracks it, created on first use, instead of a detached HEAD.
async fn checkout(repo: &str, branch: &str) -> Result<String, String> {
    if is_ref(repo, &format!("refs/heads/{branch}")).await {
        return git(repo, &["checkout", branch]).await;
    }
    let remotes = remotes(repo).await?;
    let Some(remote) = remotes
        .iter()
        .find(|r| branch.starts_with(&format!("{r}/")))
    else {
        return git(repo, &["checkout", branch]).await; // tag or commit
    };
    let local = &branch[remote.len() + 1..];
    if is_ref(repo, &format!("refs/heads/{local}")).await {
        return git(repo, &["checkout", local]).await;
    }
    git(repo, &["checkout", "--track", branch]).await
}

// Push the current branch to the remote it already tracks; a new branch goes
// to origin if there is one, else to the repository's only (or first) remote.
async fn push(repo: &str) -> Result<String, String> {
    let branch = git(repo, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .await
        .unwrap_or_default();
    let branch = js_trim(&branch);
    if branch.is_empty() {
        return Err("HEAD staccato: crea un branch da qui prima di fare push.".into());
    }
    let tracked = git(repo, &["config", &format!("branch.{branch}.remote")])
        .await
        .unwrap_or_default();
    let tracked = js_trim(&tracked);
    let remotes = remotes(repo).await?;
    if tracked.is_empty() && remotes.is_empty() {
        return Err(
            "Nessun remote: aggiungine uno (git remote add origin <url>) per fare push.".into(),
        );
    }
    let remote = if !tracked.is_empty() {
        tracked
    } else if remotes.iter().any(|r| r == "origin") {
        "origin"
    } else {
        &remotes[0]
    };
    git(repo, &["push", "-u", remote, "HEAD"]).await
}

// A staged rename is unstaged whole: its source's deletion goes with it.
// Before the first commit there is no HEAD to restore from: just untrack.
async fn unstage(repo: &str, files: &[&str]) -> Result<String, String> {
    let staged = status(repo, false).await?.staged;
    let mut paths = files.to_vec();
    paths.extend(
        staged
            .iter()
            .filter(|f| files.contains(&f.file.as_str()))
            .filter_map(|f| f.old_file.as_deref()),
    );
    let args = if is_ref(repo, "HEAD").await {
        vec!["restore", "--staged", "--"]
    } else {
        vec!["rm", "--cached", "-q", "--"]
    };
    git(repo, &[args, paths].concat()).await
}

// `git stash push` succeeds without doing anything when there is nothing to
// save; the stash ref is compared instead of its (translated) message.
async fn stash(repo: &str) -> Result<(), String> {
    let top = || async {
        git(repo, &["rev-parse", "--verify", "--quiet", "refs/stash"])
            .await
            .ok()
            .map(|h| js_trim(&h).to_string())
    };
    let before = top().await;
    git(repo, &["stash", "push", "-u"]).await?;
    if top().await == before {
        return Err("Nessuna modifica da mettere in stash.".into());
    }
    Ok(())
}

// A merge commit is reverted or cherry-picked relative to its first parent
// (the branch it was merged into); git refuses without -m.
async fn mainline(repo: &str, hash: &str) -> Result<Vec<&'static str>, String> {
    Ok(if parents(repo, hash).await?.len() > 2 {
        vec!["-m", "1"]
    } else {
        vec![]
    })
}

fn files_of(p: &Value) -> Result<Vec<&str>, String> {
    p.get("files")
        .and_then(Value::as_array)
        .ok_or("Parametro mancante: files")?
        .iter()
        .map(|f| {
            f.as_str()
                .ok_or_else(|| "Parametro non valido: files".to_string())
        })
        .collect()
}

// The result is git's output (null for stash), like the JS actions resolved.
pub async fn action(repo: &str, name: &str, p: &Value) -> Result<Value, String> {
    let out = match name {
        "stage" => git(repo, &[&["add", "--"][..], &files_of(p)?].concat()).await,
        "unstage" => unstage(repo, &files_of(p)?).await,
        "discard" => git(repo, &[&["checkout", "--"][..], &files_of(p)?].concat()).await,
        "stageAll" => git(repo, &["add", "-A"]).await,
        "commit" => {
            let mut args = vec!["commit", "-F", "-"];
            if truthy(p.get("amend")) {
                args.push("--amend");
            }
            let message = p.get("message").and_then(Value::as_str).unwrap_or("");
            git_with(
                repo,
                &args,
                Opts {
                    input: Some(message),
                    ..DEFAULT
                },
            )
            .await
        }
        "checkout" => checkout(repo, req_str(p, "branch")?).await,
        "createBranch" => {
            let mut args = vec!["checkout", "-b", req_str(p, "name")?];
            args.extend(opt_str(p, "from"));
            git(repo, &args).await
        }
        "fetch" => git(repo, &["fetch", "--all", "--prune"]).await,
        "pull" => {
            if !is_ref(repo, "@{upstream}").await {
                return Err("Il branch non segue nessun ramo remoto: fai prima push (lo collega) o fai checkout di un ramo remoto.".into());
            }
            git(repo, &["pull", "--ff-only"]).await
        }
        "push" => push(repo).await,
        "stash" => return stash(repo).await.map(|()| Value::Null),
        "stashPop" => {
            if !is_ref(repo, "refs/stash").await {
                return Err("Nessuno stash da ripristinare.".into());
            }
            git(repo, &["stash", "pop"]).await
        }
        "merge" => git(repo, &["merge", "--no-edit", req_str(p, "branch")?]).await,
        "cherryPick" => {
            let hash = req_str(p, "hash")?;
            git(
                repo,
                &[&["cherry-pick"][..], &mainline(repo, hash).await?, &[hash]].concat(),
            )
            .await
        }
        "revert" => {
            let hash = req_str(p, "hash")?;
            git(
                repo,
                &[
                    &["revert", "--no-edit"][..],
                    &mainline(repo, hash).await?,
                    &[hash],
                ]
                .concat(),
            )
            .await
        }
        "init" => git(repo, &["init"]).await,
        _ => return Err(format!("Azione git sconosciuta: {name}")),
    };
    out.map(Value::String)
}

// ── Tauri commands ───────────────────────────────────────────
#[tauri::command]
pub async fn git_root(cwd: String) -> Option<String> {
    root(&cwd).await
}

#[tauri::command]
pub async fn git_status(repo: String, opts: Option<Value>) -> Result<Status, String> {
    // `{ ignored = true }`: only a missing key defaults to the full scan.
    let with_ignored = opts
        .as_ref()
        .and_then(|o| o.get("ignored"))
        .is_none_or(|v| truthy(Some(v)));
    status(&repo, with_ignored).await
}

#[tauri::command]
pub async fn git_log(repo: String) -> Vec<LogEntry> {
    log(&repo, 400).await
}

#[tauri::command]
pub async fn git_branches(repo: String) -> Result<Vec<BranchItem>, String> {
    branches(&repo).await
}

#[tauri::command]
pub async fn git_commit(repo: String, hash: String) -> Result<CommitDetail, String> {
    commit(&repo, &hash).await
}

#[tauri::command]
pub async fn git_containing(repo: String, hash: String) -> Vec<Containing> {
    containing(&repo, &hash).await
}

#[tauri::command]
pub async fn git_file_diff(repo: String, spec: Value) -> Result<String, String> {
    file_diff(&repo, &spec).await
}

#[tauri::command]
pub async fn git_action(
    repo: String,
    name: String,
    params: Option<Value>,
) -> Result<Value, String> {
    action(
        &repo,
        &name,
        &params.unwrap_or_else(|| serde_json::json!({})),
    )
    .await
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_failed_git_call_logs_a_warning_with_exit_and_stderr() {
        let dir = tempfile::tempdir().unwrap();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let res = rt.block_on(git(
            dir.path().to_str().unwrap(),
            &["rev-parse", "--verify", "ramo-che-non-esiste-qx"],
        ));
        assert!(res.is_err());
        let logged = crate::diag::CAPTURED.lock().unwrap().join("");
        let line = logged
            .lines()
            .find(|l| l.contains("ramo-che-non-esiste-qx"))
            .expect(&logged);
        assert!(
            line.contains(" WARN  git ")
                && line.contains("exit 128 dopo ")
                && line.contains("fatal: "),
            "{line}"
        );
    }

    #[test]
    fn the_tail_keeps_the_last_characters() {
        assert_eq!(tail("abcdè", 2), "dè");
        assert_eq!(tail("ab", 5), "ab");
    }

    use super::*;
    use serde_json::json;
    use std::fs;
    use std::path::Path;
    use std::process::Command as Cmd;

    fn run_in(dir: &Path, args: &[&str]) -> Result<String, String> {
        let out = Cmd::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).into_owned())
        }
    }

    struct Repo {
        tmp: tempfile::TempDir,
    }

    impl Repo {
        fn new() -> Self {
            let r = Repo {
                tmp: tempfile::Builder::new()
                    .prefix("work-git-")
                    .tempdir()
                    .unwrap(),
            };
            r.run(&["init", "-q"]);
            r.run(&["symbolic-ref", "HEAD", "refs/heads/main"]);
            r.run(&["config", "user.email", "t@example.com"]);
            r.run(&["config", "user.name", "Test"]);
            r
        }
        fn path(&self) -> &Path {
            self.tmp.path()
        }
        fn dir(&self) -> &str {
            self.path().to_str().unwrap()
        }
        fn try_run(&self, args: &[&str]) -> Result<String, String> {
            run_in(self.path(), args)
        }
        fn run(&self, args: &[&str]) -> String {
            self.try_run(args)
                .unwrap_or_else(|e| panic!("git {args:?}: {e}"))
        }
        fn write(&self, file: &str, text: &str) {
            let p = self.path().join(file);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, text).unwrap();
        }
        fn commit(&self, msg: &str) -> String {
            self.run(&["add", "-A"]);
            self.run(&["commit", "-qm", msg]);
            self.run(&["rev-parse", "HEAD"]).trim().to_string()
        }
        async fn status(&self) -> Status {
            status(self.dir(), true).await.unwrap()
        }
        async fn action(&self, name: &str, p: Value) -> Result<Value, String> {
            action(self.dir(), name, &p).await
        }
    }

    fn ch(file: &str, code: char, old_file: Option<&str>) -> Change {
        Change {
            file: file.into(),
            code,
            old_file: old_file.map(String::from),
        }
    }

    fn has_line(text: &str, line: &str) -> bool {
        text.lines().any(|l| l == line)
    }

    // ── parseBranchHeader (git-branch.test.js) ──
    fn br(name: &str, upstream: Option<&str>, ahead: u64, behind: u64) -> Branch {
        Branch {
            name: name.into(),
            upstream: upstream.map(String::from),
            ahead,
            behind,
        }
    }

    #[test]
    fn legge_ramo_e_upstream_semplici() {
        assert_eq!(
            parse_branch_header("## main...origin/main"),
            br("main", Some("origin/main"), 0, 0)
        );
    }

    #[test]
    fn i_nomi_di_ramo_con_punti_non_vengono_troncati_regressione() {
        assert_eq!(
            parse_branch_header("## release/1.2...origin/release/1.2 [ahead 1]"),
            br("release/1.2", Some("origin/release/1.2"), 1, 0)
        );
    }

    #[test]
    fn legge_insieme_commit_avanti_e_indietro() {
        let b = parse_branch_header("## v2.0.1-fix...upstream/v2.0.1-fix [ahead 3, behind 12]");
        assert_eq!((b.ahead, b.behind), (3, 12));
    }

    #[test]
    fn un_upstream_cancellato_non_produce_conteggi() {
        assert_eq!(
            parse_branch_header("## feat/x...origin/feat/x [gone]"),
            br("feat/x", Some("origin/feat/x"), 0, 0)
        );
    }

    #[test]
    fn un_ramo_senza_upstream_ha_upstream_null() {
        assert_eq!(parse_branch_header("## main").upstream, None);
    }

    #[test]
    fn un_repository_senza_commit_riporta_il_nome_del_ramo() {
        assert_eq!(
            parse_branch_header("## No commits yet on main").name,
            "main"
        );
    }

    #[test]
    fn head_staccato_viene_riportato_come_head() {
        assert_eq!(parse_branch_header("## HEAD (no branch)").name, "HEAD");
    }

    // ── JSON shapes the renderer reads ──
    #[test]
    fn json_shapes_match_the_js_objects() {
        let c = serde_json::to_string(&ch("b.txt", 'R', Some("a.txt"))).unwrap();
        assert_eq!(c, r#"{"file":"b.txt","code":"R","oldFile":"a.txt"}"#);
        assert_eq!(
            serde_json::to_string(&ch("a", 'M', None)).unwrap(),
            r#"{"file":"a","code":"M"}"#
        );
        let s = Status {
            branch: br("main", None, 0, 0),
            staged: vec![],
            unstaged: vec![],
            ignored: None,
        };
        assert_eq!(
            serde_json::to_string(&s).unwrap(),
            r#"{"branch":{"name":"main","upstream":null,"ahead":0,"behind":0},"staged":[],"unstaged":[],"ignored":null}"#
        );
        let f = CommitFile {
            code: 'R',
            old_file: Some("a".into()),
            file: "b".into(),
            add: None,
            del: Some(0),
        };
        assert_eq!(
            serde_json::to_string(&f).unwrap(),
            r#"{"code":"R","oldFile":"a","file":"b","add":null,"del":0}"#
        );
    }

    // ── git-repo.test.js ──
    #[tokio::test]
    async fn status_separa_file_in_stage_modificati_e_non_tracciati() {
        let r = Repo::new();
        r.write("a.txt", "1\n");
        r.commit("init");
        r.write("a.txt", "2\n");
        r.write("new.txt", "x\n");
        r.write("staged.txt", "s\n");
        r.run(&["add", "staged.txt"]);
        let mut st = r.status().await;
        assert_eq!(st.staged, vec![ch("staged.txt", 'A', None)]);
        st.unstaged.sort_by(|a, b| a.file.cmp(&b.file));
        assert_eq!(
            st.unstaged,
            vec![ch("a.txt", 'M', None), ch("new.txt", 'U', None)]
        );
    }

    #[tokio::test]
    async fn una_rinomina_solo_nella_copia_di_lavoro_non_crea_file_fantasma_regressione() {
        let r = Repo::new();
        r.write("a.txt", "uno\ndue\ntre\nquattro\n");
        r.commit("init");
        fs::rename(r.path().join("a.txt"), r.path().join("b.txt")).unwrap();
        r.run(&["add", "-N", "b.txt"]);
        let st = r.status().await;
        assert_eq!(st.staged, vec![]);
        assert_eq!(st.unstaged, vec![ch("b.txt", 'R', Some("a.txt"))]);
    }

    #[tokio::test]
    async fn status_riporta_le_cartelle_ignorate_come_una_sola_voce() {
        let r = Repo::new();
        r.write(".gitignore", "node_modules/\n");
        r.write("node_modules/x/a.js", "");
        r.commit("init");
        assert_eq!(
            r.status().await.ignored,
            Some(vec!["node_modules".to_string()])
        );
    }

    #[tokio::test]
    async fn status_senza_scansione_degli_ignorati_restituisce_ignored_null() {
        let r = Repo::new();
        r.write(".gitignore", "dist/\n");
        r.write("dist/out.js", "x");
        r.write("a.txt", "1\n");
        let st = git_status(r.dir().into(), Some(json!({ "ignored": false })))
            .await
            .unwrap();
        assert_eq!(st.ignored, None);
        assert!(st.unstaged.iter().any(|f| f.file == "a.txt"));
        // Without opts the scan runs, as with `{ ignored = true } = {}`.
        assert!(git_status(r.dir().into(), None)
            .await
            .unwrap()
            .ignored
            .is_some());
    }

    #[tokio::test]
    async fn status_legge_un_ramo_con_punti_nel_nome_da_un_repository_reale() {
        let r = Repo::new();
        r.write("a.txt", "1\n");
        r.commit("init");
        r.run(&["checkout", "-q", "-b", "release/1.2"]);
        assert_eq!(r.status().await.branch.name, "release/1.2");
    }

    #[tokio::test]
    async fn i_file_di_un_commit_riportano_stato_rinomine_e_righe_aggiunte_tolte() {
        let r = Repo::new();
        r.write("a.txt", "uno\ndue\n");
        r.write("b.txt", "b\n");
        r.commit("init");
        r.write("a.txt", "uno\nDUE\ntre\n");
        r.run(&["mv", "b.txt", "c.txt"]);
        let hash = r.commit("change");
        let c = commit(r.dir(), &hash).await.unwrap();
        assert_eq!(c.message, "change");
        let a = c.files.iter().find(|f| f.file == "a.txt").unwrap();
        assert_eq!((a.code, a.add, a.del), ('M', Some(2), Some(1)));
        let cf = c.files.iter().find(|f| f.file == "c.txt").unwrap();
        assert_eq!((cf.code, cf.old_file.as_deref()), ('R', Some("b.txt")));
    }

    #[tokio::test]
    async fn il_primo_commit_viene_confrontato_con_un_albero_vuoto() {
        let r = Repo::new();
        r.write("a.txt", "x\n");
        let hash = r.commit("root");
        let c = commit(r.dir(), &hash).await.unwrap();
        let files: Vec<_> = c
            .files
            .iter()
            .map(|f| (f.file.as_str(), f.code, f.add))
            .collect();
        assert_eq!(files, vec![("a.txt", 'A', Some(1))]);
    }

    #[tokio::test]
    async fn il_diff_di_un_file_non_tracciato_lo_mostra_tutto_come_aggiunto() {
        let r = Repo::new();
        r.write("a.txt", "x\n");
        r.commit("init");
        r.write("nuovo.txt", "uno\ndue\n");
        let diff = file_diff(r.dir(), &json!({ "file": "nuovo.txt", "untracked": true }))
            .await
            .unwrap();
        assert!(has_line(&diff, "+uno"));
        assert!(has_line(&diff, "+due"));
    }

    #[tokio::test]
    async fn il_diff_include_tutto_il_file_come_contesto() {
        let r = Repo::new();
        let mut lines: Vec<String> = (1..=50).map(|i| format!("riga {i}")).collect();
        r.write("a.txt", &format!("{}\n", lines.join("\n")));
        r.commit("init");
        lines[25] = "cambiata".into();
        r.write("a.txt", &format!("{}\n", lines.join("\n")));
        let diff = file_diff(r.dir(), &json!({ "file": "a.txt" }))
            .await
            .unwrap();
        assert!(has_line(&diff, " riga 1"));
        assert!(has_line(&diff, " riga 50"));
    }

    #[tokio::test]
    async fn branches_distingue_i_rami_locali_con_slash_dai_remoti_regressione() {
        let origin = Repo::new();
        origin.write("a.txt", "1\n");
        origin.commit("init");
        let clone = tempfile::Builder::new()
            .prefix("work-clone-")
            .tempdir()
            .unwrap();
        run_in(clone.path(), &["clone", "-q", origin.dir(), "."]).unwrap();
        run_in(clone.path(), &["branch", "feature/x"]).unwrap();
        run_in(clone.path(), &["checkout", "-q", "feature/x"]).unwrap();
        let list = branches(clone.path().to_str().unwrap()).await.unwrap();
        let by = |n: &str| list.iter().find(|b| b.name == n).unwrap();
        assert_eq!(
            by("feature/x"),
            &BranchItem {
                name: "feature/x".into(),
                current: true,
                remote: false
            }
        );
        assert!(!by("main").remote);
        assert!(by("origin/main").remote);
        assert!(
            !list
                .iter()
                .any(|b| b.name == "origin" || b.name.ends_with("/HEAD")),
            "origin/HEAD is not a branch"
        );
    }

    #[tokio::test]
    async fn un_ramo_con_lo_stesso_nome_di_un_tag_si_chiama_e_si_fa_checkout_con_il_suo_nome_regressione(
    ) {
        let r = Repo::new();
        r.write("a.txt", "1\n");
        r.commit("init");
        r.run(&["tag", "v1.2"]);
        r.run(&["branch", "v1.2"]);
        let list = branches(r.dir()).await.unwrap();
        let mut names: Vec<_> = list.iter().map(|b| b.name.as_str()).collect();
        names.sort();
        assert_eq!(names, ["main", "v1.2"], "not \"heads/v1.2\"");
        r.action("checkout", json!({ "branch": "v1.2" }))
            .await
            .unwrap();
        assert_eq!(
            r.status().await.branch.name,
            "v1.2",
            "on the branch, not a detached HEAD"
        );
    }

    #[tokio::test]
    async fn il_log_distingue_rami_locali_con_slash_dai_remoti_decorazioni_complete() {
        let r = Repo::new();
        r.write("a.txt", "x\n");
        r.commit("init");
        r.run(&["branch", "feature/x"]);
        let log = log(r.dir(), 400).await;
        assert!(
            log[0].refs.iter().any(|x| x == "refs/heads/feature/x"),
            "refs were: {:?}",
            log[0].refs
        );
    }

    #[tokio::test]
    async fn il_checkout_di_un_ramo_remoto_di_qualsiasi_remote_crea_il_ramo_locale_che_lo_segue_regressione(
    ) {
        let up = Repo::new();
        up.write("a.txt", "1\n");
        up.commit("init");
        up.run(&["branch", "feature"]);
        let r = Repo::new();
        r.run(&["remote", "add", "upstream", up.dir()]);
        r.run(&["fetch", "-q", "upstream"]);
        r.action("checkout", json!({ "branch": "upstream/feature" }))
            .await
            .unwrap();
        assert_eq!(r.status().await.branch.name, "feature");
        assert_eq!(
            r.run(&["rev-parse", "--abbrev-ref", "feature@{upstream}"])
                .trim(),
            "upstream/feature"
        );
        // Checking out the same remote branch again switches to the existing local one.
        r.action("checkout", json!({ "branch": "upstream/main" }))
            .await
            .unwrap();
        r.action("checkout", json!({ "branch": "upstream/feature" }))
            .await
            .unwrap();
        assert_eq!(r.status().await.branch.name, "feature");
    }

    #[tokio::test]
    async fn commit_tramite_action_usa_il_messaggio_da_stdin_e_cambia_lo_stato() {
        let r = Repo::new();
        r.write("a.txt", "x\n");
        r.commit("init");
        r.write("a.txt", "y\n");
        r.action("stageAll", json!({})).await.unwrap();
        r.action(
            "commit",
            json!({ "message": "messaggio con \"virgolette\" e $simboli" }),
        )
        .await
        .unwrap();
        assert_eq!(
            log(r.dir(), 400).await[0].subject,
            "messaggio con \"virgolette\" e $simboli"
        );
        assert_eq!(r.status().await.staged.len(), 0);
    }

    #[tokio::test]
    async fn un_azione_sconosciuta_viene_rifiutata() {
        let r = Repo::new();
        let err = git_action(r.dir().into(), "rm -rf".into(), None)
            .await
            .unwrap_err();
        assert!(err.contains("sconosciuta"), "{err}");
    }

    #[tokio::test]
    async fn root_trova_la_cima_del_repository_da_una_sottocartella_e_null_fuori_da_un_repository()
    {
        let r = Repo::new();
        r.write("src/deep/a.txt", "1\n");
        let deep = r.path().join("src/deep");
        let real = fs::canonicalize(r.path()).unwrap();
        assert_eq!(root(deep.to_str().unwrap()).await.as_deref(), real.to_str());
        let norepo = tempfile::Builder::new()
            .prefix("work-norepo-")
            .tempdir()
            .unwrap();
        assert_eq!(root(norepo.path().to_str().unwrap()).await, None);
    }

    #[tokio::test]
    async fn containing_elenca_solo_i_rami_che_contengono_il_commit() {
        let r = Repo::new();
        r.write("a.txt", "1\n");
        let base = r.commit("base");
        r.run(&["checkout", "-q", "-b", "feature/x"]);
        r.write("a.txt", "2\n");
        let tip = r.commit("feature");
        let mut names: Vec<_> = containing(r.dir(), &base)
            .await
            .into_iter()
            .map(|b| b.name)
            .collect();
        names.sort();
        assert_eq!(names, ["feature/x", "main"]);
        assert_eq!(
            containing(r.dir(), &tip).await,
            vec![Containing {
                name: "feature/x".into(),
                remote: false
            }]
        );
        assert_eq!(containing(r.dir(), "non-esiste").await, vec![]);
    }

    #[tokio::test]
    async fn containing_distingue_rami_locali_e_remoti_dal_nome_completo_non_dallo_slash_regressione(
    ) {
        let r = Repo::new();
        r.write("a.txt", "1\n");
        let base = r.commit("base");
        r.run(&["branch", "feature/x"]);
        r.run(&["update-ref", "refs/remotes/origin/main", &base]);
        r.run(&[
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/main",
        ]);
        let mut list: Vec<_> = containing(r.dir(), &base)
            .await
            .into_iter()
            .map(|b| (b.name, b.remote))
            .collect();
        list.sort();
        assert_eq!(
            list,
            [
                ("feature/x".into(), false),
                ("main".into(), false),
                ("origin/main".into(), true)
            ]
        );
    }

    #[tokio::test]
    async fn il_diff_di_un_commit_con_rinomina_confronta_il_vecchio_e_il_nuovo_percorso() {
        let r = Repo::new();
        r.write("vecchio.txt", "uno\ndue\ntre\nquattro\ncinque\n");
        r.commit("init");
        r.run(&["mv", "vecchio.txt", "nuovo.txt"]);
        r.write("nuovo.txt", "uno\ndue\nTRE\nquattro\ncinque\n");
        let hash = r.commit("rinomina e modifica");
        let text = file_diff(
            r.dir(),
            &json!({ "hash": hash, "file": "nuovo.txt", "oldFile": "vecchio.txt" }),
        )
        .await
        .unwrap();
        assert!(text.contains("rename from vecchio.txt"));
        assert!(text.contains("rename to nuovo.txt"));
        assert!(has_line(&text, "-tre"));
        assert!(has_line(&text, "+TRE"));
    }

    #[tokio::test]
    async fn il_log_del_graph_non_mostra_i_commit_interni_degli_stash_regressione() {
        let r = Repo::new();
        r.write("a.txt", "1\n");
        r.commit("init");
        r.write("a.txt", "2\n");
        r.run(&["stash", "push", "-q"]);
        let subjects: Vec<_> = log(r.dir(), 400)
            .await
            .into_iter()
            .map(|c| c.subject)
            .collect();
        assert_eq!(subjects, ["init"]);
    }

    #[tokio::test]
    async fn togliere_un_file_dallo_stage_funziona_anche_in_un_repository_senza_commit_regressione()
    {
        let r = Repo::new();
        r.write("a.txt", "1\n");
        r.write("b.txt", "2\n");
        r.run(&["add", "a.txt", "b.txt"]);
        r.action("unstage", json!({ "files": ["a.txt"] }))
            .await
            .unwrap();
        let st = r.status().await;
        assert_eq!(st.staged, vec![ch("b.txt", 'A', None)]);
        assert!(
            st.unstaged
                .iter()
                .any(|f| f.file == "a.txt" && f.code == 'U'),
            "back to untracked"
        );
        assert!(r.path().join("a.txt").exists(), "the file itself is kept");
    }

    #[tokio::test]
    async fn push_funziona_anche_se_il_remote_non_si_chiama_origin_regressione() {
        let remote = tempfile::Builder::new()
            .prefix("work-bare-")
            .tempdir()
            .unwrap();
        run_in(remote.path(), &["init", "-q", "--bare", "."]).unwrap();
        let r = Repo::new();
        r.write("a.txt", "1\n");
        r.commit("init");
        r.run(&["remote", "add", "upstream", remote.path().to_str().unwrap()]);
        // First push of a new branch: sets the upstream on the only remote.
        r.action("push", json!({})).await.unwrap();
        assert_eq!(
            r.run(&["rev-parse", "--abbrev-ref", "main@{upstream}"])
                .trim(),
            "upstream/main"
        );
        // Later pushes follow the configured upstream.
        r.write("a.txt", "2\n");
        let second = r.commit("second");
        r.action("push", json!({})).await.unwrap();
        assert_eq!(
            run_in(remote.path(), &["rev-parse", "main"])
                .unwrap()
                .trim(),
            second
        );
    }

    fn conflicted() -> Repo {
        let r = Repo::new();
        r.write("a.txt", "base\n");
        r.commit("base");
        r.run(&["checkout", "-q", "-b", "altro"]);
        r.write("a.txt", "altro\n");
        r.commit("altro");
        r.run(&["checkout", "-q", "main"]);
        r.write("a.txt", "main\n");
        r.commit("main");
        assert!(r.try_run(&["merge", "altro"]).is_err());
        r
    }

    #[tokio::test]
    async fn un_file_in_conflitto_di_merge_e_segnalato_come_conflitto_non_come_file_non_tracciato_regressione(
    ) {
        let r = conflicted();
        let st = r.status().await;
        assert_eq!(st.unstaged, vec![ch("a.txt", 'X', None)]);
        assert_eq!(st.staged, vec![], "nothing of it is staged yet");
    }

    // The JS test runs the renderer's parseDiff; here the same facts are read
    // off the unified diff: a plain (not "@@@" combined) diff whose added
    // lines hold the conflict markers and their side.
    #[tokio::test]
    async fn il_diff_di_un_file_in_conflitto_si_apre_e_mostra_i_marcatori_come_righe_aggiunte_regressione(
    ) {
        let r = conflicted();
        let diff = file_diff(r.dir(), &json!({ "file": "a.txt" }))
            .await
            .unwrap();
        assert!(
            diff.lines().any(|l| l.starts_with("@@ ")),
            "plain hunks: {diff}"
        );
        assert!(!diff.lines().any(|l| l.starts_with("@@@")));
        let added: Vec<_> = diff
            .lines()
            .filter(|l| l.starts_with('+') && !l.starts_with("+++ "))
            .map(|l| &l[1..])
            .collect();
        assert!(
            added.iter().any(|t| t.starts_with("<<<<<<<")),
            "conflict start marker"
        );
        assert!(added.contains(&"altro"), "their side");
    }

    #[tokio::test]
    async fn i_diff_ignorano_un_diff_esterno_configurato_dall_utente_come_difftastic_regressione() {
        let r = Repo::new();
        r.write("a.txt", "uno\n");
        let hash = r.commit("init");
        r.run(&["config", "diff.external", "sh -c \"echo DIFF-ESTERNO\""]);
        r.write("a.txt", "due\n");
        let working = file_diff(r.dir(), &json!({ "file": "a.txt" }))
            .await
            .unwrap();
        assert!(!working.contains("DIFF-ESTERNO"));
        assert!(has_line(&working, "-uno"));
        let of_commit = file_diff(r.dir(), &json!({ "hash": hash, "file": "a.txt" }))
            .await
            .unwrap();
        assert!(!of_commit.contains("DIFF-ESTERNO"));
        assert!(has_line(&of_commit, "+uno"));
    }

    #[tokio::test]
    async fn log_e_dettaglio_di_un_commit_firmato_si_leggono_anche_con_log_show_signature_attivo_regressione(
    ) {
        if Cmd::new("gpg").arg("--version").output().is_err() {
            eprintln!("skipped: gpg non installato");
            return;
        }
        // Isolated keyring, removed with the temp folder; set only on the commands
        // that sign, the code under test runs with --no-show-signature.
        let gnupg = tempfile::Builder::new()
            .prefix("work-gpg-")
            .tempdir()
            .unwrap();
        let ok = Cmd::new("gpg")
            .env("GNUPGHOME", gnupg.path())
            .args([
                "--batch",
                "--passphrase",
                "",
                "--quick-gen-key",
                "Test <t@example.com>",
                "default",
                "default",
                "never",
            ])
            .output()
            .unwrap();
        assert!(ok.status.success());
        let r = Repo::new();
        r.run(&["config", "user.signingkey", "t@example.com"]);
        r.write("a.txt", "1\n");
        r.run(&["add", "-A"]);
        let signed = Cmd::new("git")
            .env("GNUPGHOME", gnupg.path())
            .args(["-c", "commit.gpgsign=true", "commit", "-qm", "firmato"])
            .current_dir(r.path())
            .output()
            .unwrap();
        assert!(signed.status.success());
        let hash = r.run(&["rev-parse", "HEAD"]).trim().to_string();
        r.run(&["config", "log.showSignature", "true"]);
        let c = &log(r.dir(), 400).await[0];
        assert_eq!(
            (c.hash.as_str(), c.subject.as_str()),
            (hash.as_str(), "firmato")
        );
        let detail = commit(r.dir(), &hash).await.unwrap();
        assert_eq!(
            (detail.hash.as_str(), detail.message.as_str()),
            (hash.as_str(), "firmato")
        );
    }

    #[tokio::test]
    async fn una_rinomina_in_stage_mostra_il_diff_rispetto_al_vecchio_file_regressione() {
        let r = Repo::new();
        let text = |ten: &str| {
            (1..=20)
                .map(|i| {
                    if i == 10 {
                        ten.to_string()
                    } else {
                        i.to_string()
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
                + "\n"
        };
        r.write("vecchio.txt", &text("10"));
        r.commit("init");
        r.run(&["mv", "vecchio.txt", "nuovo.txt"]);
        r.write("nuovo.txt", &text("dieci"));
        r.run(&["add", "nuovo.txt"]);
        let st = r.status().await;
        assert_eq!(st.staged, vec![ch("nuovo.txt", 'R', Some("vecchio.txt"))]);
        let diff = file_diff(
            r.dir(),
            &json!({ "file": "nuovo.txt", "oldFile": "vecchio.txt", "staged": true }),
        )
        .await
        .unwrap();
        assert!(diff.contains("rename from vecchio.txt"));
        let added = diff
            .lines()
            .filter(|l| l.starts_with('+') && l.chars().nth(1).is_some_and(|c| c != '+'))
            .count();
        assert_eq!(added, 1, "only the changed line is added");
    }

    #[tokio::test]
    async fn togliere_dallo_stage_un_file_rinominato_toglie_anche_la_cancellazione_del_vecchio_regressione(
    ) {
        let r = Repo::new();
        r.write("vecchio.txt", "contenuto\n");
        r.commit("init");
        r.run(&["mv", "vecchio.txt", "nuovo.txt"]);
        r.action("unstage", json!({ "files": ["nuovo.txt"] }))
            .await
            .unwrap();
        let st = r.status().await;
        assert_eq!(st.staged, vec![], "nothing left half-staged");
        let mut u: Vec<_> = st
            .unstaged
            .iter()
            .map(|f| (f.file.as_str(), f.code))
            .collect();
        u.sort();
        assert_eq!(u, [("nuovo.txt", 'U'), ("vecchio.txt", 'D')]);
    }

    #[tokio::test]
    async fn stash_senza_modifiche_da_salvare_lo_segnala_invece_di_dare_successo_regressione() {
        let r = Repo::new();
        r.write("a.txt", "1\n");
        r.commit("init");
        assert!(r
            .action("stash", json!({}))
            .await
            .unwrap_err()
            .contains("Nessuna modifica"));
        r.write("a.txt", "2\n");
        r.write("nuovo.txt", "x\n");
        assert_eq!(r.action("stash", json!({})).await, Ok(Value::Null));
        let st = r.status().await;
        assert!(
            st.staged.is_empty() && st.unstaged.is_empty(),
            "changes and untracked files went into the stash"
        );
        assert!(
            r.action("stash", json!({}))
                .await
                .unwrap_err()
                .contains("Nessuna modifica"),
            "a second stash has nothing left to save"
        );
    }

    #[tokio::test]
    async fn push_con_head_staccato_spiega_cosa_fare_invece_dell_errore_grezzo_di_git() {
        let r = Repo::new();
        r.write("a.txt", "1\n");
        r.commit("init");
        r.run(&["checkout", "-q", "--detach"]);
        assert!(r
            .action("push", json!({}))
            .await
            .unwrap_err()
            .contains("HEAD staccato"));
    }

    #[tokio::test]
    async fn un_diff_enorme_viene_rifiutato_con_un_messaggio_chiaro_invece_di_un_errore_tecnico_regressione(
    ) {
        let r = Repo::new();
        r.write("a.txt", "1\n");
        r.commit("init");
        r.write(
            "huge.log",
            &"riga di log con un po' di testo\n".repeat(300000),
        ); // ~9 MB, untracked
        let err = file_diff(r.dir(), &json!({ "file": "huge.log", "untracked": true }))
            .await
            .unwrap_err();
        assert!(
            err.contains("Differenze troppo grandi da mostrare"),
            "{err}"
        );
        assert_eq!(
            file_diff(r.dir(), &json!({ "file": "a.txt" }))
                .await
                .unwrap(),
            "",
            "normal diffs still work"
        );
    }

    #[tokio::test]
    async fn con_head_staccato_branches_non_restituisce_la_voce_finta_head_detached_regressione() {
        let r = Repo::new();
        r.write("a.txt", "1\n");
        r.commit("init");
        r.run(&["checkout", "-q", "--detach"]);
        let list = branches(r.dir()).await.unwrap();
        assert_eq!(
            list,
            vec![BranchItem {
                name: "main".into(),
                current: false,
                remote: false
            }]
        );
    }

    #[tokio::test]
    async fn revert_e_cherry_pick_funzionano_anche_su_un_commit_di_merge_rispetto_al_primo_genitore_regressione(
    ) {
        let r = Repo::new();
        r.write("a.txt", "1\n");
        r.commit("init");
        r.run(&["checkout", "-q", "-b", "feature"]);
        r.write("b.txt", "nuovo\n");
        r.commit("feature");
        r.run(&["checkout", "-q", "main"]);
        r.run(&["merge", "-q", "--no-ff", "--no-edit", "feature"]);
        let merge = r.run(&["rev-parse", "HEAD"]).trim().to_string();
        r.action("revert", json!({ "hash": merge })).await.unwrap();
        assert!(!r.path().join("b.txt").exists(), "the merge was undone");
        r.run(&["checkout", "-q", "-b", "altro", &format!("{merge}~1")]);
        r.action("cherryPick", json!({ "hash": merge }))
            .await
            .unwrap();
        assert!(
            r.path().join("b.txt").exists(),
            "the merge's changes applied on another branch"
        );
    }

    #[tokio::test]
    async fn push_senza_nessun_remote_spiega_cosa_manca_invece_dell_errore_su_origin_regressione() {
        let r = Repo::new();
        r.write("a.txt", "1\n");
        r.commit("init");
        assert!(r
            .action("push", json!({}))
            .await
            .unwrap_err()
            .contains("Nessun remote"));
    }

    #[tokio::test]
    async fn pull_senza_ramo_remoto_collegato_e_stash_pop_senza_stash_danno_messaggi_chiari_regressione(
    ) {
        let r = Repo::new();
        r.write("a.txt", "1\n");
        r.commit("init");
        assert!(r
            .action("pull", json!({}))
            .await
            .unwrap_err()
            .contains("non segue nessun ramo remoto"));
        assert!(r
            .action("stashPop", json!({}))
            .await
            .unwrap_err()
            .contains("Nessuno stash da ripristinare"));
    }
}

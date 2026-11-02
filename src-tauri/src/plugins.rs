// Plugins shared by every agent Work starts: GitHub repositories cloned into
// one folder (WORK_PLUGINS_PATH in their environment), plus Claude Code's own,
// listed read-only since Claude Code manages them.
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

pub const ENV_VAR: &str = "WORK_PLUGINS_PATH";
// `claude plugin update` refreshes the marketplace and downloads the plugin.
const CLAUDE_TIMEOUT: Duration = Duration::from_secs(180);
const MANIFESTS: [&str; 3] = [".claude-plugin/plugin.json", "plugin.json", "package.json"];
const BAD_URL: &str =
    "Not a GitHub repository URL: use https://github.com/owner/repo or git@github.com:owner/repo.git";

pub fn dir() -> PathBuf {
    crate::mcp::home().join(".local/share/work/plugins")
}

pub fn env() -> (&'static str, String) {
    (ENV_VAR, dir().to_string_lossy().into_owned())
}

#[derive(Debug, Default, PartialEq, Serialize)]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub version: Option<String>,
    pub description: Option<String>,
    pub author: Option<String>,
    // "owner/repo" on GitHub.
    pub repo: Option<String>,
    pub commit: Option<String>,
    pub path: String,
    // "work": installed and managed here; "claude": Claude Code's own, read-only.
    pub source: &'static str,
    // None until checked, and always for Claude Code's.
    pub update_available: Option<bool>,
}

// ── URLs and names ───────────────────────────────────────────

#[derive(Debug, PartialEq)]
pub struct GitHubRepo {
    pub owner: String,
    pub name: String,
    ssh: bool,
}

impl GitHubRepo {
    // Rebuilt from the parsed parts: nothing of the input reaches git as is.
    fn clone_url(&self) -> String {
        let (owner, name) = (&self.owner, &self.name);
        if self.ssh {
            format!("git@github.com:{owner}/{name}.git")
        } else {
            format!("https://github.com/{owner}/{name}.git")
        }
    }
}

fn valid_owner(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 39
        && !s.starts_with('-')
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

// Also what keeps an id inside the plugins folder: no separators and no
// leading dot (".", "..", hidden folders) or dash (git options).
fn safe_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && !s.starts_with(['.', '-'])
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

pub fn parse_github_url(url: &str) -> Result<GitHubRepo, String> {
    let url = url.trim();
    let (path, ssh) = if let Some(p) = url.strip_prefix("https://github.com/") {
        (p, false)
    } else if let Some(p) = url
        .strip_prefix("git@github.com:")
        .or_else(|| url.strip_prefix("ssh://git@github.com/"))
    {
        (p, true)
    } else {
        return Err(BAD_URL.into());
    };
    let path = path.trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let (owner, name) = path.split_once('/').ok_or(BAD_URL)?;
    if !valid_owner(owner) || !safe_name(name) {
        return Err(BAD_URL.into());
    }
    Ok(GitHubRepo {
        owner: owner.into(),
        name: name.into(),
        ssh,
    })
}

// ── Manifest ─────────────────────────────────────────────────

#[derive(Debug, Default, PartialEq)]
pub struct Manifest {
    pub name: Option<String>,
    pub version: Option<String>,
    pub description: Option<String>,
    pub author: Option<String>,
}

fn text(v: &Value) -> Option<String> {
    v.as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

pub fn parse_manifest(v: &Value) -> Manifest {
    Manifest {
        name: text(&v["name"]),
        version: text(&v["version"]),
        description: text(&v["description"]),
        author: text(&v["author"]).or_else(|| text(&v["author"]["name"])),
    }
}

// The first manifest found: a Claude Code plugin's, then a generic one.
fn read_manifest(dir: &Path) -> Manifest {
    if !dir.is_absolute() {
        return Manifest::default();
    }
    MANIFESTS
        .iter()
        .find_map(|m| {
            serde_json::from_str::<Value>(&std::fs::read_to_string(dir.join(m)).ok()?).ok()
        })
        .map(|v| parse_manifest(&v))
        .unwrap_or_default()
}

// ── git ──────────────────────────────────────────────────────

// Arguments go to git directly, never through a shell. No prompt can wait for
// an answer: a private repository fails instead.
fn git(dir: Option<&Path>, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    if let Some(dir) = dir {
        cmd.current_dir(dir);
    }
    let out = cmd
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("Cannot run git: {e}"))?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).trim().to_string());
    }
    Err(git_error(&String::from_utf8_lossy(&out.stderr)))
}

pub fn git_error(stderr: &str) -> String {
    let s = stderr.to_lowercase();
    let any = |marks: &[&str]| marks.iter().any(|m| s.contains(m));
    if any(&[
        "repository not found",
        "could not read username",
        "authentication failed",
        "permission denied",
    ]) {
        return "Repository not found or private: check the URL and your access to it on GitHub"
            .into();
    }
    if any(&[
        "could not resolve host",
        "network is unreachable",
        "connection timed out",
        "connection refused",
    ]) {
        return "Cannot reach GitHub: check the network connection".into();
    }
    match crate::git::tail(stderr.trim(), 300) {
        "" => "git failed".into(),
        msg => msg.into(),
    }
}

// Only a plugin's own repository: git run in a plain folder would find the
// one around it (a home under version control).
fn is_repo(dir: &Path) -> bool {
    dir.join(".git").exists()
}

// The tip of the branch the plugin follows, on GitHub.
fn remote_head(dir: &Path) -> Result<String, String> {
    let branch = git(Some(dir), &["rev-parse", "--abbrev-ref", "HEAD"])?;
    let refname = match branch.as_str() {
        "HEAD" => branch.clone(),
        b => format!("refs/heads/{b}"),
    };
    let out = git(Some(dir), &["ls-remote", "origin", &refname])?;
    out.split_whitespace()
        .next()
        .map(String::from)
        .ok_or_else(|| format!("Branch {branch} no longer exists on the remote"))
}

fn has_update(dir: &Path) -> Option<bool> {
    if !is_repo(dir) {
        return None;
    }
    let local = git(Some(dir), &["rev-parse", "HEAD"]).ok()?;
    Some(remote_head(dir).ok()? != local)
}

// ── Plugins ──────────────────────────────────────────────────

fn info(dir: &Path, id: &str) -> PluginInfo {
    let m = read_manifest(dir);
    let repo = is_repo(dir);
    let git_out = |args: &[&str]| repo.then(|| git(Some(dir), args).ok()).flatten();
    PluginInfo {
        id: id.into(),
        name: m.name.unwrap_or_else(|| id.into()),
        version: m.version,
        description: m.description,
        author: m.author,
        repo: git_out(&["remote", "get-url", "origin"])
            .and_then(|u| parse_github_url(&u).ok())
            .map(|r| format!("{}/{}", r.owner, r.name)),
        commit: git_out(&["rev-parse", "--short", "HEAD"]),
        path: dir.to_string_lossy().into_owned(),
        source: "work",
        update_available: None,
    }
}

fn list_in(root: &Path) -> Vec<PluginInfo> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return vec![];
    };
    let mut list: Vec<_> = entries
        .filter_map(|e| {
            let e = e.ok()?;
            let id = e.file_name().into_string().ok().filter(|n| safe_name(n))?;
            e.path().is_dir().then(|| info(&e.path(), &id))
        })
        .collect();
    list.sort_by_key(|p| p.name.to_lowercase());
    list
}

// ── Claude Code's plugins ────────────────────────────────────

fn claude_root() -> PathBuf {
    crate::mcp::home().join(".claude/plugins")
}

fn read_json(file: &Path) -> Value {
    std::fs::read_to_string(file)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

// "name@marketplace", both plain names: never a git or CLI option.
fn claude_id(id: &str) -> Option<(&str, &str)> {
    id.split_once('@')
        .filter(|(name, market)| safe_name(name) && safe_name(market))
}

// What installed_plugins.json lists.
pub fn claude_plugins(installed: &Value) -> Vec<PluginInfo> {
    let Some(map) = installed["plugins"].as_object() else {
        return vec![];
    };
    map.iter()
        .filter_map(|(id, entries)| {
            let e = entries.as_array()?.first()?;
            let path = e["installPath"].as_str().unwrap_or("");
            let m = read_manifest(Path::new(path));
            Some(PluginInfo {
                id: id.clone(),
                name: m
                    .name
                    .unwrap_or_else(|| id.split('@').next().unwrap_or(id).into()),
                version: text(&e["version"]).or(m.version),
                description: m.description,
                author: m.author,
                repo: None,
                commit: text(&e["gitCommitSha"]).map(|s| s.chars().take(7).collect()),
                path: path.into(),
                source: "claude",
                update_available: None,
            })
        })
        .collect()
}

// Where a marketplace of known_marketplaces.json is fetched from.
pub fn marketplace_url(entry: &Value) -> Option<String> {
    let source = &entry["source"];
    let url = match source["source"].as_str()? {
        "github" => format!("https://github.com/{}.git", source["repo"].as_str()?),
        "git" => source["url"].as_str()?.to_string(),
        _ => return None,
    };
    // Never an option, nor a transport helper ("ext::sh -c …").
    (!url.starts_with('-') && !url.contains("::")).then_some(url)
}

// The plugin's files are in the marketplace repository itself ("./plugin"),
// not in a repository of their own.
fn in_marketplace_repo(entry: &Value, name: &str) -> bool {
    let Some(dir) = entry["installLocation"]
        .as_str()
        .map(Path::new)
        .filter(|d| d.is_absolute())
    else {
        return false;
    };
    read_json(&dir.join(".claude-plugin/marketplace.json"))["plugins"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|p| p["name"] == name && p["source"].is_string())
}

// A marketplace's HEAD and its "<plugin>--v<version>" release tags, the ones
// `claude plugin tag` creates.
#[derive(Debug, Default, PartialEq)]
pub struct Remote {
    head: Option<String>,
    tags: Vec<(String, String)>,
}

pub fn parse_remote(ls_remote: &str) -> Remote {
    let mut remote = Remote::default();
    for (sha, refname) in ls_remote.lines().filter_map(|l| l.split_once('\t')) {
        if refname == "HEAD" {
            remote.head = Some(sha.into());
        } else if let Some((name, version)) = refname
            .strip_prefix("refs/tags/")
            .and_then(|t| t.trim_end_matches("^{}").rsplit_once("--v"))
        {
            remote.tags.push((name.into(), version.into()));
        }
    }
    remote
}

type Version = (Vec<u64>, bool);

// "3.2.10" > "3.2.9"; a pre-release ("2.0.0-beta") sorts before its release.
// None for anything else, a commit-derived version included.
pub fn version_key(v: &str) -> Option<Version> {
    let v = v.trim().trim_start_matches('v');
    let end = v.find(['-', '+']).unwrap_or(v.len());
    let numbers = v[..end]
        .split('.')
        .map(|n| n.parse().ok())
        .collect::<Option<Vec<u64>>>()?;
    Some((numbers, !v[end..].starts_with('-')))
}

impl Remote {
    fn latest(&self, name: &str) -> Option<Version> {
        self.tags
            .iter()
            .filter(|(n, _)| n == name)
            .filter_map(|(_, v)| version_key(v))
            .max()
    }
}

fn fetch_remote(url: &str) -> Option<Remote> {
    git(None, &["ls-remote", "--", url, "HEAD", "refs/tags/*--v*"])
        .ok()
        .map(|out| parse_remote(&out))
}

// Release tags decide when there are any. Without them only a plugin whose
// version is the marketplace commit can be judged by that commit: for one
// with a semver, any other commit in the marketplace would look like an update.
pub fn claude_has_update(p: &PluginInfo, in_repo: bool, remote: &Remote) -> Option<bool> {
    let (name, _) = claude_id(&p.id)?;
    let version = p.version.as_deref()?;
    if let Some(latest) = remote.latest(name) {
        return Some(version_key(version)? < latest);
    }
    let commit = p.commit.as_deref()?;
    let by_commit =
        in_repo && version.starts_with(commit) && version.chars().all(|c| c.is_ascii_hexdigit());
    if !by_commit {
        return None;
    }
    Some(!remote.head.as_deref()?.starts_with(version))
}

fn list() -> Vec<PluginInfo> {
    let mut all = list_in(&dir());
    all.extend(claude_plugins(&read_json(
        &claude_root().join("installed_plugins.json"),
    )));
    all
}

// One ls-remote per Work plugin and per marketplace, side by side: the
// network is the slow part.
fn check_all(mut all: Vec<PluginInfo>, claude_root: &Path) -> Vec<PluginInfo> {
    let known = &read_json(&claude_root.join("known_marketplaces.json"));
    let mut markets: Vec<String> = all
        .iter()
        .filter(|p| p.source == "claude")
        .filter_map(|p| claude_id(&p.id))
        .map(|(_, market)| market.to_string())
        .collect();
    markets.sort();
    markets.dedup();
    let remotes: HashMap<String, Remote> = std::thread::scope(|s| {
        let pending: Vec<_> = markets
            .iter()
            .map(|m| {
                (
                    m,
                    s.spawn(move || fetch_remote(&marketplace_url(&known[m.as_str()])?)),
                )
            })
            .collect();
        for p in all.iter_mut().filter(|p| p.source == "work") {
            s.spawn(move || p.update_available = has_update(Path::new(&p.path)));
        }
        pending
            .into_iter()
            .filter_map(|(m, h)| Some((m.clone(), h.join().ok()??)))
            .collect()
    });
    for p in all.iter_mut().filter(|p| p.source == "claude") {
        let Some((name, market)) = claude_id(&p.id) else {
            continue;
        };
        let Some(remote) = remotes.get(market) else {
            continue;
        };
        p.update_available =
            claude_has_update(p, in_marketplace_repo(&known[market], name), remote);
    }
    all
}

// Claude Code updates its own plugins: its CLI keeps installed_plugins.json
// and the marketplaces consistent. Sessions started afterwards load the new
// version. A marketplace command that needs confirming makes it fail: Work
// never confirms it (-y) on the user's behalf.
async fn update_claude(
    root: &Path,
    cli: &[&str],
    id: &str,
    limit: Duration,
) -> Result<PluginInfo, String> {
    let installed = root.join("installed_plugins.json");
    let find = || {
        claude_plugins(&read_json(&installed))
            .into_iter()
            .find(|p| p.id == id)
    };
    if claude_id(id).is_none() || find().is_none() {
        return Err(format!("Plugin {id} is not installed in Claude Code"));
    }
    let (program, args) = cli.split_first().ok_or("No Claude Code CLI")?;
    let run = tokio::process::Command::new(program)
        .args(args)
        .args(["plugin", "update", id])
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output();
    let out = tokio::time::timeout(limit, run)
        .await
        .map_err(|_| {
            format!(
                "claude plugin update {id} did not finish within {} s",
                limit.as_secs()
            )
        })?
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => "Claude Code (claude) is not on the PATH".to_string(),
            _ => format!("Cannot run claude: {e}"),
        })?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let msg = if stderr.trim().is_empty() {
            String::from_utf8_lossy(&out.stdout)
        } else {
            stderr
        };
        return Err(match crate::git::tail(msg.trim(), 300) {
            "" => format!("claude plugin update {id} failed"),
            m => m.into(),
        });
    }
    let mut p = find().ok_or_else(|| format!("Plugin {id} is no longer installed"))?;
    p.update_available = Some(false);
    Ok(p)
}

// A Claude Code id has a marketplace ("oz@overzoom"); a Work one never has '@'.
async fn update(
    work_root: PathBuf,
    claude_root: &Path,
    cli: &[&str],
    id: String,
) -> Result<PluginInfo, String> {
    if id.contains('@') {
        return update_claude(claude_root, cli, &id, CLAUDE_TIMEOUT).await;
    }
    blocking(move || update_in(&work_root, &id)).await
}

fn clone_into(root: &Path, id: &str, url: &str) -> Result<PluginInfo, String> {
    let dest = root.join(id);
    // symlink_metadata: a dangling link counts as taken too.
    if dest.symlink_metadata().is_ok() {
        return Err(format!("A plugin named {id} is already installed"));
    }
    std::fs::create_dir_all(root).map_err(|e| format!("Cannot create {}: {e}", root.display()))?;
    let target = dest.to_string_lossy();
    if let Err(e) = git(None, &["clone", "--depth", "1", "--", url, &target]) {
        let _ = std::fs::remove_dir_all(&dest);
        return Err(e);
    }
    Ok(info(&dest, id))
}

fn plugin_dir(root: &Path, id: &str) -> Result<PathBuf, String> {
    if !safe_name(id) {
        return Err(format!("Invalid plugin id: {id}"));
    }
    let dir = root.join(id);
    if !dir.is_dir() {
        return Err(format!("Plugin {id} is not installed"));
    }
    Ok(dir)
}

// Fast-forward only: changes made inside a plugin's folder are never thrown away.
fn update_in(root: &Path, id: &str) -> Result<PluginInfo, String> {
    let dir = plugin_dir(root, id)?;
    if !is_repo(&dir) {
        return Err(format!("Plugin {id} was not installed from GitHub"));
    }
    git(Some(&dir), &["fetch", "origin"])?;
    git(Some(&dir), &["merge", "--ff-only", "@{u}"])?;
    let mut p = info(&dir, id);
    p.update_available = Some(false);
    Ok(p)
}

// remove_dir_all does not follow a symlink: a linked plugin loses only the link.
fn remove_in(root: &Path, id: &str) -> Result<(), String> {
    let dir = plugin_dir(root, id)?;
    std::fs::remove_dir_all(&dir).map_err(|e| format!("Cannot remove {id}: {e}"))
}

// ── IPC Commands ─────────────────────────────────────────────

// git and the network: off the main thread.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn plugins_list() -> Result<Vec<PluginInfo>, String> {
    blocking(|| Ok(list())).await
}

#[tauri::command]
pub async fn plugins_check_updates() -> Result<Vec<PluginInfo>, String> {
    blocking(|| Ok(check_all(list(), &claude_root()))).await
}

#[tauri::command]
pub async fn plugins_install(url: String) -> Result<PluginInfo, String> {
    blocking(move || {
        let repo = parse_github_url(&url)?;
        clone_into(&dir(), &repo.name, &repo.clone_url())
    })
    .await
}

#[tauri::command]
pub async fn plugins_update(id: String) -> Result<PluginInfo, String> {
    update(dir(), &claude_root(), &["claude"], id).await
}

#[tauri::command]
pub async fn plugins_remove(id: String) -> Result<(), String> {
    blocking(move || remove_in(&dir(), &id)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn run(dir: &Path, args: &[&str]) {
        let ok = Command::new("git")
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok, "git {args:?}");
    }

    // A local "GitHub" repository with a manifest, and its file:// URL.
    fn upstream(root: &Path) -> (PathBuf, String) {
        let src = root.join("upstream");
        std::fs::create_dir_all(src.join(".claude-plugin")).unwrap();
        std::fs::write(
            src.join(".claude-plugin/plugin.json"),
            r#"{"name":"oz","version":"1.2.0","description":"Sprint tools","author":{"name":"Overzoom"}}"#,
        )
        .unwrap();
        run(&src, &["init", "-q", "-b", "main"]);
        run(&src, &["add", "."]);
        run(&src, &["commit", "-q", "-m", "first"]);
        let url = format!("file://{}", src.display());
        (src, url)
    }

    #[test]
    fn github_urls_are_accepted_over_https_and_ssh() {
        let https = parse_github_url("https://github.com/overzoomit/oz-plugin").unwrap();
        assert_eq!(
            (https.owner.as_str(), https.name.as_str()),
            ("overzoomit", "oz-plugin")
        );
        assert_eq!(
            https.clone_url(),
            "https://github.com/overzoomit/oz-plugin.git"
        );
        for url in [
            "https://github.com/overzoomit/oz-plugin.git",
            "https://github.com/overzoomit/oz-plugin/",
            "  https://github.com/overzoomit/oz-plugin  ",
        ] {
            assert_eq!(parse_github_url(url).unwrap(), https, "{url}");
        }
        let ssh = parse_github_url("git@github.com:overzoomit/oz.plugin.git").unwrap();
        assert_eq!(ssh.clone_url(), "git@github.com:overzoomit/oz.plugin.git");
        assert_eq!(
            parse_github_url("ssh://git@github.com/overzoomit/oz.plugin").unwrap(),
            ssh
        );
    }

    #[test]
    fn anything_else_is_refused_before_git_runs() {
        for url in [
            "",
            "http://github.com/o/r",
            "https://gitlab.com/o/r",
            "https://github.com.evil.io/o/r",
            "https://github.com/o",
            "https://github.com/o/r/tree/main",
            "https://github.com/o/r?x=1",
            "https://github.com/o/..",
            "https://github.com/o/.git",
            "https://github.com/-o/r",
            "https://github.com/o/-r",
            "git@github.com:o/r;rm -rf ~",
            "git@github.com:o/r$(id)",
            "--upload-pack=evil",
            "file:///etc",
        ] {
            assert_eq!(parse_github_url(url).unwrap_err(), BAD_URL, "{url}");
        }
    }

    #[test]
    fn ids_cannot_leave_the_plugins_folder() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("ok")).unwrap();
        for id in [
            "", ".", "..", "../ok", "ok/../..", "/etc", ".git", "-rf", "a b",
        ] {
            assert!(
                plugin_dir(root.path(), id)
                    .unwrap_err()
                    .starts_with("Invalid plugin id"),
                "{id}"
            );
        }
        assert!(plugin_dir(root.path(), "missing")
            .unwrap_err()
            .contains("not installed"));
        assert_eq!(
            plugin_dir(root.path(), "ok").unwrap(),
            root.path().join("ok")
        );
    }

    #[test]
    fn manifests_give_name_version_description_and_author() {
        let m = parse_manifest(&json!({
            "name": "oz", "version": "1.0.0", "description": " Tools ", "author": {"name": "Overzoom"}
        }));
        assert_eq!(
            m,
            Manifest {
                name: Some("oz".into()),
                version: Some("1.0.0".into()),
                description: Some("Tools".into()),
                author: Some("Overzoom".into()),
            }
        );
        assert_eq!(
            parse_manifest(&json!({"author": "Ada"})).author.as_deref(),
            Some("Ada")
        );
        assert_eq!(
            parse_manifest(&json!({"name": "", "version": 3})),
            Manifest::default()
        );
    }

    #[test]
    fn the_claude_plugin_manifest_wins_over_package_json() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("package.json"),
            r#"{"name":"npm-name","version":"9.9.9"}"#,
        )
        .unwrap();
        assert_eq!(read_manifest(dir.path()).name.as_deref(), Some("npm-name"));
        std::fs::create_dir(dir.path().join(".claude-plugin")).unwrap();
        std::fs::write(
            dir.path().join(".claude-plugin/plugin.json"),
            r#"{"name":"oz"}"#,
        )
        .unwrap();
        assert_eq!(read_manifest(dir.path()).name.as_deref(), Some("oz"));
        std::fs::write(dir.path().join(".claude-plugin/plugin.json"), "{broken").unwrap();
        assert_eq!(
            read_manifest(dir.path()).name.as_deref(),
            Some("npm-name"),
            "a broken one is skipped"
        );
        assert_eq!(
            read_manifest(Path::new("")),
            Manifest::default(),
            "no relative lookups"
        );
    }

    #[test]
    fn claude_code_plugins_are_listed_read_only() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".claude-plugin")).unwrap();
        std::fs::write(
            dir.path().join(".claude-plugin/plugin.json"),
            r#"{"description":"Payments"}"#,
        )
        .unwrap();
        let installed = json!({"version": 2, "plugins": {
            "stripe@claude-plugins-official": [{
                "installPath": dir.path(), "version": "0.11.17",
                "gitCommitSha": "deae744bc0cbf6034b4b6f22f51c690b71a4e779"
            }],
            "empty@x": []
        }});
        let list = claude_plugins(&installed);
        assert_eq!(list.len(), 1);
        let p = &list[0];
        assert_eq!(
            (p.id.as_str(), p.name.as_str()),
            ("stripe@claude-plugins-official", "stripe")
        );
        assert_eq!(p.version.as_deref(), Some("0.11.17"));
        assert_eq!(p.description.as_deref(), Some("Payments"));
        assert_eq!(p.commit.as_deref(), Some("deae744"));
        assert_eq!((p.source, p.update_available), ("claude", None));
        assert!(claude_plugins(&json!({})).is_empty());
    }

    #[test]
    fn git_errors_are_explained() {
        assert!(
            git_error("remote: Repository not found.\nfatal: repository 'x' not found")
                .contains("private")
        );
        assert!(git_error(
            "fatal: could not read Username for 'https://github.com': terminal prompts disabled"
        )
        .contains("private"));
        assert!(git_error("git@github.com: Permission denied (publickey).").contains("private"));
        assert!(
            git_error("fatal: unable to access 'x': Could not resolve host: github.com")
                .contains("network")
        );
        assert_eq!(git_error("fatal: something odd\n"), "fatal: something odd");
        assert_eq!(git_error(""), "git failed");
    }

    #[test]
    fn install_check_update_and_remove_a_plugin() {
        let tmp = tempfile::tempdir().unwrap();
        let (src, url) = upstream(tmp.path());
        let root = tmp.path().join("plugins");

        let p = clone_into(&root, "oz", &url).unwrap();
        assert_eq!(
            (p.id.as_str(), p.name.as_str(), p.source),
            ("oz", "oz", "work")
        );
        assert_eq!(p.version.as_deref(), Some("1.2.0"));
        assert_eq!(p.author.as_deref(), Some("Overzoom"));
        assert!(p.commit.is_some());
        assert_eq!(p.repo, None, "not a GitHub remote");
        assert!(clone_into(&root, "oz", &url)
            .unwrap_err()
            .contains("already installed"));
        assert_eq!(list_in(&root), vec![p]);
        assert_eq!(has_update(&root.join("oz")), Some(false));

        std::fs::write(src.join("README.md"), "new").unwrap();
        run(&src, &["add", "."]);
        run(&src, &["commit", "-q", "-m", "second"]);
        let checked = check_all(list_in(&root), tmp.path());
        assert_eq!(checked[0].update_available, Some(true));

        let updated = update_in(&root, "oz").unwrap();
        assert_eq!(updated.update_available, Some(false));
        assert!(root.join("oz/README.md").exists());
        assert_eq!(has_update(&root.join("oz")), Some(false));

        remove_in(&root, "oz").unwrap();
        assert!(!root.join("oz").exists());
        assert!(list_in(&root).is_empty());
    }

    #[test]
    fn a_failed_clone_leaves_nothing_behind() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("plugins");
        let missing = format!("file://{}/nope", tmp.path().display());
        assert!(clone_into(&root, "nope", &missing).is_err());
        assert!(!root.join("nope").exists());
    }

    #[test]
    fn local_changes_block_an_update_instead_of_being_lost() {
        let tmp = tempfile::tempdir().unwrap();
        let (src, url) = upstream(tmp.path());
        let root = tmp.path().join("plugins");
        clone_into(&root, "oz", &url).unwrap();
        std::fs::write(src.join("notes.md"), "upstream").unwrap();
        run(&src, &["add", "."]);
        run(&src, &["commit", "-q", "-m", "second"]);
        std::fs::write(root.join("oz/notes.md"), "mine").unwrap();

        assert!(update_in(&root, "oz").is_err());
        assert_eq!(
            std::fs::read_to_string(root.join("oz/notes.md")).unwrap(),
            "mine"
        );
    }

    #[test]
    fn plain_folders_are_listed_but_never_handed_to_git() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("local")).unwrap();
        std::fs::create_dir(root.path().join(".hidden")).unwrap();
        std::fs::write(root.path().join("file.txt"), "").unwrap();
        let list = list_in(root.path());
        assert_eq!(list.len(), 1);
        assert_eq!(
            (list[0].commit.as_deref(), list[0].repo.as_deref()),
            (None, None)
        );
        assert_eq!(has_update(&root.path().join("local")), None);
        assert!(update_in(root.path(), "local")
            .unwrap_err()
            .contains("not installed from GitHub"));
    }

    // ── Claude Code's plugins ──

    fn claude(id: &str, version: &str, commit: &str) -> PluginInfo {
        PluginInfo {
            id: id.into(),
            name: id.split('@').next().unwrap().into(),
            version: Some(version.into()),
            commit: Some(commit.into()),
            source: "claude",
            ..Default::default()
        }
    }

    #[test]
    fn ls_remote_gives_the_head_and_the_release_tags() {
        let out = "80b57c8e\tHEAD\n\
                   1fee0339\trefs/tags/oz--v3.2.8\n\
                   ce349ece\trefs/tags/oz--v3.2.8^{}\n\
                   afd79755\trefs/tags/oz--v3.2.10\n\
                   40d06f2a\trefs/tags/oz-mcp-v2.0.0\n\
                   aaaaaaaa\trefs/tags/my--vision--v1.0.0\n";
        let remote = parse_remote(out);
        assert_eq!(remote.head.as_deref(), Some("80b57c8e"));
        assert_eq!(remote.latest("oz"), version_key("3.2.10"), "3.2.10 > 3.2.8");
        assert_eq!(remote.latest("oz-mcp"), None, "not a --v tag");
        assert_eq!(remote.latest("my--vision"), version_key("1.0.0"));
        assert_eq!(parse_remote(""), Remote::default());
    }

    #[test]
    fn versions_compare_as_numbers_with_pre_releases_first() {
        let v = |s| version_key(s).unwrap();
        assert!(v("3.2.10") > v("3.2.9"));
        assert!(v("2.0.0") > v("2.0.0-beta.1"));
        assert_eq!(v("v1.2.0"), v("1.2.0"));
        assert_eq!(v("1.2.0+build.5"), v("1.2.0"));
        assert_eq!(
            version_key("9ffb83138209"),
            None,
            "a commit-derived version"
        );
        assert_eq!(version_key(""), None);
    }

    #[test]
    fn release_tags_decide_a_claude_plugin_update() {
        let remote =
            parse_remote("c0ffee00\tHEAD\nabc\trefs/tags/oz--v3.2.9\nabd\trefs/tags/oz--v3.3.0\n");
        assert_eq!(
            claude_has_update(&claude("oz@overzoom", "3.2.9", "80b57c8"), true, &remote),
            Some(true)
        );
        assert_eq!(
            claude_has_update(&claude("oz@overzoom", "3.3.0", "80b57c8"), true, &remote),
            Some(false)
        );
        assert_eq!(
            claude_has_update(&claude("oz@overzoom", "3.4.0", "80b57c8"), false, &remote),
            Some(false)
        );
    }

    #[test]
    fn without_tags_only_a_commit_versioned_plugin_follows_the_marketplace_head() {
        let moved = parse_remote("1111111aaaaaaaa\tHEAD\n");
        let same = parse_remote("9ffb83138209057875698dd11c1720c657c47a92\tHEAD\n");
        let apple = claude("apple-skills@indie-apple-stack", "9ffb83138209", "9ffb831");
        assert_eq!(claude_has_update(&apple, true, &moved), Some(true));
        assert_eq!(claude_has_update(&apple, true, &same), Some(false));
        assert_eq!(
            claude_has_update(&apple, false, &moved),
            None,
            "its own repository: the marketplace HEAD says nothing"
        );
        let lsp = claude(
            "rust-analyzer-lsp@claude-plugins-official",
            "1.0.0",
            "fbe07fb",
        );
        assert_eq!(
            claude_has_update(&lsp, true, &moved),
            None,
            "semver without tags: unknown, not a false update"
        );
        assert_eq!(
            claude_has_update(&claude("bad id", "1.0.0", "x"), true, &moved),
            None
        );
    }

    #[test]
    fn marketplace_urls_come_from_github_or_git_sources_only() {
        let url = |source: Value| marketplace_url(&json!({ "source": source }));
        assert_eq!(
            url(json!({"source": "github", "repo": "anthropics/plugins"})).as_deref(),
            Some("https://github.com/anthropics/plugins.git")
        );
        assert_eq!(
            url(json!({"source": "git", "url": "git@github.com:overzoomit/plane.git"})).as_deref(),
            Some("git@github.com:overzoomit/plane.git")
        );
        assert_eq!(url(json!({"source": "directory", "path": "/x"})), None);
        assert_eq!(
            url(json!({"source": "git", "url": "--upload-pack=evil"})),
            None
        );
        assert_eq!(
            url(json!({"source": "git", "url": "ext::sh -c evil"})),
            None
        );
        assert_eq!(marketplace_url(&json!({})), None);
    }

    #[test]
    fn a_plugin_in_the_marketplace_repository_has_a_relative_source() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".claude-plugin")).unwrap();
        std::fs::write(
            dir.path().join(".claude-plugin/marketplace.json"),
            r#"{"plugins":[{"name":"oz","source":"./plugin"},{"name":"archify","source":{"source":"github","repo":"a/b"}}]}"#,
        )
        .unwrap();
        let entry = json!({ "installLocation": dir.path() });
        assert!(in_marketplace_repo(&entry, "oz"));
        assert!(!in_marketplace_repo(&entry, "archify"));
        assert!(!in_marketplace_repo(&entry, "missing"));
        assert!(!in_marketplace_repo(
            &json!({ "installLocation": "relative" }),
            "oz"
        ));
    }

    #[test]
    fn check_all_asks_the_marketplace_for_claude_plugins() {
        let tmp = tempfile::tempdir().unwrap();
        let (src, url) = upstream(tmp.path());
        run(&src, &["tag", "oz--v3.3.0"]);
        std::fs::write(
            tmp.path().join("known_marketplaces.json"),
            json!({ "overzoom": { "source": { "source": "git", "url": url } } }).to_string(),
        )
        .unwrap();
        let all = vec![
            claude("oz@overzoom", "3.2.9", "80b57c8"),
            claude("lsp@nowhere", "1.0.0", "fbe07fb"),
        ];
        let checked = check_all(all, tmp.path());
        assert_eq!(checked[0].update_available, Some(true));
        assert_eq!(checked[1].update_available, None, "unknown marketplace");
    }

    // A stand-in for the claude CLI, run by sh (never exec'd: no ETXTBSY).
    fn fake_cli(root: &Path, body: &str) -> String {
        let script = root.join("claude.sh");
        std::fs::write(&script, body).unwrap();
        script.to_string_lossy().into_owned()
    }

    fn installed(root: &Path, version: &str) {
        std::fs::write(
            root.join("installed_plugins.json"),
            json!({"plugins": {"oz@overzoom": [{"installPath": "/nowhere", "version": version, "gitCommitSha": "1234567890ab"}]}}).to_string(),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn a_claude_plugin_is_updated_by_the_claude_cli_and_read_back() {
        let tmp = tempfile::tempdir().unwrap();
        installed(tmp.path(), "3.2.9");
        let script = fake_cli(
            tmp.path(),
            r#"dir=$(dirname "$0"); printf '%s' "$*" > "$dir/args"
printf '{"plugins":{"oz@overzoom":[{"installPath":"/nowhere","version":"3.3.0","gitCommitSha":"abcdef0123"}]}}' > "$dir/installed_plugins.json""#,
        );
        let p = update(
            tmp.path().join("work"),
            tmp.path(),
            &["sh", &script],
            "oz@overzoom".into(),
        )
        .await
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("args")).unwrap(),
            "plugin update oz@overzoom"
        );
        assert_eq!(p.version.as_deref(), Some("3.3.0"));
        assert_eq!(p.commit.as_deref(), Some("abcdef0"));
        assert_eq!((p.source, p.update_available), ("claude", Some(false)));
    }

    #[tokio::test]
    async fn a_failing_or_stuck_claude_cli_is_reported() {
        let tmp = tempfile::tempdir().unwrap();
        installed(tmp.path(), "3.2.9");
        let failing = fake_cli(
            tmp.path(),
            "echo 'Marketplace overzoom not found' >&2; exit 1",
        );
        let err = update(
            tmp.path().join("work"),
            tmp.path(),
            &["sh", &failing],
            "oz@overzoom".into(),
        )
        .await
        .unwrap_err();
        assert_eq!(err, "Marketplace overzoom not found");

        let stuck = fake_cli(tmp.path(), "exec sleep 5");
        let err = update_claude(
            tmp.path(),
            &["sh", &stuck],
            "oz@overzoom",
            Duration::from_millis(200),
        )
        .await
        .unwrap_err();
        assert!(err.contains("did not finish"), "{err}");

        let missing = update_claude(
            tmp.path(),
            &["no-such-claude-work-test"],
            "oz@overzoom",
            CLAUDE_TIMEOUT,
        )
        .await
        .unwrap_err();
        assert!(missing.contains("not on the PATH"), "{missing}");
    }

    #[tokio::test]
    async fn update_dispatches_on_the_id_and_runs_nothing_for_unknown_plugins() {
        let tmp = tempfile::tempdir().unwrap();
        installed(tmp.path(), "3.2.9");
        let script = fake_cli(tmp.path(), r#"touch "$(dirname "$0")/ran""#);
        let cli = ["sh", script.as_str()];
        for id in ["stripe@official", "-rf@overzoom", "oz@../x"] {
            let err = update(tmp.path().join("work"), tmp.path(), &cli, id.into())
                .await
                .unwrap_err();
            assert!(err.contains("not installed in Claude Code"), "{id}: {err}");
        }
        assert!(!tmp.path().join("ran").exists(), "the CLI never ran");
        let err = update(tmp.path().join("work"), tmp.path(), &cli, "oz".into())
            .await
            .unwrap_err();
        assert!(
            err.contains("Plugin oz is not installed"),
            "a Work id goes to git: {err}"
        );
        assert!(!tmp.path().join("ran").exists());
    }
}

// GitHub through the `gh` CLI the user already signed in with, like git above:
// Work never asks for, receives or stores a token.
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::State;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::diag::{log, Level};
use crate::fsops::{guard, Roots};

const TIMEOUT: Duration = Duration::from_secs(30);
const MIN_VERSION: (u32, u32) = (2, 40);

pub struct Run {
    code: Option<i32>,
    out: String,
    err: String,
}

pub enum Spawn {
    Missing,
    Other(String),
}

// The line the log gets for a call. Only the subcommand ("secret set"): the
// rest of the arguments can name a secret, and its value goes through stdin.
fn log_line(cwd: &Path, args: &[&str], exit: Option<i32>, ms: u128) -> String {
    let cmd = args.iter().take(2).copied().collect::<Vec<_>>().join(" ");
    let exit = exit.map_or("-".to_string(), |c| c.to_string());
    format!("gh {cmd} in {}: exit {exit} in {ms} ms", cwd.display())
}

// The one place that runs `gh`.
pub async fn run_gh(cwd: &Path, args: &[&str], input: Option<&[u8]>) -> Result<Run, Spawn> {
    run_with("gh", cwd, args, input).await
}

async fn run_with(
    bin: &str,
    cwd: &Path,
    args: &[&str],
    input: Option<&[u8]>,
) -> Result<Run, Spawn> {
    let start = Instant::now();
    let res = tokio::time::timeout(TIMEOUT, exec(bin, cwd, args, input)).await;
    let ms = start.elapsed().as_millis();
    let res = res.unwrap_or_else(|_| {
        Err(Spawn::Other(
            "GitHub CLI non ha risposto entro 30 secondi.".into(),
        ))
    });
    let exit = res.as_ref().ok().and_then(|r| r.code);
    let line = log_line(cwd, args, exit, ms);
    match &res {
        Ok(r) if r.code == Some(0) && ms <= 10_000 => log(Level::Debug, "github", line),
        // A secret's stderr stays out of the log, like a commit message in git.
        Ok(r) if input.is_none() => log(
            Level::Warn,
            "github",
            format!("{line}: {}", crate::git::tail(r.err.trim(), 300)),
        ),
        _ => log(Level::Warn, "github", line),
    }
    res
}

async fn exec(bin: &str, cwd: &Path, args: &[&str], input: Option<&[u8]>) -> Result<Run, Spawn> {
    let mut child = Command::new(bin)
        .args(args)
        .current_dir(cwd)
        .env("GH_PROMPT_DISABLED", "1")
        .env("NO_COLOR", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                Spawn::Missing
            } else {
                Spawn::Other(e.to_string())
            }
        })?;
    if let (Some(mut stdin), Some(bytes)) = (child.stdin.take(), input) {
        // A gh that exits without reading closes the pipe: its exit code says why.
        let _ = stdin.write_all(bytes).await;
    }
    let o = child
        .wait_with_output()
        .await
        .map_err(|e| Spawn::Other(e.to_string()))?;
    Ok(Run {
        code: o.status.code(),
        out: String::from_utf8_lossy(&o.stdout).into_owned(),
        err: String::from_utf8_lossy(&o.stderr).into_owned(),
    })
}

// Italian message for what `gh` printed, so the panel never shows raw stderr
// where the cause is known.
fn explain(stderr: &str) -> String {
    let s = stderr.to_lowercase();
    // First: its message also suggests `gh auth login`.
    if s.contains("no git remotes")
        || s.contains("none of the git remotes")
        || s.contains("not a git repository")
    {
        "Questo progetto non ha un repository su GitHub.".into()
    } else if s.contains("gh auth login") || s.contains("not logged in") {
        "Non hai effettuato l'accesso a GitHub.".into()
    } else if s.contains("http 403")
        || s.contains("resource not accessible")
        || s.contains("must have admin")
    {
        "Non hai i permessi per farlo su questo repository.".into()
    } else if s.contains("workflow_dispatch") {
        "Questo workflow non si può avviare a mano: manca il trigger workflow_dispatch.".into()
    } else if s.contains("could not prompt") || s.contains("required input") {
        "Questo workflow chiede degli input: avvialo da GitHub.".into()
    } else if s.contains("no ref found") || s.contains("could not find any commit") {
        "Il branch non esiste su GitHub: fai prima il push.".into()
    } else if s.contains("error connecting")
        || s.contains("could not resolve host")
        || s.contains("timeout")
    {
        "Impossibile raggiungere GitHub: controlla la connessione.".into()
    } else {
        let msg = stderr.trim();
        if msg.is_empty() {
            "GitHub CLI ha restituito un errore.".into()
        } else {
            crate::git::tail(msg, 300).to_string()
        }
    }
}

// "gh version 2.40.1 (2024-01-01)" → (2, 40)
fn parse_version(out: &str) -> Option<(u32, u32)> {
    let v = out.split_whitespace().nth(2)?;
    let mut it = v.split('.');
    Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?))
}

// What the panel needs to pick its empty state or show the repository.
// `repo`: Ok(json of `gh repo view`), Err(stderr).
fn status_json(
    version: Option<&str>,
    authed: bool,
    repo: Option<Result<&str, &str>>,
) -> Result<Value, String> {
    let Some(version) = version else {
        return Ok(json!({ "installed": false }));
    };
    let old = parse_version(version).is_none_or(|v| v < MIN_VERSION);
    if old {
        return Ok(json!({ "installed": true, "old": true }));
    }
    if !authed {
        return Ok(json!({ "installed": true, "authed": false }));
    }
    match repo {
        Some(Ok(text)) => {
            let v: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
            Ok(json!({
                "installed": true, "authed": true,
                "repo": v["nameWithOwner"], "url": v["url"], "branch": v["defaultBranchRef"]["name"],
            }))
        }
        Some(Err(e)) if explain(e).starts_with("Questo progetto non ha") => {
            Ok(json!({ "installed": true, "authed": true, "repo": null }))
        }
        Some(Err(e)) => Err(explain(e)),
        None => Ok(json!({ "installed": true, "authed": true, "repo": null })),
    }
}

// The folder must belong to an open project, like every fs_* command.
pub fn project(roots: &Roots, cwd: &str) -> Result<PathBuf, String> {
    guard(&roots.get(), Path::new(cwd), true)
}

#[tauri::command]
pub async fn gh_status(roots: State<'_, Roots>, cwd: String) -> Result<Value, String> {
    status_for(&project(&roots, &cwd)?).await
}

async fn status_for(dir: &Path) -> Result<Value, String> {
    let dir = dir.to_path_buf();
    let version = match run_gh(&dir, &["--version"], None).await {
        Ok(r) if r.code == Some(0) => r.out,
        Ok(_) => return status_json(Some(""), false, None),
        Err(Spawn::Missing) => return status_json(None, false, None),
        Err(Spawn::Other(e)) => return Err(e),
    };
    let auth = run_gh(&dir, &["auth", "status"], None)
        .await
        .map_err(|e| match e {
            Spawn::Missing => "GitHub CLI non trovato.".to_string(),
            Spawn::Other(e) => e,
        })?;
    if auth.code != Some(0) {
        let text = format!("{}{}", auth.out, auth.err);
        // Offline, `auth status` fails too: that is not a missing login.
        if explain(&text).starts_with("Impossibile raggiungere") {
            return Err(explain(&text));
        }
        return status_json(Some(&version), false, None);
    }
    let repo = run_gh(
        &dir,
        &[
            "repo",
            "view",
            "--json",
            "nameWithOwner,url,defaultBranchRef",
        ],
        None,
    )
    .await
    .map_err(|e| match e {
        Spawn::Missing => "GitHub CLI non trovato.".to_string(),
        Spawn::Other(e) => e,
    })?;
    if repo.code == Some(0) {
        status_json(Some(&version), true, Some(Ok(&repo.out)))
    } else {
        status_json(Some(&version), true, Some(Err(&repo.err)))
    }
}

// Runs `gh` and returns its stdout; a failure becomes an Italian message.
async fn gh_out(dir: &Path, args: &[&str]) -> Result<String, String> {
    match run_gh(dir, args, None).await {
        Ok(r) if r.code == Some(0) => Ok(r.out),
        Ok(r) => Err(explain(&r.err)),
        Err(Spawn::Missing) => Err("GitHub CLI non trovato.".into()),
        Err(Spawn::Other(e)) => Err(e),
    }
}

// One word for the dot of a run: queued, running, success, failure, cancelled.
fn run_state(status: &str, conclusion: &str) -> &'static str {
    match (status, conclusion) {
        ("completed", "success") => "success",
        ("completed", "failure" | "timed_out" | "startup_failure") => "failure",
        ("completed", _) => "cancelled",
        ("in_progress", _) => "running",
        _ => "queued",
    }
}

const RUN_FIELDS: &str = "databaseId,workflowName,displayTitle,headBranch,event,status,conclusion,createdAt,updatedAt,url";

// `gh run list --json` → what the panel draws. Missing fields become empty.
fn parse_runs(text: &str) -> Result<Vec<Value>, String> {
    let list: Vec<Value> = serde_json::from_str(text).map_err(|e| e.to_string())?;
    Ok(list
        .iter()
        .map(|r| {
            let s = |k: &str| r[k].as_str().unwrap_or("");
            json!({
                "id": r["databaseId"], "workflow": s("workflowName"), "title": s("displayTitle"),
                "branch": s("headBranch"), "event": s("event"), "url": s("url"),
                "state": run_state(s("status"), s("conclusion")),
                "createdAt": s("createdAt"), "updatedAt": s("updatedAt"),
            })
        })
        .collect())
}

#[tauri::command]
pub async fn gh_runs(roots: State<'_, Roots>, cwd: String) -> Result<Vec<Value>, String> {
    let dir = project(&roots, &cwd)?;
    parse_runs(&gh_out(&dir, &["run", "list", "-L", "30", "--json", RUN_FIELDS]).await?)
}

// `gh run view --json jobs` → name, state, times of each job.
fn parse_jobs(text: &str) -> Result<Vec<Value>, String> {
    let v: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    Ok(v["jobs"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|j| {
            let s = |k: &str| j[k].as_str().unwrap_or("");
            json!({
                "name": s("name"), "state": run_state(s("status"), s("conclusion")),
                "startedAt": s("startedAt"), "completedAt": s("completedAt"),
            })
        })
        .collect())
}

#[tauri::command]
pub async fn gh_run_jobs(
    roots: State<'_, Roots>,
    cwd: String,
    id: u64,
) -> Result<Vec<Value>, String> {
    let dir = project(&roots, &cwd)?;
    parse_jobs(&gh_out(&dir, &["run", "view", &id.to_string(), "--json", "jobs"]).await?)
}

// The arguments of `gh run <action>`; anything but the three actions is refused.
fn run_action_args(action: &str, id: u64) -> Result<Vec<String>, String> {
    let id = id.to_string();
    let args: &[&str] = match action {
        "rerun" => &["run", "rerun", &id],
        "rerunFailed" => &["run", "rerun", &id, "--failed"],
        "cancel" => &["run", "cancel", &id],
        other => return Err(format!("Azione non valida: {other}")),
    };
    Ok(args.iter().map(|a| a.to_string()).collect())
}

#[tauri::command]
pub async fn gh_run_action(
    roots: State<'_, Roots>,
    cwd: String,
    id: u64,
    action: String,
) -> Result<(), String> {
    let dir = project(&roots, &cwd)?;
    let args = run_action_args(&action, id)?;
    gh_out(&dir, &args.iter().map(String::as_str).collect::<Vec<_>>())
        .await
        .map(|_| ())
}

// Workflows a person can start: active, and defined in the repository (the
// "dynamic" ones, like Pages, have no file to dispatch).
fn parse_workflows(text: &str) -> Result<Vec<Value>, String> {
    let list: Vec<Value> = serde_json::from_str(text).map_err(|e| e.to_string())?;
    Ok(list
        .iter()
        .filter(|w| {
            w["state"] == "active"
                && w["path"]
                    .as_str()
                    .is_some_and(|p| p.starts_with(".github/workflows/"))
        })
        .map(|w| json!({ "id": w["id"], "name": w["name"].as_str().unwrap_or("") }))
        .collect())
}

#[tauri::command]
pub async fn gh_workflows(roots: State<'_, Roots>, cwd: String) -> Result<Vec<Value>, String> {
    let dir = project(&roots, &cwd)?;
    parse_workflows(&gh_out(&dir, &["workflow", "list", "--json", "id,name,path,state"]).await?)
}

// A branch or tag name goes to gh as an argument: it must not read as a flag.
fn check_ref(r: &str) -> Result<(), String> {
    if r.is_empty() || r.starts_with('-') || r.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(format!("Branch non valido: {r}"));
    }
    Ok(())
}

#[tauri::command]
pub async fn gh_workflow_run(
    roots: State<'_, Roots>,
    cwd: String,
    workflow: u64,
    branch: String,
) -> Result<(), String> {
    let dir = project(&roots, &cwd)?;
    check_ref(&branch)?;
    gh_out(
        &dir,
        &["workflow", "run", &workflow.to_string(), "--ref", &branch],
    )
    .await
    .map(|_| ())
}

// GitHub's rule for a secret's name, plus the prefix it keeps for itself.
fn check_secret_name(name: &str) -> Result<(), String> {
    let mut chars = name.chars();
    let ok_start = chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_');
    if !ok_start || !chars.all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(format!("Nome del secret non valido: usa lettere, cifre e _, senza iniziare con una cifra ({name})."));
    }
    if name
        .get(..7)
        .is_some_and(|p| p.eq_ignore_ascii_case("GITHUB_"))
    {
        return Err("I nomi che iniziano con GITHUB_ sono riservati da GitHub.".into());
    }
    Ok(())
}

const SECRETS_DENIED: &str =
    "Servono i permessi di amministratore del repository per vedere i secret.";

// `gh secret list --json` → names and update times; GitHub never gives the values.
fn parse_secrets(text: &str) -> Result<Vec<Value>, String> {
    let list: Vec<Value> = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let mut out: Vec<Value> = list
        .iter()
        .map(|x| json!({ "name": x["name"].as_str().unwrap_or(""), "updatedAt": x["updatedAt"].as_str().unwrap_or("") }))
        .collect();
    out.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    Ok(out)
}

fn secrets_error(e: String) -> String {
    if e.starts_with("Non hai i permessi") {
        SECRETS_DENIED.into()
    } else {
        e
    }
}

#[tauri::command]
pub async fn gh_secrets(roots: State<'_, Roots>, cwd: String) -> Result<Vec<Value>, String> {
    let dir = project(&roots, &cwd)?;
    parse_secrets(
        &gh_out(&dir, &["secret", "list", "--json", "name,updatedAt"])
            .await
            .map_err(secrets_error)?,
    )
}

// The value goes through stdin: an argument would show up in `ps` and in the log.
async fn secret_set(bin: &str, dir: &Path, name: &str, value: &str) -> Result<(), String> {
    check_secret_name(name)?;
    if value.is_empty() {
        return Err("Il valore del secret è vuoto.".into());
    }
    match run_with(bin, dir, &["secret", "set", name], Some(value.as_bytes())).await {
        Ok(r) if r.code == Some(0) => Ok(()),
        Ok(r) => Err(secrets_error(explain(&r.err))),
        Err(Spawn::Missing) => Err("GitHub CLI non trovato.".into()),
        Err(Spawn::Other(e)) => Err(e),
    }
}

#[tauri::command]
pub async fn gh_secret_set(
    roots: State<'_, Roots>,
    cwd: String,
    name: String,
    value: String,
) -> Result<(), String> {
    secret_set("gh", &project(&roots, &cwd)?, &name, &value).await
}

#[tauri::command]
pub async fn gh_secret_delete(
    roots: State<'_, Roots>,
    cwd: String,
    name: String,
) -> Result<(), String> {
    let dir = project(&roots, &cwd)?;
    check_secret_name(&name)?;
    gh_out(&dir, &["secret", "delete", &name])
        .await
        .map_err(secrets_error)
        .map(|_| ())
}

// `gh api .../actions/artifacts` → what the panel lists. Sizes are bytes.
fn parse_artifacts(text: &str) -> Result<Vec<Value>, String> {
    let v: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    Ok(v["artifacts"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|a| {
            json!({
                "id": a["id"], "name": a["name"].as_str().unwrap_or(""), "size": a["size_in_bytes"],
                "expired": a["expired"].as_bool().unwrap_or(false),
                "createdAt": a["created_at"].as_str().unwrap_or(""), "expiresAt": a["expires_at"].as_str().unwrap_or(""),
                "run": a["workflow_run"]["id"], "branch": a["workflow_run"]["head_branch"].as_str().unwrap_or(""),
            })
        })
        .collect())
}

#[tauri::command]
pub async fn gh_artifacts(roots: State<'_, Roots>, cwd: String) -> Result<Vec<Value>, String> {
    let dir = project(&roots, &cwd)?;
    parse_artifacts(
        &gh_out(
            &dir,
            &["api", "repos/{owner}/{repo}/actions/artifacts?per_page=50"],
        )
        .await?,
    )
}

// The name becomes a folder under the chosen one: it must not climb out of it or read as a flag.
fn check_artifact_name(name: &str) -> Result<(), String> {
    let bad = name.is_empty()
        || name == "."
        || name == ".."
        || name.starts_with('-')
        || name.contains(['/', '\\', '\0']);
    if bad {
        return Err(format!("Nome dell'artifact non valido: {name}"));
    }
    Ok(())
}

// Where an artifact lands: a new folder named after it inside the chosen one.
fn download_target(dir: &str, name: &str) -> Result<PathBuf, String> {
    check_artifact_name(name)?;
    if dir.is_empty() || !Path::new(dir).is_dir() {
        return Err("Scegli una cartella di destinazione.".into());
    }
    let target = Path::new(dir).join(name);
    if target.exists() {
        return Err(format!(
            "In questa cartella esiste già «{name}»: scegline un'altra."
        ));
    }
    Ok(target)
}

async fn artifact_download(
    bin: &str,
    cwd: &Path,
    run: u64,
    name: &str,
    dir: &str,
) -> Result<PathBuf, String> {
    let target = download_target(dir, name)?;
    let args = [
        "run",
        "download",
        &run.to_string(),
        "-n",
        name,
        "-D",
        &target.to_string_lossy(),
    ];
    match run_with(bin, cwd, &args, None).await {
        Ok(r) if r.code == Some(0) => Ok(target),
        Ok(r) => Err(explain(&r.err)),
        Err(Spawn::Missing) => Err("GitHub CLI non trovato.".into()),
        Err(Spawn::Other(e)) => Err(e),
    }
}

// What Work downloaded in this run: the only paths it will reveal in the file manager.
#[derive(Default)]
pub struct Downloaded(Mutex<Vec<PathBuf>>);

#[tauri::command]
pub async fn gh_artifact_download(
    roots: State<'_, Roots>,
    downloaded: State<'_, Downloaded>,
    cwd: String,
    run: u64,
    name: String,
    dir: String,
) -> Result<String, String> {
    let target = artifact_download("gh", &project(&roots, &cwd)?, run, &name, &dir).await?;
    downloaded.0.lock().unwrap().push(target.clone());
    Ok(target.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn gh_artifact_reveal(
    app: tauri::AppHandle,
    downloaded: State<'_, Downloaded>,
    path: String,
) -> Result<(), String> {
    let path = PathBuf::from(path);
    if !downloaded.0.lock().unwrap().contains(&path) {
        return Err("Percorso non scaricato da Work.".into());
    }
    tauri_plugin_opener::OpenerExt::opener(&app)
        .reveal_item_in_dir(path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn gh_artifact_delete(
    roots: State<'_, Roots>,
    cwd: String,
    id: u64,
) -> Result<(), String> {
    let dir = project(&roots, &cwd)?;
    let path = format!("repos/{{owner}}/{{repo}}/actions/artifacts/{id}");
    gh_out(&dir, &["api", "-X", "DELETE", &path])
        .await
        .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    const VERSION: &str =
        "gh version 2.65.0 (2025-01-06)\nhttps://github.com/cli/cli/releases/tag/v2.65.0\n";
    const REPO: &str = r#"{"defaultBranchRef":{"name":"main"},"nameWithOwner":"overzoomit/work-stack","url":"https://github.com/overzoomit/work-stack"}"#;

    #[test]
    fn missing_gh_is_not_installed() {
        assert_eq!(
            status_json(None, false, None).unwrap(),
            json!({ "installed": false })
        );
    }

    #[test]
    fn an_old_gh_asks_for_an_update() {
        let old = "gh version 2.39.9 (2024-01-01)\n";
        assert_eq!(
            status_json(Some(old), true, None).unwrap(),
            json!({ "installed": true, "old": true })
        );
        assert_eq!(parse_version(VERSION), Some((2, 65)));
        assert_eq!(parse_version("boh"), None);
    }

    #[test]
    fn without_login_the_status_says_so() {
        assert_eq!(
            status_json(Some(VERSION), false, None).unwrap(),
            json!({ "installed": true, "authed": false })
        );
    }

    #[test]
    fn a_remote_that_is_not_github_means_no_repository() {
        let err = "none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`";
        let s = status_json(Some(VERSION), true, Some(Err(err))).unwrap();
        assert_eq!(
            s,
            json!({ "installed": true, "authed": true, "repo": null })
        );
        let none = "no git remotes found";
        assert_eq!(
            status_json(Some(VERSION), true, Some(Err(none))).unwrap()["repo"],
            Value::Null
        );
    }

    #[test]
    fn a_repository_gives_name_url_and_default_branch() {
        let s = status_json(Some(VERSION), true, Some(Ok(REPO))).unwrap();
        assert_eq!(s["repo"], "overzoomit/work-stack");
        assert_eq!(s["url"], "https://github.com/overzoomit/work-stack");
        assert_eq!(s["branch"], "main");
    }

    #[test]
    fn another_failure_is_an_error_with_its_reason() {
        let e = status_json(
            Some(VERSION),
            true,
            Some(Err("error connecting to api.github.com")),
        )
        .unwrap_err();
        assert!(e.starts_with("Impossibile raggiungere GitHub"));
        let e = status_json(Some(VERSION), true, Some(Err("boom"))).unwrap_err();
        assert_eq!(e, "boom");
    }

    #[test]
    fn the_log_line_names_the_subcommand_and_never_a_secret() {
        let line = log_line(
            Path::new("/p"),
            &["secret", "set", "NPM_TOKEN"],
            Some(0),
            12,
        );
        assert_eq!(line, "gh secret set in /p: exit 0 in 12 ms");
        assert!(!line.contains("NPM_TOKEN"));
    }

    #[test]
    fn a_folder_outside_the_open_projects_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let roots = Roots::default();
        roots.set(&[dir.path().to_string_lossy().into_owned()]);
        assert!(project(&roots, &dir.path().to_string_lossy()).is_ok());
        assert!(project(&roots, "/")
            .unwrap_err()
            .contains("fuori dai progetti"));
    }

    #[tokio::test]
    async fn exec_passes_stdin_whole_sets_the_environment_and_reports_the_exit_code() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("gh");
        std::fs::write(
            &fake,
            "#!/bin/sh\ncat\necho \"$GH_PROMPT_DISABLED $NO_COLOR\" >&2\nexit 3\n",
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let secret = b"-----BEGIN-----\nline two\n-----END-----\n";
        let r = exec(
            fake.to_str().unwrap(),
            dir.path(),
            &["secret", "set", "X"],
            Some(secret),
        )
        .await
        .ok()
        .unwrap();
        assert_eq!(
            (r.code, r.out.as_bytes(), r.err.trim()),
            (Some(3), &secret[..], "1 1")
        );
    }

    #[tokio::test]
    async fn a_missing_binary_is_reported_as_missing() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(
            exec("gh-che-non-esiste", dir.path(), &[], None).await,
            Err(Spawn::Missing)
        ));
    }

    const RUNS: &str = r#"[
      {"conclusion":"","createdAt":"2026-10-01T14:36:14Z","databaseId":3,"displayTitle":"fix: x","event":"push","headBranch":"main","status":"in_progress","updatedAt":"2026-10-01T14:36:48Z","url":"https://github.com/o/r/actions/runs/3","workflowName":"release"},
      {"conclusion":"failure","createdAt":"2026-10-01T14:03:04Z","databaseId":2,"displayTitle":"chore","event":"push","headBranch":"v1","status":"completed","updatedAt":"2026-10-01T14:12:27Z","url":"u2","workflowName":"ci"},
      {"databaseId":1}
    ]"#;

    #[test]
    fn status_and_conclusion_map_to_the_dot_states() {
        let cases = [
            ("queued", "", "queued"),
            ("waiting", "", "queued"),
            ("pending", "", "queued"),
            ("requested", "", "queued"),
            ("in_progress", "", "running"),
            ("completed", "success", "success"),
            ("completed", "failure", "failure"),
            ("completed", "timed_out", "failure"),
            ("completed", "startup_failure", "failure"),
            ("completed", "cancelled", "cancelled"),
            ("completed", "skipped", "cancelled"),
            ("completed", "neutral", "cancelled"),
        ];
        for (status, conclusion, want) in cases {
            assert_eq!(run_state(status, conclusion), want, "{status}/{conclusion}");
        }
    }

    #[test]
    fn runs_parse_into_what_the_panel_draws_and_tolerate_missing_fields() {
        let runs = parse_runs(RUNS).unwrap();
        assert_eq!(runs.len(), 3);
        assert_eq!(runs[0]["id"], 3);
        assert_eq!(runs[0]["workflow"], "release");
        assert_eq!(runs[0]["state"], "running");
        assert_eq!(runs[1]["state"], "failure");
        assert_eq!(runs[1]["branch"], "v1");
        assert_eq!(runs[2]["title"], "");
        assert_eq!(runs[2]["state"], "queued");
        assert!(parse_runs("not json").is_err());
        assert!(parse_runs("[]").unwrap().is_empty());
    }

    #[test]
    fn jobs_parse_with_state_and_times() {
        let text = r#"{"jobs":[{"name":"build","status":"completed","conclusion":"success","startedAt":"2026-10-01T14:36:18Z","completedAt":"2026-10-01T14:36:24Z","steps":[]},{"name":"test","status":"in_progress","conclusion":""}]}"#;
        let jobs = parse_jobs(text).unwrap();
        assert_eq!(jobs.len(), 2);
        assert_eq!(
            (jobs[0]["name"].as_str(), jobs[0]["state"].as_str()),
            (Some("build"), Some("success"))
        );
        assert_eq!(jobs[0]["completedAt"], "2026-10-01T14:36:24Z");
        assert_eq!(jobs[1]["state"], "running");
        assert!(parse_jobs("{}").unwrap().is_empty());
    }

    #[test]
    fn a_run_action_becomes_its_gh_arguments_and_nothing_else_does() {
        assert_eq!(run_action_args("rerun", 7).unwrap(), ["run", "rerun", "7"]);
        assert_eq!(
            run_action_args("rerunFailed", 7).unwrap(),
            ["run", "rerun", "7", "--failed"]
        );
        assert_eq!(
            run_action_args("cancel", 7).unwrap(),
            ["run", "cancel", "7"]
        );
        assert!(run_action_args("delete", 7).is_err());
        assert!(run_action_args("", 7).is_err());
        assert!(run_action_args("rerun --repo x/y", 7).is_err());
    }

    #[test]
    fn only_active_workflows_defined_in_the_repository_can_be_started() {
        let text = r#"[
          {"id":1,"name":"release","path":".github/workflows/release.yml","state":"active"},
          {"id":2,"name":"pages","path":"dynamic/pages/pages-build-deployment","state":"active"},
          {"id":3,"name":"old","path":".github/workflows/old.yml","state":"disabled_manually"}]"#;
        assert_eq!(
            parse_workflows(text).unwrap(),
            [json!({ "id": 1, "name": "release" })]
        );
    }

    #[test]
    fn a_ref_that_reads_as_a_flag_or_has_spaces_is_refused() {
        for ok in ["main", "feature/x", "v1.2.0", "user/fix-#12"] {
            assert!(check_ref(ok).is_ok(), "{ok}");
        }
        for bad in ["", "--repo=x/y", "-f", "a b", "a\nb"] {
            assert!(check_ref(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_folder_without_git_is_a_folder_without_a_github_repository() {
        let err = "failed to run git: fatal: not a git repository (or any of the parent directories): .git";
        assert_eq!(
            status_json(Some(VERSION), true, Some(Err(err))).unwrap()["repo"],
            Value::Null
        );
    }

    #[test]
    fn explain_knows_workflow_failures() {
        assert!(
            explain("Workflow does not have 'workflow_dispatch' trigger")
                .contains("workflow_dispatch")
        );
        assert!(explain("could not prompt: required input missing").contains("input"));
        assert!(explain("HTTP 422: No ref found for: nope").contains("push"));
    }

    #[test]
    fn a_secret_name_follows_githubs_rule() {
        for ok in [
            "NPM_TOKEN",
            "_x",
            "a1",
            "TAURI_SIGNING_PRIVATE_KEY",
            "github",
            "GITHUB",
        ] {
            assert!(check_secret_name(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "1ABC",
            "A B",
            "A-B",
            "à",
            "A\n",
            "GITHUB_TOKEN",
            "github_token",
            "GitHub_X",
        ] {
            assert!(check_secret_name(bad).is_err(), "{bad:?}");
        }
        assert!(check_secret_name("GITHUB_TOKEN")
            .unwrap_err()
            .contains("GITHUB_"));
    }

    #[test]
    fn secrets_parse_sorted_by_name() {
        let text = r#"[{"name":"ZED","updatedAt":"2026-01-02T00:00:00Z"},{"name":"ALPHA","updatedAt":"2026-01-01T00:00:00Z"}]"#;
        let list = parse_secrets(text).unwrap();
        assert_eq!(list[0]["name"], "ALPHA");
        assert_eq!(list[1]["updatedAt"], "2026-01-02T00:00:00Z");
        assert!(parse_secrets("[]").unwrap().is_empty());
    }

    #[test]
    fn missing_admin_rights_get_the_secrets_message() {
        let e = secrets_error(explain("HTTP 403: Resource not accessible by integration"));
        assert_eq!(e, SECRETS_DENIED);
        assert_eq!(secrets_error("boom".into()), "boom");
    }

    // The value of a secret: whole, multi-line, on stdin, and never in the arguments.
    #[tokio::test]
    async fn a_secret_value_reaches_gh_on_stdin_and_never_in_argv() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("gh");
        std::fs::write(&fake, "#!/bin/sh\necho \"$@\" > argv\ncat > stdin\n").unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let value = "-----BEGIN CERT-----\nMIIB s3cr3t\n-----END CERT-----\n";
        secret_set(fake.to_str().unwrap(), dir.path(), "TLS_CERT", value)
            .await
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("stdin")).unwrap(),
            value
        );
        let argv = std::fs::read_to_string(dir.path().join("argv")).unwrap();
        assert_eq!(argv.trim(), "secret set TLS_CERT");
        assert!(!argv.contains("s3cr3t"));
    }

    #[tokio::test]
    async fn a_bad_name_or_an_empty_value_never_reaches_gh() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("gh");
        std::fs::write(&fake, "#!/bin/sh\ntouch ran\n").unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let bin = fake.to_str().unwrap();
        assert!(secret_set(bin, dir.path(), "GITHUB_TOKEN", "x")
            .await
            .is_err());
        assert!(secret_set(bin, dir.path(), "1A", "x").await.is_err());
        assert!(secret_set(bin, dir.path(), "OK", "").await.is_err());
        assert!(!dir.path().join("ran").exists());
    }

    #[tokio::test]
    async fn a_failing_gh_gives_a_message_without_the_value() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("gh");
        std::fs::write(
            &fake,
            "#!/bin/sh\ncat >/dev/null\necho 'HTTP 403: Resource not accessible' >&2\nexit 1\n",
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let e = secret_set(fake.to_str().unwrap(), dir.path(), "OK", "hunter2")
            .await
            .unwrap_err();
        assert_eq!(e, SECRETS_DENIED);
        assert!(!e.contains("hunter2"));
    }

    // Against the real GitHub, in the repository the tests run from. Run by hand:
    //   cargo test --manifest-path src-tauri/Cargo.toml real_secret -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn real_secret_roundtrip() {
        let dir = std::env::current_dir().unwrap();
        let name = "WORK_TEST_TEMPORARY";
        let value = "first line of verysecret\nsecond line\n";
        secret_set("gh", &dir, name, value).await.unwrap();
        let listed = parse_secrets(
            &gh_out(&dir, &["secret", "list", "--json", "name,updatedAt"])
                .await
                .unwrap(),
        )
        .unwrap();
        let found = listed.iter().any(|x| x["name"] == name);
        gh_out(&dir, &["secret", "delete", name]).await.unwrap();
        let after = parse_secrets(
            &gh_out(&dir, &["secret", "list", "--json", "name,updatedAt"])
                .await
                .unwrap(),
        )
        .unwrap();
        assert!(found, "the new secret is listed");
        assert!(
            !after.iter().any(|x| x["name"] == name),
            "and gone after deleting it"
        );
    }

    const ARTIFACTS: &str = r#"{"total_count":2,"artifacts":[
      {"id":11,"name":"github-pages","size_in_bytes":215525,"expired":false,"created_at":"2026-10-01T14:36:23Z","expires_at":"2026-10-02T14:36:22Z","workflow_run":{"id":36877625346,"head_branch":"main"}},
      {"id":10,"name":"old","size_in_bytes":5,"expired":true,"workflow_run":{"id":1}}]}"#;

    #[test]
    fn artifacts_parse_with_size_expiry_and_origin() {
        let list = parse_artifacts(ARTIFACTS).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(
            (
                list[0]["id"].as_u64(),
                list[0]["size"].as_u64(),
                list[0]["run"].as_u64()
            ),
            (Some(11), Some(215525), Some(36877625346))
        );
        assert_eq!(
            (
                list[0]["name"].as_str(),
                list[0]["branch"].as_str(),
                list[0]["expired"].as_bool()
            ),
            (Some("github-pages"), Some("main"), Some(false))
        );
        assert_eq!(list[1]["expired"], true);
        assert_eq!(list[1]["expiresAt"], "");
        assert!(parse_artifacts("{}").unwrap().is_empty());
    }

    #[test]
    fn an_artifact_name_cannot_climb_out_of_the_folder_or_read_as_a_flag() {
        for ok in ["github-pages", "build.zip", "bundle-macos-latest", "a b"] {
            assert!(check_artifact_name(ok).is_ok(), "{ok}");
        }
        for bad in ["", ".", "..", "../x", "a/b", "a\\b", "-n", "a\0b"] {
            assert!(check_artifact_name(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn the_target_needs_an_existing_folder_and_a_free_name() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path().to_string_lossy().into_owned();
        assert_eq!(download_target(&d, "art").unwrap(), dir.path().join("art"));
        assert!(download_target("", "art").is_err());
        assert!(download_target(&format!("{d}/nope"), "art").is_err());
        std::fs::create_dir(dir.path().join("art")).unwrap();
        assert!(download_target(&d, "art")
            .unwrap_err()
            .contains("esiste già"));
    }

    #[tokio::test]
    async fn a_download_runs_gh_into_a_folder_named_after_the_artifact() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("gh");
        std::fs::write(
            &fake,
            "#!/bin/sh\necho \"$@\" > \"$(dirname \"$0\")/argv\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let dest = dir.path().join("out");
        std::fs::create_dir(&dest).unwrap();
        let got = artifact_download(
            fake.to_str().unwrap(),
            dir.path(),
            9,
            "my-art",
            dest.to_str().unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(got, dest.join("my-art"));
        let argv = std::fs::read_to_string(dir.path().join("argv")).unwrap();
        assert_eq!(
            argv.trim(),
            format!(
                "run download 9 -n my-art -D {}",
                dest.join("my-art").display()
            )
        );
        assert!(artifact_download(
            fake.to_str().unwrap(),
            dir.path(),
            9,
            "../escape",
            dest.to_str().unwrap()
        )
        .await
        .is_err());
    }

    // Against the real GitHub: downloads the newest live artifact of the repository the tests run from.
    #[tokio::test]
    #[ignore]
    async fn real_artifact_download() {
        let cwd = std::env::current_dir().unwrap();
        let text = gh_out(
            &cwd,
            &["api", "repos/{owner}/{repo}/actions/artifacts?per_page=50"],
        )
        .await
        .unwrap();
        let list = parse_artifacts(&text).unwrap();
        let live = list
            .iter()
            .find(|a| a["expired"] == false)
            .expect("a live artifact");
        let (run, name) = (
            live["run"].as_u64().unwrap(),
            live["name"].as_str().unwrap(),
        );
        let dest = tempfile::tempdir().unwrap();
        let got = artifact_download("gh", &cwd, run, name, dest.path().to_str().unwrap())
            .await
            .unwrap();
        assert!(
            got.is_dir() && std::fs::read_dir(&got).unwrap().count() > 0,
            "files landed in {got:?}"
        );
    }

    // The real gh against a folder, with the expectation in WORK_EXPECT (a JSON subset of the status).
    // Run by hand, e.g. with GH_CONFIG_DIR=$(mktemp -d) for "no login" or a PATH without gh:
    //   WORK_EXPECT='{"authed":false}' GH_CONFIG_DIR=$(mktemp -d) cargo test real_status -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn real_status() {
        let dir = std::env::var("WORK_TEST_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| std::env::current_dir().unwrap());
        let got = status_for(&dir).await;
        println!("status: {got:?}");
        let want: Value =
            serde_json::from_str(&std::env::var("WORK_EXPECT").unwrap_or_else(|_| "{}".into()))
                .unwrap();
        let got = got.unwrap();
        for (k, v) in want.as_object().unwrap() {
            assert_eq!(&got[k], v, "{k}");
        }
    }

    #[test]
    fn explain_knows_the_common_causes() {
        assert_eq!(
            explain("To get started with GitHub CLI, please run:  gh auth login"),
            "Non hai effettuato l'accesso a GitHub."
        );
        assert_eq!(
            explain("HTTP 403: Resource not accessible by integration"),
            "Non hai i permessi per farlo su questo repository."
        );
        assert_eq!(explain(""), "GitHub CLI ha restituito un errore.");
    }
}

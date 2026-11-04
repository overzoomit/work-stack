// Global settings: API keys and endpoints for the external services Work
// talks to (Plane, Jev, custom environment). Kept in one file in the app
// config dir, readable by the user only: these are secrets.
use crate::plane_dogwatch::{safe_segment, trusted_url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Manager};

pub const FILE: &str = "settings.json";
pub const DEFAULT_BASE_URL: &str = "https://plane.overzoom.it";
pub const DEFAULT_WORKSPACE: &str = "overzoom";
const TEST_TIMEOUT: Duration = Duration::from_secs(10);

/// The settings shown in the Settings… dialog and saved between runs.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AppSettings {
    pub plane_api_key: String,
    pub plane_base_url: String,
    pub plane_workspace: String,
    pub jev_api_key: String,
    pub jev_endpoint: String,
    pub custom_env: BTreeMap<String, String>,
}

static CONFIG: OnceLock<PathBuf> = OnceLock::new();

/// The path is fixed once, at start: every command and the Plane dogwatch
/// read the same file even if HOME changes later.
pub fn init(app: &AppHandle) {
    if let Ok(dir) = app.path().app_config_dir() {
        let _ = CONFIG.set(dir.join(FILE));
    }
}

pub fn file() -> PathBuf {
    CONFIG.get().cloned().unwrap_or_else(default_file)
}

// Matches Tauri's app_config_dir without an AppHandle (the dogwatch may run
// before the path is set in tests).
fn default_file() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        crate::mcp::home()
            .join("Library/Application Support/it.overzoom.work")
            .join(FILE)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let base = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| crate::mcp::home().join(".config"));
        base.join("it.overzoom.work").join(FILE)
    }
}

// Environment variable names only: a saved key must never be a path or a
// command line fragment.
fn valid_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn trim_url(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

/// Empty strings become the app's defaults; a hand-edited file with the wrong
/// types or bad variable names is cleaned instead of breaking the dialog.
pub fn normalize(mut s: AppSettings) -> AppSettings {
    s.plane_api_key = s.plane_api_key.trim().to_string();
    s.plane_base_url = trim_url(&s.plane_base_url);
    if s.plane_base_url.is_empty() {
        s.plane_base_url = DEFAULT_BASE_URL.into();
    }
    s.plane_workspace = s.plane_workspace.trim().to_string();
    if s.plane_workspace.is_empty() {
        s.plane_workspace = DEFAULT_WORKSPACE.into();
    }
    s.jev_api_key = s.jev_api_key.trim().to_string();
    s.jev_endpoint = trim_url(&s.jev_endpoint);
    s.custom_env
        .retain(|k, v| valid_env_name(k) && !v.contains('\0'));
    s
}

/// A missing or broken file is not an error: the app starts with the defaults.
pub fn load(path: &Path) -> AppSettings {
    let Ok(text) = fs::read_to_string(path) else {
        return normalize(AppSettings::default());
    };
    serde_json::from_str::<AppSettings>(&text)
        .map(normalize)
        .unwrap_or_else(|_| normalize(AppSettings::default()))
}

/// Written to a temporary file, chmod 0600, then renamed over the old one: a
/// write cut short never leaves a truncated file and the key is never briefly
/// readable by others.
pub fn save(path: &Path, settings: &AppSettings) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let body = serde_json::to_string_pretty(settings)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, body)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))?;
    }
    fs::rename(&tmp, path)
}

/// What the Plane dogwatch uses when the project or the environment has no
/// value of its own.
pub fn plane_settings() -> AppSettings {
    load(&file())
}

/// Key-value environment pairs that are exported globally to tmux and the runtime
/// so that every agent window, terminal and child process can access them.
pub fn agent_env_vars() -> Vec<(String, String)> {
    let s = load(&file());
    agent_env_vars_from(&s)
}

pub fn agent_env_vars_from(s: &AppSettings) -> Vec<(String, String)> {
    let mut vars = Vec::new();
    if !s.plane_api_key.is_empty() {
        vars.push(("PLANE_API_KEY".into(), s.plane_api_key.clone()));
    }
    if !s.plane_base_url.is_empty() {
        vars.push(("PLANE_BASE_URL".into(), s.plane_base_url.clone()));
    }
    if !s.plane_workspace.is_empty() {
        vars.push(("PLANE_WORKSPACE".into(), s.plane_workspace.clone()));
        vars.push(("PLANE_WORKSPACE_SLUG".into(), s.plane_workspace.clone()));
    }
    if !s.jev_api_key.is_empty() {
        vars.push(("JEV_API_KEY".into(), s.jev_api_key.clone()));
        // oz plugin / Jev CLI relies on TYPESAFE_API_KEY
        vars.push(("TYPESAFE_API_KEY".into(), s.jev_api_key.clone()));
    }
    if !s.jev_endpoint.is_empty() {
        vars.push(("JEV_ENDPOINT".into(), s.jev_endpoint.clone()));
    }
    for (k, v) in &s.custom_env {
        vars.push((k.clone(), v.clone()));
    }
    vars
}

/// Applies global settings to the current process environment and propagates them
/// to the global tmux environment so agents receive them immediately.
pub fn apply_env() {
    for (k, v) in agent_env_vars() {
        std::env::set_var(&k, &v);
    }
    crate::tmux::sync_agent_env(None);
}

#[tauri::command]
pub fn settings_get() -> AppSettings {
    plane_settings()
}

#[tauri::command]
pub fn settings_save(settings: AppSettings) -> Result<AppSettings, String> {
    let settings = normalize(settings);
    save(&file(), &settings).map_err(|e| format!("cannot save settings: {e}"))?;
    apply_env();
    Ok(settings)
}

// Fields are checked before the network is touched, so a typo gets a quick,
// precise answer instead of a timeout.
pub fn check_plane(
    base_url: &str,
    api_key: &str,
    workspace: &str,
) -> Result<(String, String, String), String> {
    let base_url = trim_url(base_url);
    let api_key = api_key.trim().to_string();
    let workspace = workspace.trim().to_string();
    if api_key.is_empty() {
        return Err("Enter a Plane API key".into());
    }
    if !safe_segment(&workspace) {
        return Err("The workspace slug can only contain letters, digits, - and _".into());
    }
    if !trusted_url(&base_url) {
        return Err("The server URL must be https (http only for this machine)".into());
    }
    Ok((base_url, api_key, workspace))
}

fn test_plane(base_url: &str, api_key: &str, workspace: &str) -> Result<String, String> {
    let (base_url, api_key, workspace) = check_plane(base_url, api_key, workspace)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(TEST_TIMEOUT)
        .user_agent("work-settings/1.0")
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("{base_url}/api/v1/workspaces/{workspace}/projects/");
    let response = client
        .get(&url)
        .header("X-API-Key", &api_key)
        .send()
        .map_err(|e| format!("Could not reach {base_url}: {e}"))?;
    match response.status().as_u16() {
        200..=299 => Ok(format!("Connected to {base_url}")),
        401 | 403 => Err("The API key was rejected".into()),
        404 => Err(format!("Workspace “{workspace}” was not found")),
        status => Err(format!("Plane answered HTTP {status}")),
    }
}

#[tauri::command]
pub async fn settings_test_plane(
    base_url: String,
    api_key: String,
    workspace: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || test_plane(&base_url, &api_key, &workspace))
        .await
        .map_err(|e| e.to_string())?
}

/// Portable configuration bundle for export/import between machines.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExportBundle {
    pub version: u32,
    pub exported_at: String,
    pub settings: AppSettings,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub telegram: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub projects: Vec<String>,
}

pub fn create_export_bundle(
    settings: AppSettings,
    telegram: Option<Value>,
    projects: Vec<String>,
) -> ExportBundle {
    let exported_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_default();
    ExportBundle {
        version: 1,
        exported_at,
        settings: normalize(settings),
        telegram,
        projects,
    }
}

pub fn parse_import_bundle(text: &str) -> Result<ExportBundle, String> {
    let bundle: ExportBundle = serde_json::from_str(text)
        .map_err(|e| format!("Invalid configuration bundle JSON: {e}"))?;
    if bundle.version == 0 || bundle.version > 2 {
        return Err(format!(
            "Unsupported configuration bundle version: {}",
            bundle.version
        ));
    }
    Ok(bundle)
}

#[tauri::command]
pub fn settings_is_configured() -> bool {
    let s = load(&file());
    !s.plane_api_key.trim().is_empty() || !s.jev_api_key.trim().is_empty()
}

#[tauri::command]
pub fn settings_export(
    app: tauri::AppHandle,
    state: tauri::State<crate::AppState>,
) -> Result<String, String> {
    let s = load(&file());

    // Read telegram config if present
    let telegram = app
        .path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("telegram.json"))
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<Value>(&t).ok());

    // Read project paths
    let projects = {
        let lock = state.state.lock().unwrap();
        crate::project_paths(&lock)
    };

    let bundle = create_export_bundle(s, telegram, projects);
    serde_json::to_string_pretty(&bundle).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn settings_import(
    app: tauri::AppHandle,
    state: tauri::State<crate::AppState>,
    bundle_json: String,
) -> Result<AppSettings, String> {
    let bundle = parse_import_bundle(&bundle_json)?;
    let normalized = normalize(bundle.settings);
    save(&file(), &normalized).map_err(|e| format!("cannot save settings: {e}"))?;
    apply_env();

    // Restore telegram if present
    if let Some(tg) = bundle.telegram {
        if let Ok(dir) = app.path().app_config_dir() {
            let tg_file = dir.join("telegram.json");
            let _ = fs::create_dir_all(&dir);
            let tmp = tg_file.with_extension("json.tmp");
            if let Ok(body) = serde_json::to_string_pretty(&tg) {
                if fs::write(&tmp, body).is_ok() {
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
                    }
                    let _ = fs::rename(&tmp, &tg_file);
                }
            }
        }
    }

    // Restore projects if present
    if !bundle.projects.is_empty() {
        let mut app_state = state.state.lock().unwrap();
        let mut existing_projects: Vec<Value> = app_state
            .get("projects")
            .and_then(|p| p.as_array())
            .cloned()
            .unwrap_or_default();

        let existing_paths: std::collections::HashSet<String> = existing_projects
            .iter()
            .filter_map(|p| p.get("path").and_then(|x| x.as_str()).map(String::from))
            .collect();

        for path_str in bundle.projects {
            let p = std::path::Path::new(&path_str);
            // Add if path exists on this system and isn't already in list
            if p.exists() && !existing_paths.contains(&path_str) {
                existing_projects.push(serde_json::json!({ "path": path_str }));
            }
        }

        app_state["projects"] = Value::Array(existing_projects);
        crate::allow_projects(&app, &app_state);
        let _ = crate::store::save(&state.file, &app_state);
    }

    if let Some(tg) = app.try_state::<std::sync::Arc<crate::telegram::TelegramState>>() {
        crate::telegram::emit_status(&app, &tg);
    }

    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn a_missing_file_gives_the_defaults() {
        let d = dir();
        let s = load(&d.path().join("settings.json"));
        assert_eq!(s.plane_base_url, DEFAULT_BASE_URL);
        assert_eq!(s.plane_workspace, DEFAULT_WORKSPACE);
        assert!(s.plane_api_key.is_empty());
        assert!(s.custom_env.is_empty());
    }

    #[test]
    fn saves_and_reads_back_every_field() {
        let d = dir();
        let f = d.path().join("settings.json");
        let s = AppSettings {
            plane_api_key: "plane-secret".into(),
            plane_base_url: "https://plane.example.it/".into(),
            plane_workspace: "acme".into(),
            jev_api_key: "jev-secret".into(),
            jev_endpoint: "https://jev.example.it/".into(),
            custom_env: BTreeMap::from([("OPENAI_API_KEY".into(), "sk-1".into())]),
        };
        save(&f, &normalize(s.clone())).unwrap();
        let back = load(&f);
        assert_eq!(back.plane_api_key, "plane-secret");
        assert_eq!(back.plane_base_url, "https://plane.example.it");
        assert_eq!(back.plane_workspace, "acme");
        assert_eq!(back.jev_api_key, "jev-secret");
        assert_eq!(back.jev_endpoint, "https://jev.example.it");
        assert_eq!(back.custom_env["OPENAI_API_KEY"], "sk-1");
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_readable_by_the_user_only() {
        use std::os::unix::fs::PermissionsExt;
        let d = dir();
        let f = d.path().join("settings.json");
        save(&f, &normalize(AppSettings::default())).unwrap();
        let mode = fs::metadata(&f).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn the_save_leaves_no_temporary_file_behind() {
        let d = dir();
        let f = d.path().join("settings.json");
        save(&f, &normalize(AppSettings::default())).unwrap();
        save(&f, &normalize(AppSettings::default())).unwrap();
        assert!(f.is_file());
        assert!(!d.path().join("settings.json.tmp").exists());
    }

    #[test]
    fn a_broken_or_wrongly_shaped_file_falls_back_safely() {
        let d = dir();
        let f = d.path().join("settings.json");
        for text in [
            "{ rotto",
            "null",
            "[]",
            r#"{"plane_api_key": 3}"#,
            r#"{"plane_base_url": null}"#,
        ] {
            fs::write(&f, text).unwrap();
            let s = load(&f);
            assert_eq!(s.plane_base_url, DEFAULT_BASE_URL, "{text}");
            assert!(s.plane_api_key.is_empty(), "{text}");
        }
    }

    #[test]
    fn normalization_trims_and_drops_unsafe_environment_names() {
        let s = normalize(AppSettings {
            plane_api_key: "  key  ".into(),
            plane_base_url: " https://plane.example.it/// ".into(),
            plane_workspace: " acme ".into(),
            jev_api_key: " j ".into(),
            jev_endpoint: " ".into(),
            custom_env: BTreeMap::from([
                ("GOOD_KEY".into(), "1".into()),
                ("9BAD".into(), "2".into()),
                ("HAS-DASH".into(), "3".into()),
                ("PATH".into(), "a\0b".into()),
            ]),
        });
        assert_eq!(s.plane_api_key, "key");
        assert_eq!(s.plane_base_url, "https://plane.example.it");
        assert_eq!(s.plane_workspace, "acme");
        assert_eq!(s.jev_api_key, "j");
        assert_eq!(s.jev_endpoint, "");
        assert_eq!(s.custom_env.len(), 1);
        assert_eq!(s.custom_env["GOOD_KEY"], "1");
    }

    #[test]
    fn agent_env_vars_extracts_plane_jev_and_custom_env() {
        let d = dir();
        let f = d.path().join("settings.json");
        let s = normalize(AppSettings {
            plane_api_key: "plane-secret".into(),
            plane_base_url: "https://plane.oz.it".into(),
            plane_workspace: "oz".into(),
            jev_api_key: "jev-secret".into(),
            jev_endpoint: "https://jev.oz.it/api".into(),
            custom_env: BTreeMap::from([("MY_VAR".into(), "val".into())]),
        });
        save(&f, &s).unwrap();
        let loaded = load(&f);
        assert_eq!(loaded.plane_api_key, "plane-secret");
        assert_eq!(loaded.jev_api_key, "jev-secret");

        let vars = agent_env_vars_from(&loaded);
        assert!(vars
            .iter()
            .any(|(k, v)| k == "PLANE_API_KEY" && v == "plane-secret"));
        assert!(vars
            .iter()
            .any(|(k, v)| k == "PLANE_BASE_URL" && v == "https://plane.oz.it"));
        assert!(vars
            .iter()
            .any(|(k, v)| k == "PLANE_WORKSPACE" && v == "oz"));
        assert!(vars
            .iter()
            .any(|(k, v)| k == "PLANE_WORKSPACE_SLUG" && v == "oz"));
        assert!(vars
            .iter()
            .any(|(k, v)| k == "JEV_API_KEY" && v == "jev-secret"));
        assert!(vars
            .iter()
            .any(|(k, v)| k == "TYPESAFE_API_KEY" && v == "jev-secret"));
        assert!(vars
            .iter()
            .any(|(k, v)| k == "JEV_ENDPOINT" && v == "https://jev.oz.it/api"));
        assert!(vars.iter().any(|(k, v)| k == "MY_VAR" && v == "val"));
    }

    #[test]
    fn check_plane_rejects_bad_input_before_the_network() {
        assert_eq!(
            check_plane(DEFAULT_BASE_URL, "", DEFAULT_WORKSPACE).unwrap_err(),
            "Enter a Plane API key"
        );
        assert!(check_plane(DEFAULT_BASE_URL, "k", "bad/workspace").is_err());
        assert!(check_plane("http://plane.example.it", "k", "ws").is_err());
        assert!(check_plane("http://localhost:8080", "k", "ws").is_ok());
        assert_eq!(
            check_plane(" https://plane.example.it/ ", " k ", " ws ").unwrap(),
            ("https://plane.example.it".into(), "k".into(), "ws".into())
        );
    }

    #[test]
    fn a_saved_key_comes_before_the_environment_for_the_dogwatch() {
        let d = dir();
        let f = d.path().join("settings.json");
        fs::write(
            d.path().join(".plane.json"),
            json!({ "project_id": "p1" }).to_string(),
        )
        .unwrap();
        save(
            &f,
            &normalize(AppSettings {
                plane_api_key: "from-settings".into(),
                plane_base_url: "https://plane.settings.it".into(),
                ..AppSettings::default()
            }),
        )
        .unwrap();
        let saved = load(&f);
        let env = |k: &str| (k == "PLANE_API_KEY").then(|| "from-env".to_string());
        let c = crate::plane_dogwatch::load_config_with(d.path(), &env, "", Some(&saved)).unwrap();
        assert_eq!(c.api_key, "from-settings");
        assert_eq!(c.base_url, "https://plane.settings.it");
    }

    #[test]
    fn export_bundle_creates_valid_json_and_roundtrips() {
        let s = AppSettings {
            plane_api_key: "my-key".into(),
            plane_base_url: "https://plane.oz.it".into(),
            plane_workspace: "oz".into(),
            jev_api_key: "jev-key".into(),
            jev_endpoint: "https://jev.oz.it".into(),
            custom_env: BTreeMap::from([("ENV_VAR".into(), "val".into())]),
        };
        let tg = Some(json!({
            "token": "bot:secret",
            "chat_id": "12345"
        }));
        let projects = vec!["/home/user/workspace/p1".to_string()];

        let bundle = create_export_bundle(s.clone(), tg.clone(), projects.clone());
        assert_eq!(bundle.version, 1);
        assert_eq!(bundle.settings.plane_api_key, "my-key");
        assert_eq!(bundle.telegram, tg);
        assert_eq!(bundle.projects, projects);

        let json_text = serde_json::to_string(&bundle).unwrap();
        let parsed = parse_import_bundle(&json_text).unwrap();
        assert_eq!(parsed.version, 1);
        assert_eq!(parsed.settings.plane_api_key, "my-key");
        assert_eq!(parsed.settings.jev_api_key, "jev-key");
        assert_eq!(parsed.telegram, tg);
        assert_eq!(parsed.projects, projects);
    }

    #[test]
    fn parse_import_bundle_validates_json_and_version() {
        assert!(parse_import_bundle("broken json").is_err());
        assert!(parse_import_bundle(r#"{"version":0,"exported_at":"","settings":{}}"#).is_err());
        assert!(parse_import_bundle(r#"{"version":99,"exported_at":"","settings":{}}"#).is_err());
        let valid =
            parse_import_bundle(r#"{"version":1,"exported_at":"123","settings":{}}"#).unwrap();
        assert_eq!(valid.version, 1);
    }
}

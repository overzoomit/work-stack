// Work's backend: the commands behind window.work (see src/renderer/bridge.js).
mod pty;
mod runconfigs;
mod store;

use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Manager, State};

struct AppState {
    state: Mutex<Value>,
    file: PathBuf,
}

// ── Projects ─────────────────────────────────────────────────
#[tauri::command]
fn projects_load(s: State<AppState>) -> Value {
    s.state.lock().unwrap().clone()
}

#[tauri::command]
fn projects_save(s: State<AppState>, next: Value) -> Result<(), String> {
    let mut state = s.state.lock().unwrap();
    store::merge(&mut state, next);
    store::save(&s.file, &state).map_err(|e| e.to_string())
}

// ── App ──────────────────────────────────────────────────────
// Platform and arch named like Node's process.platform / process.arch,
// which the renderer already knows.
#[tauri::command]
fn app_info(app: tauri::AppHandle) -> Value {
    let home = app.path().home_dir().unwrap_or_default();
    let cwd = std::env::var("WORK_CWD").map(PathBuf::from).or_else(|_| std::env::current_dir()).unwrap_or_else(|_| home.clone());
    let platform = match std::env::consts::OS {
        "macos" => "darwin",
        os => os,
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        a => a,
    };
    json!({
        "home": home,
        "cwd": cwd,
        "platform": platform,
        "arch": arch,
        "version": app.package_info().version.to_string(),
        "versions": { "tauri": tauri::VERSION, "webview": tauri::webview_version().unwrap_or_default() },
    })
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // Debug/tests: WORK_USER_DATA keeps state separate from the real profile.
            let (dir, legacy) = match std::env::var("WORK_USER_DATA") {
                Ok(d) => (PathBuf::from(d), None),
                Err(_) => (app.path().app_data_dir()?, app.path().config_dir().ok().map(|d| d.join("Work").join("state.json"))),
            };
            let file = dir.join("state.json");
            let state = store::load(&file, legacy.as_deref());
            app.manage(AppState { state: Mutex::new(state), file });
            app.manage(pty::PtyState::new());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            projects_load,
            projects_save,
            app_info,
            pty::pty_subscribe,
            pty::pty_create,
            pty::pty_write,
            pty::pty_ack,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_cwd,
            runconfigs::run_detect,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Work")
        .run(|app, event| {
            // Quitting hangs up every shell, like closing their terminal windows.
            if let tauri::RunEvent::Exit = event {
                app.state::<pty::PtyState>().mgr.kill_all();
            }
        });
}

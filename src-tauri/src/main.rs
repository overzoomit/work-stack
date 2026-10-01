// Work's backend: the commands behind window.work (see src/renderer/bridge.js).
mod agents;
mod app;
mod claudeprocs;
mod diag;
mod fsops;
mod git;
mod github;
mod gitwatch;
mod pty;
mod runconfigs;
mod store;
mod sysstats;

use serde_json::Value;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

struct AppState {
    state: Mutex<Value>,
    file: PathBuf,
}

// ── Projects ─────────────────────────────────────────────────
// The open projects are also what authorizes file access (see fsops).
fn project_paths(state: &Value) -> Vec<String> {
    state["projects"].as_array().into_iter().flatten().filter_map(|p| p["path"].as_str().map(String::from)).collect()
}

// ponytail: a closed project stays previewable (asset protocol) until restart;
// forbid_directory is permanent, so a rebuilt scope would be needed to drop it.
fn allow_projects(app: &tauri::AppHandle, state: &Value) {
    let paths = project_paths(state);
    for p in &paths {
        let _ = app.asset_protocol_scope().allow_directory(p, true);
    }
    app.state::<fsops::Roots>().set(&paths);
}

#[tauri::command]
fn projects_load(s: State<AppState>) -> Value {
    s.state.lock().unwrap().clone()
}

#[tauri::command]
fn projects_save(app: tauri::AppHandle, s: State<AppState>, next: Value) -> Result<(), String> {
    let mut state = s.state.lock().unwrap();
    store::merge(&mut state, next);
    allow_projects(&app, &state);
    store::save(&s.file, &state).map_err(|e| e.to_string())
}

fn main() {
    #[cfg(not(debug_assertions))]
    app::detach_from_terminal();
    app::adopt_login_path();
    let builder = tauri::Builder::default();
    // Release only: `npm run dev` must not hand its launch to the installed Work.
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(app::open_again));
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(std::sync::Mutex::new(sysinfo::System::new()))
        .manage(fsops::Roots::default())
        .setup(|app| {
            // Debug/tests: WORK_USER_DATA keeps state separate from the real profile.
            let (dir, legacy) = match std::env::var("WORK_USER_DATA") {
                Ok(d) => (PathBuf::from(d), None),
                Err(_) => (app.path().app_data_dir()?, app.path().config_dir().ok().map(|d| d.join("Work").join("state.json"))),
            };
            let log = if std::env::var_os("WORK_USER_DATA").is_some() { dir.clone() } else { app.path().app_log_dir()? };
            diag::init(&log.join("work.log"));
            app::log_start(app.handle());
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let main = handle.clone();
                diag::watchdog(
                    move |noop| {
                        let _ = main.run_on_main_thread(noop);
                    },
                    move |ms| {
                        let _ = handle.emit("diag:stalled", [ms as u64]);
                    },
                )
            });
            let file = dir.join("state.json");
            let state = store::load(&file, legacy.as_deref());
            allow_projects(app.handle(), &state);
            app.manage(AppState { state: Mutex::new(state), file });
            app.manage(pty::PtyState::new());
            let handle = app.handle().clone();
            app.manage(gitwatch::GitWatcher::new(move |repo, kind| {
                let _ = handle.emit("git:changed", (repo, kind));
            }));
            #[cfg(target_os = "macos")]
            {
                app.set_menu(app::mac_menu(app.handle())?)?;
                app.on_menu_event(app::on_menu);
            }
            let handle = app.handle().clone();
            let agents = agents::AgentWatcher::new(agents::projects_dir(), claudeprocs::sessions_dir(), move |list| {
                let _ = handle.emit("agents:update", [list]);
            });
            agents.start();
            app.manage(agents);
            app::create_window(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            projects_load,
            projects_save,
            app::app_info,
            app::app_stats,
            app::app_pick_folder,
            app::app_export_log,
            app::app_reveal_export,
            app::app_set_unsaved,
            app::app_quit,
            app::app_open_external,
            app::app_copy,
            app::app_paste,
            app::app_drop_paths,
            app::debug_log,
            pty::pty_subscribe,
            pty::pty_create,
            pty::pty_write,
            pty::pty_ack,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_cwd,
            git::git_root,
            git::git_status,
            git::git_log,
            git::git_branches,
            git::git_commit,
            git::git_containing,
            git::git_file_diff,
            git::git_action,
            github::gh_status,
            github::gh_runs,
            gitwatch::git_watch,
            gitwatch::git_unwatch,
            fsops::fs_list,
            fsops::fs_read,
            fsops::fs_files,
            fsops::fs_write,
            fsops::fs_grep,
            fsops::fs_create,
            fsops::fs_rename,
            fsops::fs_move,
            fsops::fs_copy_in,
            fsops::fs_trash,
            fsops::fs_open_path,
            fsops::fs_reveal,
            runconfigs::run_detect,
            agents::agents_list,
            agents::agents_has_history,
            agents::agents_stop,
            agents::agents_available,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Work")
        .run(|app, event| {
            // Quitting hangs up every shell, like closing their terminal windows.
            if let tauri::RunEvent::Exit = event {
                app.state::<pty::PtyState>().mgr.kill_all();
                app.state::<agents::AgentWatcher>().stop();
            }
        });
}

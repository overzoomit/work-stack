// Work's backend: the commands behind window.work (see src/renderer/bridge.js).
mod agent_kb;
mod agents;
mod analytics;
mod app;
mod claudeprocs;
mod diag;
mod dogwatch;
mod fsops;
mod git;
mod github;
mod gitwatch;
mod mcp;
mod ngrok;
mod plane_dogwatch;
mod plugins;
mod pty;
mod remote;
mod runconfigs;
mod settings;
mod state_db;
mod store;
mod sysstats;
mod telegram;
mod tmux;
mod webview;

use serde_json::Value;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State};

struct AppState {
    state: Mutex<Value>,
    file: PathBuf,
}

// ── Projects ─────────────────────────────────────────────────
// The open projects are also what authorizes file access (see fsops).
// Remote projects have a synthetic ssh:// identity and no local folder: they
// must not become filesystem roots nor start a local tmux/dogwatch session.
pub fn project_paths(state: &Value) -> Vec<String> {
    state["projects"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| p.get("remote").is_none())
        .filter_map(|p| p["path"].as_str().map(String::from))
        .collect()
}

// ponytail: a closed project stays previewable (asset protocol) until restart;
// forbid_directory is permanent, so a rebuilt scope would be needed to drop it.
pub fn allow_projects(app: &tauri::AppHandle, state: &Value) {
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
    let res = store::save(&s.file, &state).map_err(|e| e.to_string());
    // The Telegram project resolver locks the same state: emitting while holding it deadlocks.
    drop(state);
    if let Some(tg) = app.try_state::<Arc<telegram::TelegramState>>() {
        telegram::emit_status(&app, &tg);
    }
    res
}

fn main() {
    #[cfg(not(debug_assertions))]
    app::detach_from_terminal();
    app::adopt_login_path();
    let builder = tauri::Builder::default();
    // Release only: `npm run dev` must not hand its launch to the installed Work.
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(app::open_again));
    // Embedded WebDriver server for `npm run test:e2e`; never in a normal build.
    #[cfg(feature = "e2e")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(std::sync::Mutex::new(sysinfo::System::new()))
        .manage(fsops::Roots::default())
        .manage(github::Downloaded::default())
        .manage(app::PendingUpdate::default())
        .setup(|app| {
            // Debug/tests: WORK_USER_DATA keeps state separate from the real profile.
            let (dir, legacy) = match std::env::var("WORK_USER_DATA") {
                Ok(d) => (PathBuf::from(d), None),
                Err(_) => (
                    app.path().app_data_dir()?,
                    app.path()
                        .config_dir()
                        .ok()
                        .map(|d| d.join("Work").join("state.json")),
                ),
            };
            let log = if std::env::var_os("WORK_USER_DATA").is_some() {
                dir.clone()
            } else {
                app.path().app_log_dir()?
            };
            diag::init(&log.join("work.log"));
            settings::init(app.handle());
            settings::apply_env();
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
            // Telegram/PM tooling drives a local tmux session: a remote project
            // active at startup must not be adopted as one.
            let active_project = state["active"]
                .as_str()
                .filter(|active| {
                    state["projects"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|p| p["path"] == *active && p.get("remote").is_none())
                })
                .map(String::from);
            allow_projects(app.handle(), &state);
            app.manage(AppState {
                state: Mutex::new(state),
                file,
            });
            app.manage(pty::PtyState::new());
            let handle = app.handle().clone();
            app.manage(Arc::new(ngrok::Tunnels::new(move |project| {
                let _ = handle.emit("ngrok:update", [project]);
            })));
            let telegram = Arc::new(telegram::TelegramState::new());
            let handle_for_tg = app.handle().clone();
            telegram.set_projects_resolver(move || {
                let s = handle_for_tg.state::<AppState>();
                let state = s.state.lock().unwrap();
                let active = state["active"].as_str().map(String::from);
                let projects: Vec<telegram::TargetProject> = state["projects"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|p| p.get("remote").is_none())
                    .filter_map(|p| {
                        let path = p["path"].as_str()?.to_string();
                        let name = std::path::Path::new(&path)
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or(&path)
                            .to_string();
                        let session = crate::tmux::session_for_project(std::path::Path::new(&path));
                        Some(telegram::TargetProject {
                            name,
                            path,
                            session,
                        })
                    })
                    .collect();
                (active, projects)
            });
            app.manage(Arc::clone(&telegram));
            let notifier = Arc::clone(&telegram);
            // Restore the connection saved before the restart, off the UI
            // thread so a slow network does not hold up the window.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                telegram::restore(&handle, &telegram, active_project.as_deref());
            });
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
            let agents = agents::AgentWatcher::new(
                agents::projects_dir(),
                claudeprocs::sessions_dir(),
                move |list| {
                    let _ = handle.emit("agents:update", [list]);
                },
            );
            app.manage(agents);
            // The first scan reads every transcript ever saved: not before the window.
            let handle = app.handle().clone();
            std::thread::spawn(move || handle.state::<agents::AgentWatcher>().start());
            let handle = app.handle().clone();
            let events = app.handle().clone();
            dogwatch::spawn(
                move || project_paths(&handle.state::<AppState>().state.lock().unwrap()),
                move |project, session, pending, live, windows| {
                    // Dogwatch stays internal to the PM: nothing is forwarded
                    // to Telegram without an explicit PM decision.
                    let _ = events.emit(
                        "dogwatch:update",
                        (project, session, pending, live, windows),
                    );
                },
            );
            let handle = app.handle().clone();
            let events = app.handle().clone();
            app.manage(plane_dogwatch::spawn(
                move || project_paths(&handle.state::<AppState>().state.lock().unwrap()),
                move |text| match telegram::notify(&notifier, text) {
                    Ok(_) => "sent".into(),
                    Err(e) => format!("not sent: {e}"),
                },
                move |report| {
                    let _ = events.emit("plane_dogwatch:update", report);
                },
            ));
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
            app::app_update_check,
            app::app_update_install,
            app::app_update_restart,
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
            pty::pty_tmux_window,
            git::git_root,
            git::git_status,
            git::git_log,
            git::git_branches,
            git::git_commit,
            git::git_containing,
            git::git_file_diff,
            git::git_generate_commit_message,
            git::git_explain_diff,
            git::git_action,
            github::gh_status,
            github::gh_runs,
            github::gh_run_jobs,
            github::gh_run_action,
            github::gh_workflows,
            github::gh_workflow_run,
            github::gh_secrets,
            github::gh_secret_set,
            github::gh_secret_delete,
            github::gh_artifacts,
            github::gh_artifact_download,
            github::gh_artifact_reveal,
            github::gh_artifact_delete,
            gitwatch::git_watch,
            gitwatch::git_unwatch,
            fsops::fs_list,
            fsops::fs_read,
            fsops::fs_files,
            fsops::project_files_quick,
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
            analytics::analytics_get_summary,
            dogwatch::dogwatch_inspect,
            dogwatch::dogwatch_explain,
            dogwatch::dogwatch_answer,
            plane_dogwatch::plane_dogwatch_status,
            plane_dogwatch::plane_dogwatch_sync_now,
            state_db::work_state_snapshot,
            state_db::work_state_register_member,
            state_db::work_state_remove_member,
            agent_kb::agent_kb_provision,
            mcp::mcp_status,
            mcp::mcp_launch_browser,
            ngrok::ngrok_start,
            ngrok::ngrok_stop,
            ngrok::ngrok_status,
            webview::webview_capture_screenshot,
            webview::webview_reveal_snapshot,
            plugins::plugins_list,
            plugins::plugins_check_updates,
            plugins::plugins_install,
            plugins::plugins_update,
            plugins::plugins_remove,
            settings::settings_get,
            settings::settings_save,
            settings::settings_test_plane,
            settings::settings_is_configured,
            settings::settings_export,
            settings::settings_import,
            telegram::telegram_status,
            telegram::telegram_connect,
            telegram::telegram_disconnect,
            telegram::telegram_send,
            tmux::tmux_is_available,
            tmux::tmux_session_for_project,
            tmux::tmux_ensure_session,
            tmux::tmux_list_windows,
            tmux::tmux_new_window,
            tmux::tmux_kill_window,
            tmux::tmux_kill_session,
            tmux::tmux_send_keys,
            tmux::tmux_capture_pane,
            tmux::tmux_get_history_timeline,
            tmux::tmux_fork_from_history,
            tmux::tmux_split_pane,
            tmux::tmux_resize_pane,
            tmux::tmux_zoom_pane,
            tmux::tmux_close_pane,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Work")
        .run(|app, event| {
            // Quitting hangs up every shell, like closing their terminal windows.
            if let tauri::RunEvent::Exit = event {
                app.state::<pty::PtyState>().mgr.kill_all();
                app.state::<agents::AgentWatcher>().stop();
                app.state::<Arc<ngrok::Tunnels>>().stop_all();
                telegram::shutdown(app.state::<Arc<telegram::TelegramState>>().inner());
            }
        });
}

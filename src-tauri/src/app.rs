// The window and the app-level commands: info, machine load, folder picker,
// clipboard, external links, and the renderer's console in debug runs.
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

// Web pages and mail links only: other schemes could launch local programs.
pub fn is_web_link(url: &str) -> bool {
    url.starts_with("http://") || url.starts_with("https://") || url.starts_with("mailto:")
}

// The window only ever shows Work's own page (and, in the preview's iframe,
// project files through the asset protocol). A link followed by mistake would
// replace the whole UI and leave every terminal without its pane.
// `dev` is the CLI's dev server, which serves the page under `npm run dev`.
pub fn is_own_page(url: &Url, dev: Option<&Url>) -> bool {
    matches!(url.scheme(), "tauri" | "asset")
        || matches!(url.host_str(), Some("tauri.localhost" | "asset.localhost"))
        || url.as_str() == "about:blank"
        || dev.is_some_and(|d| d.origin() == url.origin())
}

pub fn create_window(app: &AppHandle) -> tauri::Result<()> {
    let opener = app.clone();
    let dev = if cfg!(dev) { app.config().build.dev_url.clone() } else { None };
    let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
        .title("Work")
        .inner_size(1600.0, 980.0)
        .min_inner_size(1100.0, 640.0)
        .background_color(tauri::window::Color(12, 13, 16, 255))
        .on_navigation(move |url| is_own_page(url, dev.as_ref()))
        // New windows are refused; web links open in the browser instead.
        .on_new_window(move |url, _| {
            if url.scheme() == "http" || url.scheme() == "https" {
                let _ = opener.opener().open_url(url.as_str(), None::<&str>);
            }
            NewWindowResponse::Deny
        })
        .on_page_load(|webview, payload| {
            // Debug: WORK_EVAL runs a snippet in the page once it has booted.
            let Ok(js) = std::env::var("WORK_EVAL") else { return };
            if !matches!(payload.event(), PageLoadEvent::Finished) {
                return;
            }
            let webview = webview.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(2));
                // Injected as-is: the page's CSP forbids eval().
                let script = format!(
                    "Promise.resolve().then(() => ({js})).then((r) => r !== undefined && window.__TAURI__.core.invoke('debug_log', {{ level: 'eval', msg: String(r) }}))"
                );
                let _ = webview.eval(script);
            });
        });
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(14.0, 20.0));
    let win = builder.build()?;

    let emitter = app.clone();
    win.on_window_event(move |e| {
        if let WindowEvent::Focused(true) = e {
            let _ = emitter.emit("app:focus", json!([]));
        }
    });
    if std::env::var("WORK_DEVTOOLS").is_ok() {
        #[cfg(debug_assertions)]
        win.open_devtools();
    }
    Ok(())
}

// macOS application menu. The default one has "Close Window" on ⌘W: Work
// has a single window, so ⌘W (the habit to close a terminal tab) would quit
// everything, terminals and running agents included. This one keeps the
// standard editing shortcuts (⌘C, ⌘V, ⌘A…) and ⌘Q, without a close item.
#[cfg(target_os = "macos")]
pub fn mac_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, PredefinedMenuItem as P, Submenu};
    let app_menu = Submenu::with_items(
        app,
        "Work",
        true,
        &[
            &P::about(app, None, None)?,
            &P::separator(app)?,
            &P::services(app, None)?,
            &P::separator(app)?,
            &P::hide(app, None)?,
            &P::hide_others(app, None)?,
            &P::show_all(app, None)?,
            &P::separator(app)?,
            &P::quit(app, None)?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Modifica",
        true,
        &[&P::undo(app, None)?, &P::redo(app, None)?, &P::separator(app)?, &P::cut(app, None)?, &P::copy(app, None)?, &P::paste(app, None)?, &P::select_all(app, None)?],
    )?;
    let window = Submenu::with_items(app, "Finestra", true, &[&P::minimize(app, None)?, &P::maximize(app, None)?, &P::separator(app)?, &P::bring_all_to_front(app, None)?])?;
    Menu::with_items(app, &[&app_menu, &edit, &window])
}

// ── Commands ─────────────────────────────────────────────────
// Platform and arch named like Node's process.platform / process.arch,
// which the renderer already knows.
#[tauri::command]
pub fn app_info(app: AppHandle) -> Value {
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

#[tauri::command]
pub fn app_stats(stats: tauri::State<Mutex<sysinfo::System>>) -> Value {
    crate::sysstats::sample(&mut stats.lock().unwrap())
}

#[tauri::command]
pub async fn app_pick_folder(app: AppHandle) -> Option<String> {
    let picked = tauri::async_runtime::spawn_blocking(move || app.dialog().file().set_can_create_directories(true).blocking_pick_folder()).await.ok()??;
    picked.into_path().ok().map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn app_open_external(app: AppHandle, url: String) {
    if is_web_link(&url) {
        let _ = app.opener().open_url(url, None::<&str>);
    }
}

#[tauri::command]
pub fn app_copy(app: AppHandle, text: String) {
    let _ = app.clipboard().write_text(text);
}

#[tauri::command]
pub fn app_paste(app: AppHandle) -> String {
    app.clipboard().read_text().unwrap_or_default()
}

// Renderer errors and warnings (and WORK_EVAL results) on the terminal that started Work.
#[tauri::command]
pub fn debug_log(level: String, msg: String) {
    eprintln!("[{level}] {msg}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_web_and_mail_links_open_outside() {
        assert!(is_web_link("https://example.com/doc"));
        assert!(is_web_link("http://localhost:3000"));
        assert!(is_web_link("mailto:a@b.c"));
        assert!(!is_web_link("file:///etc/passwd"));
        assert!(!is_web_link("vscode://open"));
        assert!(!is_web_link("javascript:alert(1)"));
    }

    #[test]
    fn a_dropped_file_or_a_link_does_not_replace_the_ui_regression() {
        let dev = Url::parse("http://localhost:1430").unwrap();
        let page = |u: &str| is_own_page(&Url::parse(u).unwrap(), Some(&dev));
        assert!(page("tauri://localhost/index.html"), "reloading Work itself is fine");
        assert!(page("http://tauri.localhost/index.html"), "Linux and Windows serve it over http");
        assert!(page("asset://localhost/%2Fp/pagina.html"), "an HTML preview");
        assert!(!page("file:///home/u/foto.png"), "a dropped file");
        assert!(!page("https://example.com/"));
        assert!(page("http://localhost:1430/index.html"), "the dev server");
        assert!(!page("http://localhost:3000/"), "another local server is not Work");
    }
}

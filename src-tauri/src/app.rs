// The window and the app-level commands: info, machine load, folder picker,
// clipboard, external links, and the renderer's console in debug runs.
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
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

// Like `code .`: the folder given on the command line, resolved against the
// caller's cwd. Flags are skipped (macOS may still pass -psn_… from Finder).
pub fn open_arg(args: impl IntoIterator<Item = String>, cwd: &Path) -> Result<Option<PathBuf>, String> {
    let Some(arg) = args.into_iter().skip(1).find(|a| !a.starts_with('-')) else { return Ok(None) };
    match cwd.join(&arg).canonicalize() {
        Ok(path) if path.is_dir() => Ok(Some(path)),
        _ => Err(format!("work: non è una cartella: {arg}")),
    }
}

// `work .` from a terminal gives the prompt back, like `code .`. The folder is
// checked here, where an error can still be printed; then Work runs again
// without the terminal (in its own process group) and this process exits.
#[cfg(not(debug_assertions))]
pub fn detach_from_terminal() {
    use std::io::IsTerminal;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    if !std::io::stdin().is_terminal() {
        return;
    }
    let cwd = std::env::current_dir().unwrap_or_default();
    let open = open_arg(std::env::args(), &cwd).unwrap_or_else(|e| {
        eprintln!("{e}");
        std::process::exit(1)
    });
    let Ok(exe) = std::env::current_exe() else { return };
    let child = Command::new(exe).args(open).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).process_group(0).spawn();
    if child.is_ok() {
        std::process::exit(0);
    }
}

// A second `work <folder>` while Work runs: this window opens it and comes forward.
#[cfg_attr(debug_assertions, allow(dead_code))]
pub fn open_again(app: &AppHandle, args: Vec<String>, cwd: String) {
    if let Ok(Some(path)) = open_arg(args, Path::new(&cwd)) {
        let _ = app.emit("app:open", [path]);
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

// Started from Finder or a desktop launcher, Work gets the system's bare PATH
// (no Homebrew, no ~/.local/bin), so git and the agent CLIs may not be found.
// The login shell's PATH is the one a terminal would have. From a terminal,
// the PATH is already the user's.
// It runs before the log is open: the outcome waits in LOGIN for log_start.
static LOGIN: OnceLock<String> = OnceLock::new();

pub fn adopt_login_path() {
    if std::env::var_os("TERM").is_some() {
        return;
    }
    let (path, outcome) = login_path(&crate::pty::user_shell());
    if let Some(path) = path {
        std::env::set_var("PATH", path); // before any thread starts
    }
    let _ = LOGIN.set(outcome);
}

// Interactive first (-i): nvm and ~/.local/bin are often added in ~/.zshrc or
// ~/.bashrc, which a plain login shell skips. An rc that hangs or fails there
// (exec tmux, a prompt for input) falls back to -lc. The outcome says which
// flags worked and how long each took.
pub fn login_path(shell: &str) -> (Option<String>, String) {
    let mut tried = vec![];
    for flags in ["-lic", "-lc"] {
        let start = std::time::Instant::now();
        let res = shell_path(shell, flags);
        let ms = start.elapsed().as_millis();
        match res {
            Ok(path) => {
                tried.push(format!("{flags} ok in {ms} ms"));
                return (Some(path), tried.join(", "));
            }
            Err(e) => tried.push(format!("{flags} {e} in {ms} ms")),
        }
    }
    (None, tried.join(", "))
}

// What follows the marker: an interactive shell may print its own text first.
pub const PATH_MARK: &str = "__WORK_PATH__";

pub fn after_mark(out: &str) -> Option<&str> {
    out.rsplit_once(PATH_MARK).and_then(|(_, rest)| rest.lines().next())
}

fn shell_path(shell: &str, flags: &str) -> Result<String, &'static str> {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    let print = format!("printf '\\n{PATH_MARK}%s\\n' \"$PATH\"");
    let mut child = Command::new(shell).args([flags, &print]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|_| "errore")?;
    // A profile waiting for input must not hold the start up.
    let deadline = Instant::now() + Duration::from_secs(3);
    while child.try_wait().map_err(|_| "errore")?.is_none() {
        if Instant::now() > deadline {
            let _ = child.kill();
            return Err("timeout");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let out = child.wait_with_output().map_err(|_| "errore")?;
    match after_mark(&String::from_utf8_lossy(&out.stdout)) {
        Some(path) if out.status.success() && path.contains('/') => Ok(path.to_string()),
        _ => Err("errore"),
    }
}

// The first lines of every run: what Work started with.
pub fn log_start(app: &AppHandle) {
    use crate::diag::{log, Level};
    let yes = |b: bool| if b { "sì" } else { "no" };
    log(
        Level::Info,
        "app",
        format!(
            "avvio Work {} su {}/{}, da terminale: {}, SHELL={}, shell di login: {}, SSH_AUTH_SOCK: {}",
            app.package_info().version,
            std::env::consts::OS,
            std::env::consts::ARCH,
            yes(std::env::var_os("TERM").is_some()),
            crate::pty::user_shell(),
            LOGIN.get().map_or("non usata", String::as_str),
            yes(std::env::var_os("SSH_AUTH_SOCK").is_some()),
        ),
    );
    log(Level::Debug, "app", format!("PATH={}", std::env::var("PATH").unwrap_or_default()));
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
        // Tauri's own drop handler takes every drag over the window, those
        // inside the page too (tree, terminals, tabs): the page handles them.
        .disable_drag_drop_handler()
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
    let open = std::env::current_dir().ok().and_then(|d| open_arg(std::env::args(), &d).ok().flatten());
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
        "open": open,
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

// Paths of the files being dragged in from outside, which the page only
// knows by name. macOS keeps them on the drag pasteboard for the whole drag;
// on Linux the page reads them from text/uri-list instead.
#[tauri::command]
pub fn app_drop_paths() -> Vec<String> {
    drag_paths()
}

// ponytail: NSFilenamesPboardType is deprecated but still filled by Finder (wry
// reads it too); per-item NSPasteboardTypeFileURL if Apple drops it.
#[cfg(target_os = "macos")]
#[allow(deprecated)]
fn drag_paths() -> Vec<String> {
    use objc2_app_kit::{NSFilenamesPboardType, NSPasteboard, NSPasteboardNameDrag};
    use objc2_foundation::{NSArray, NSString};
    let pb = unsafe { NSPasteboard::pasteboardWithName(NSPasteboardNameDrag) };
    let Some(list) = (unsafe { pb.propertyListForType(NSFilenamesPboardType) }) else { return vec![] };
    let Ok(list) = list.downcast::<NSArray>() else { return vec![] };
    list.iter().filter_map(|p| p.downcast::<NSString>().ok()).map(|p| p.to_string()).collect()
}

#[cfg(not(target_os = "macos"))]
fn drag_paths() -> Vec<String> {
    vec![]
}

// Renderer errors and warnings (and WORK_EVAL results), in the log.
#[tauri::command]
pub fn debug_log(level: String, msg: String) {
    use crate::diag::Level;
    let level = match level.as_str() {
        "error" => Level::Error,
        "warn" => Level::Warn,
        "debug" => Level::Debug,
        _ => Level::Info,
    };
    crate::diag::log(level, "ui", msg);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    #[allow(deprecated)]
    fn the_paths_of_a_drag_from_finder_are_read_from_the_drag_pasteboard() {
        use objc2_app_kit::{NSFilenamesPboardType, NSPasteboard, NSPasteboardNameDrag};
        use objc2_foundation::{NSArray, NSString};
        let files = ["/tmp/a b.txt", "/tmp/cartella"].map(NSString::from_str);
        unsafe {
            let pb = NSPasteboard::pasteboardWithName(NSPasteboardNameDrag);
            pb.clearContents();
            assert!(pb.setPropertyList_forType(&NSArray::from_retained_slice(&files), NSFilenamesPboardType));
        }
        assert_eq!(drag_paths(), ["/tmp/a b.txt", "/tmp/cartella"]);
    }

    #[test]
    fn the_login_shell_gives_its_path() {
        let path = login_path("/bin/sh").0.expect("sh prints its PATH");
        assert!(path.split(':').any(|d| d == "/usr/bin" || d == "/bin"), "{path}");
        assert_eq!(login_path("/percorso/vuoto/shell").0, None);
    }

    // A fake shell: some text of its own first, and an extra PATH entry only
    // when interactive, like an rc that adds ~/.local/bin.
    fn fake_shell(dir: &Path, interactive: &str) -> String {
        use std::os::unix::fs::PermissionsExt;
        let sh = dir.join("fakesh");
        std::fs::write(&sh, format!("#!/bin/sh\necho 'Benvenuto!'\ncase \"$1\" in *i*) {interactive} ;; esac\neval \"$2\"\n")).unwrap();
        std::fs::set_permissions(&sh, std::fs::Permissions::from_mode(0o755)).unwrap();
        sh.to_string_lossy().into_owned()
    }

    #[test]
    fn the_login_path_comes_from_the_interactive_shell_without_its_noise() {
        let dir = tempfile::tempdir().unwrap();
        let (path, outcome) = login_path(&fake_shell(dir.path(), "PATH=/solo/interattiva:$PATH"));
        let path = path.unwrap();
        assert!(path.starts_with("/solo/interattiva:"), "{path}");
        assert!(!path.contains("Benvenuto"), "{path}");
        assert!(outcome.starts_with("-lic ok in "), "{outcome}");
    }

    #[test]
    fn an_interactive_shell_that_never_ends_falls_back_to_lc() {
        let dir = tempfile::tempdir().unwrap();
        let (path, outcome) = login_path(&fake_shell(dir.path(), "exec sleep 30"));
        assert!(path.unwrap().contains('/'));
        assert!(outcome.starts_with("-lic timeout in "), "{outcome}");
        assert!(outcome.contains(", -lc ok in "), "{outcome}");
    }

    #[test]
    fn work_opens_the_folder_given_on_the_command_line() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("repo/sub")).unwrap();
        std::fs::write(root.join("file.txt"), "").unwrap();
        let sub = root.join("repo/sub");
        let open = |args: &[&str]| open_arg(["work"].iter().chain(args).map(|a| a.to_string()), &sub);

        assert_eq!(open(&[]), Ok(None), "no folder: restore the saved projects");
        assert_eq!(open(&["."]), Ok(Some(sub.clone())));
        assert_eq!(open(&["../"]), Ok(Some(root.join("repo"))));
        assert_eq!(open(&[root.to_str().unwrap()]), Ok(Some(root.clone())));
        assert_eq!(open(&["-psn_0_12345", "."]), Ok(Some(sub.clone())), "flags are skipped");
        assert_eq!(open(&["nope"]), Err("work: non è una cartella: nope".into()));
        assert_eq!(open(&["../../file.txt"]), Err("work: non è una cartella: ../../file.txt".into()));
    }

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

// Docked browser preview support: a QA snapshot of what the iframe shows.
// The page cannot read a cross-origin iframe's pixels, so the backend asks the
// OS screenshot tool for the screen and writes a PNG under the Work data dir.
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;
use url::Url;

// A filename-safe label for the captured address: "localhost:5173" becomes
// "localhost-5173". Anything that is not a URL falls back to "preview", so a
// caller cannot steer the file outside the snapshot folder.
fn slug_for(target: &str) -> String {
    let raw = Url::parse(target)
        .ok()
        .and_then(|url| {
            let host = url.host_str()?.to_string();
            Some(match url.port() {
                Some(port) => format!("{host}-{port}"),
                None => host,
            })
        })
        .unwrap_or_else(|| "preview".to_string());
    let mut slug: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    while slug.contains("--") {
        slug = slug.replace("--", "-");
    }
    slug.trim_matches('-').chars().take(48).collect()
}

// The tools are tried in order; the first one that writes a non-empty file
// wins. Wayland (grim/spectacle), X11 (import/scrot) and GNOME are covered.
fn candidate_commands(path: &Path) -> Vec<(&'static str, Vec<String>)> {
    let target = path.to_string_lossy().to_string();
    #[cfg(target_os = "macos")]
    {
        vec![("screencapture", vec!["-x".to_string(), target])]
    }
    #[cfg(not(target_os = "macos"))]
    {
        vec![
            ("grim", vec![target.clone()]),
            (
                "spectacle",
                vec![
                    "-b".to_string(),
                    "-n".to_string(),
                    "-o".to_string(),
                    target.clone(),
                ],
            ),
            ("gnome-screenshot", vec!["-f".to_string(), target.clone()]),
            (
                "import",
                vec!["-window".to_string(), "root".to_string(), target.clone()],
            ),
            ("scrot", vec!["--overwrite".to_string(), target]),
        ]
    }
}

fn written(path: &Path) -> bool {
    path.metadata().is_ok_and(|m| m.len() > 0)
}

fn capture_screen(path: &Path) -> Result<(), String> {
    let mut failures = Vec::new();
    for (program, args) in candidate_commands(path) {
        match Command::new(program).args(&args).status() {
            Ok(status) if status.success() && written(path) => return Ok(()),
            Ok(status) => failures.push(format!("{program}: uscita {status}")),
            Err(err) => failures.push(format!("{program}: {err}")),
        }
    }
    Err(format!(
        "Impossibile catturare lo schermo: nessuno strumento disponibile ha funzionato ({}). Su Linux serve grim, spectacle, gnome-screenshot oppure ImageMagick.",
        failures.join("; ")
    ))
}

fn snapshots_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("snapshots");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn write_snapshot(app: &AppHandle, target: &str) -> Result<PathBuf, String> {
    let dir = snapshots_dir(app)?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let path = dir.join(format!("webview-{}-{stamp}.png", slug_for(target)));
    capture_screen(&path)?;
    Ok(path)
}

// `url_or_id` names the preview being captured (address or pane id). It only
// labels the file: the OS capture covers the whole Work window.
#[tauri::command]
pub async fn webview_capture_screenshot(
    app: AppHandle,
    url_or_id: String,
) -> Result<String, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let path = write_snapshot(&handle, &url_or_id)?;
        Ok(path.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// Reveals a snapshot in the file manager. Only files under the snapshot folder
// are accepted: the renderer must not be able to reveal arbitrary paths.
#[tauri::command]
pub fn webview_reveal_snapshot(app: AppHandle, path: String) -> Result<(), String> {
    let dir = snapshots_dir(&app)?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let file = Path::new(&path).canonicalize().map_err(|e| e.to_string())?;
    if !file.starts_with(&dir) {
        return Err("Percorso snapshot non valido".into());
    }
    app.opener()
        .reveal_item_in_dir(file)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_local_address_becomes_a_readable_file_label() {
        assert_eq!(slug_for("http://localhost:5173/"), "localhost-5173");
        assert_eq!(
            slug_for("https://ab12.ngrok-free.app"),
            "ab12-ngrok-free-app"
        );
        assert_eq!(slug_for("http://127.0.0.1:3000"), "127-0-0-1-3000");
    }

    #[test]
    fn a_malformed_target_cannot_escape_the_snapshot_folder() {
        let slug = slug_for("../../etc/passwd");
        assert_eq!(slug, "preview");
        assert!(!slug.contains(['/', '.', '\\']));
    }

    #[test]
    fn every_capture_tool_writes_the_requested_png() {
        let path = Path::new("/tmp/work-shot.png");
        let commands = candidate_commands(path);
        assert!(!commands.is_empty());
        for (program, args) in commands {
            assert!(!program.is_empty());
            assert!(
                args.iter().any(|a| a == "/tmp/work-shot.png"),
                "{program} does not receive the destination"
            );
        }
    }
}

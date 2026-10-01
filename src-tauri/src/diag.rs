// Work's log: one line per event, to work.log and to stderr. The installed app
// has no terminal, so without the file nothing it does would leave a trace.
// Never logged: terminal output, transcripts, file contents, commit messages,
// clipboard text, environment variables other than PATH, SHELL and TERM.
use std::fmt;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Level {
    Error,
    Warn,
    Info,
    Debug,
}

impl fmt::Display for Level {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.pad(match self {
            Level::Error => "ERROR",
            Level::Warn => "WARN",
            Level::Info => "INFO",
            Level::Debug => "DEBUG",
        })
    }
}

// Past this size, at start, work.log becomes work.log.1 (one generation).
const MAX: u64 = 5 * 1024 * 1024;

static FILE: OnceLock<Mutex<File>> = OnceLock::new();

// Tests read back what was logged (lines of parallel tests mix: match on unique text).
#[cfg(test)]
pub static CAPTURED: Mutex<Vec<String>> = Mutex::new(Vec::new());

// Opens the log for the whole run. A log that can't be opened leaves stderr only.
pub fn init(file: &Path) {
    rotate(file);
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(f) = OpenOptions::new().create(true).append(true).open(file) {
        let _ = FILE.set(Mutex::new(f));
    }
}

fn rotate(file: &Path) {
    if std::fs::metadata(file).is_ok_and(|m| m.len() > MAX) {
        let _ = std::fs::rename(file, file.with_extension("log.1"));
    }
}

fn debug_enabled() -> bool {
    static DEBUG: OnceLock<bool> = OnceLock::new();
    *DEBUG.get_or_init(|| std::env::var("WORK_DEBUG").is_ok_and(|v| v == "1"))
}

fn wanted(level: Level, debug: bool) -> bool {
    level != Level::Debug || debug
}

// One line per event, to work.log and to stderr. DEBUG only with WORK_DEBUG=1.
// A failed write is ignored: logging never breaks what it records.
pub fn log(level: Level, area: &str, msg: impl fmt::Display) {
    if !wanted(level, debug_enabled()) {
        return;
    }
    let line = line(&now_local(), level, area, &msg.to_string());
    eprint!("{line}");
    if let Some(f) = FILE.get() {
        let _ = f
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .write_all(line.as_bytes());
    }
    #[cfg(test)]
    CAPTURED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push(line);
}

// The lines after the first (a stack, a stderr) are indented under it.
fn line(time: &str, level: Level, area: &str, msg: &str) -> String {
    format!(
        "{time} {level:<5} {area:<8} {}\n",
        msg.trim_end().replace('\n', "\n    ")
    )
}

fn now_local() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs() as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_r(&secs, &mut tm) };
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:03}",
        tm.tm_year + 1900,
        tm.tm_mon + 1,
        tm.tm_mday,
        tm.tm_hour,
        tm.tm_min,
        tm.tm_sec,
        now.subsec_millis()
    )
}

// Watchdog of the main thread, where the window and the synchronous commands
// run: every second a no-op is posted there. Not run within 2 s: one line
// "main fermo", then one "main ripartito" when it runs (one pair per episode).
// Past 5 s, `stalled` gets the ms too (the UI offers to export the log).
// It ends when `post` drops the no-op instead of running it (app exiting).
pub fn watchdog(post: impl Fn(Box<dyn FnOnce() + Send>), stalled: impl Fn(u128)) {
    use std::sync::mpsc::{channel, RecvTimeoutError};
    use std::time::{Duration, Instant};
    loop {
        let (tx, rx) = channel();
        let sent = Instant::now();
        post(Box::new(move || {
            let _ = tx.send(());
        }));
        match rx.recv_timeout(Duration::from_secs(2)) {
            Ok(()) => {}
            Err(RecvTimeoutError::Disconnected) => return,
            Err(RecvTimeoutError::Timeout) => {
                log(Level::Warn, "main", "main fermo da 2 s");
                if rx.recv().is_err() {
                    return;
                }
                let ms = sent.elapsed().as_millis();
                log(Level::Warn, "main", format!("main ripartito dopo {ms} ms"));
                if ms > 5000 {
                    stalled(ms);
                }
            }
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_line_has_time_level_area_and_indented_continuation() {
        assert_eq!(
            line(
                "2026-09-30 14:03:12.345",
                Level::Warn,
                "git",
                "pull: exit 1\nfatal: no\n"
            ),
            "2026-09-30 14:03:12.345 WARN  git      pull: exit 1\n    fatal: no\n"
        );
        assert_eq!(line("t", Level::Error, "ui", "x"), "t ERROR ui       x\n");
    }

    #[test]
    fn the_local_time_has_milliseconds() {
        let t = now_local();
        assert_eq!(t.len(), "2026-09-30 14:03:12.345".len(), "{t}");
        assert_eq!(&t[4..5], "-");
        assert_eq!(&t[19..20], ".");
    }

    #[test]
    fn debug_is_logged_only_with_work_debug() {
        assert!(!wanted(Level::Debug, false));
        assert!(wanted(Level::Debug, true));
        assert!(wanted(Level::Info, false));
        assert!(wanted(Level::Warn, false));
    }

    #[test]
    fn a_stalled_main_thread_logs_one_pair_of_lines() {
        use std::sync::atomic::{AtomicU32, Ordering};
        let calls = AtomicU32::new(0);
        let stalled = Mutex::new(vec![]);
        watchdog(
            |noop| match calls.fetch_add(1, Ordering::SeqCst) {
                // The first no-op runs 3 s late, as behind a blocked main thread.
                0 => drop(std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(3000));
                    noop()
                })),
                1 => noop(),
                _ => drop(noop), // the app exits
            },
            |ms| stalled.lock().unwrap().push(ms),
        );
        let logged = CAPTURED.lock().unwrap().join("");
        let main: Vec<&str> = logged
            .lines()
            .filter(|l| l.contains(" main     "))
            .collect();
        assert_eq!(main.len(), 2, "{logged}");
        assert!(
            main[0].ends_with("WARN  main     main fermo da 2 s"),
            "{}",
            main[0]
        );
        assert!(main[1].contains("main ripartito dopo 3"), "{}", main[1]);
        assert!(
            stalled.lock().unwrap().is_empty(),
            "3 s is under the 5 s of the toast"
        );
    }

    #[test]
    fn a_log_over_5_mb_becomes_work_log_1_at_start() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("work.log");
        std::fs::write(&file, vec![b'x'; MAX as usize + 1]).unwrap();
        rotate(&file);
        assert!(!file.exists());
        assert_eq!(
            std::fs::metadata(dir.path().join("work.log.1"))
                .unwrap()
                .len(),
            MAX + 1
        );

        std::fs::write(&file, "piccolo").unwrap();
        rotate(&file);
        assert!(file.exists(), "a small log stays where it is");
    }
}

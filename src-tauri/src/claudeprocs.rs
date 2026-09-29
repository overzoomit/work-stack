// Live Claude Code processes. Claude Code writes ~/.claude/sessions/<pid>.json
// while it runs ({ pid, sessionId, procStart, ... }) and removes it on exit:
// the only reliable way to tell a session that is still open from one whose
// transcript simply hasn't been written for a while.
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::thread::sleep;
use std::time::Duration;

pub fn sessions_dir() -> PathBuf {
    match std::env::var_os("WORK_CLAUDE_SESSIONS") {
        Some(d) => PathBuf::from(d),
        None => PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".claude/sessions"),
    }
}

// Start time of a process in clock ticks since boot (field 22 of
// /proc/<pid>/stat), as Claude Code records it in procStart.
#[cfg(target_os = "linux")]
pub fn proc_start(pid: i32) -> Option<String> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let rest = stat.get(stat.rfind(')')? + 2..)?;
    rest.split(' ').nth(19).map(str::to_string)
}

// On macOS Claude Code records `LC_ALL=C TZ=UTC ps -o lstart=`
// ("Tue Sep 29 12:24:21 2026"): rebuilt from the kernel's start time.
#[cfg(target_os = "macos")]
pub fn proc_start(pid: i32) -> Option<String> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
    // SAFETY: the buffer is a proc_bsdinfo of the size passed.
    let n = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), size) };
    (n == size).then(|| lstart(info.pbi_start_tvsec as i64))
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn proc_start(_pid: i32) -> Option<String> {
    None
}

// ps's lstart in the C locale and UTC: "%a %b %e %H:%M:%S %Y".
#[cfg(target_os = "macos")]
fn lstart(secs: i64) -> String {
    const DAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let (days, t) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{} {} {:>2} {:02}:{:02}:{:02} {}", DAYS[days.rem_euclid(7) as usize], MONTHS[m as usize - 1], d, t / 3600, t / 60 % 60, t % 60, y)
}

#[derive(Debug, Clone)]
pub struct Entry {
    pub pid: i32,
    pub proc_start: Option<String>,
}

// Alive, and still the same process: a pid can be reused after Claude exits
// without removing its file (crash, kill -9).
fn alive(e: &Entry) -> bool {
    // SAFETY: signal 0 only checks that the pid exists.
    if unsafe { libc::kill(e.pid, 0) } != 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::EPERM) {
        return false;
    }
    match (&e.proc_start, proc_start(e.pid)) {
        // Compared word by word: lstart pads one-digit days with a space.
        (Some(rec), Some(now)) => rec.split_whitespace().eq(now.split_whitespace()),
        _ => true,
    }
}

// false when this Claude Code version doesn't keep the folder: then nothing
// can be said about which sessions are open.
pub fn tracked(dir: &Path) -> bool {
    dir.is_dir()
}

// String(procStart) when truthy, as the JS compared it.
fn recorded_start(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::Null | Value::Bool(false) => None,
        Value::String(s) if s.is_empty() => None,
        Value::String(s) => Some(s.clone()),
        Value::Number(n) if n.as_f64() == Some(0.0) => None,
        v => Some(v.to_string()),
    }
}

fn parse(name: &str, text: &str) -> Option<(String, Entry)> {
    let stem = name.strip_suffix(".json")?;
    if stem.is_empty() || !stem.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let v: Value = serde_json::from_str(text).ok()?; // being written or removed right now
    let pid = v.get("pid")?.as_f64()?;
    if pid.fract() != 0.0 || pid <= 1.0 || pid > i32::MAX as f64 {
        return None;
    }
    let pid = pid as i32;
    let sid = v.get("sessionId")?.as_str()?;
    if pid.to_string() != stem {
        return None; // the file name is the pid
    }
    Some((sid.to_string(), Entry { pid, proc_start: recorded_start(v.get("procStart")) }))
}

// sessionId -> entry for every Claude Code process still running.
pub fn live(dir: &Path) -> HashMap<String, Entry> {
    let mut map = HashMap::new();
    let Ok(rd) = fs::read_dir(dir) else { return map };
    for f in rd.flatten() {
        let name = f.file_name();
        let Some(name) = name.to_str() else { continue };
        let Ok(text) = fs::read_to_string(f.path()) else { continue };
        if let Some((sid, e)) = parse(name, &text) {
            if alive(&e) {
                map.insert(sid, e);
            }
        }
    }
    map
}

// Close a session's Claude Code process: SIGTERM lets it exit cleanly (the
// transcript stays resumable); if it's still there after `grace` ms, SIGKILL.
// Blocking: callers run it off the main thread.
pub fn stop(dir: &Path, session_id: &str, grace: u64) -> Result<(), String> {
    let Some(e) = live(dir).remove(session_id) else {
        return Err("La sessione non è più aperta".into());
    };
    // SAFETY: plain signal to a pid read from Claude Code's own record.
    if unsafe { libc::kill(e.pid, libc::SIGTERM) } != 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let mut t = 0;
    while t < grace {
        sleep(Duration::from_millis(100));
        if !alive(&e) {
            return Ok(());
        }
        t += 100;
    }
    // Errors ignored: it may have exited between the last check and now.
    unsafe { libc::kill(e.pid, libc::SIGKILL) };
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::os::unix::process::ExitStatusExt;
    use std::process::{Child, Command, Stdio};

    const SID: &str = "11111111-2222-3333-4444-555555555555";

    // Stands in for Claude Code; killed on drop, even when an assertion fails.
    struct Fake(Child);
    impl Drop for Fake {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    impl Fake {
        fn pid(&self) -> i32 {
            self.0.id() as i32
        }
        // The signal that ended it.
        fn exited(&mut self) -> Option<i32> {
            self.0.wait().unwrap().signal()
        }
    }

    // "up" once the TERM disposition is set: `exec` keeps an ignored signal ignored.
    fn fake_claude(ignore_term: bool) -> Fake {
        let trap = if ignore_term { "trap '' TERM; " } else { "" };
        let mut c = Command::new("/bin/sh")
            .args(["-c", &format!("{trap}echo up; exec sleep 60")])
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut line = String::new();
        BufReader::new(c.stdout.take().unwrap()).read_line(&mut line).unwrap();
        Fake(c)
    }

    fn record(dir: &Path, pid: i32, fields: Value) {
        let mut v = fields;
        v["pid"] = pid.into();
        fs::write(dir.join(format!("{pid}.json")), v.to_string()).unwrap();
    }

    fn start_of(pid: i32) -> Value {
        proc_start(pid).map_or(Value::Null, Value::String)
    }

    #[test]
    fn open_sessions_are_those_with_the_same_live_process() {
        let d = tempfile::tempdir().unwrap();
        let c = fake_claude(false);
        record(d.path(), c.pid(), serde_json::json!({ "sessionId": SID, "procStart": start_of(c.pid()) }));
        record(d.path(), 999999, serde_json::json!({ "sessionId": "morto" })); // process gone
        let reused = fake_claude(false);
        record(d.path(), reused.pid(), serde_json::json!({ "sessionId": "pid-riusato", "procStart": "1" })); // same pid, another process
        fs::write(d.path().join("12.json"), serde_json::json!({ "pid": c.pid(), "sessionId": "nome-sbagliato" }).to_string()).unwrap();
        fs::write(d.path().join("13.json"), "{ non json").unwrap();
        let live = live(d.path());
        assert!(tracked(d.path()));
        assert_eq!(live.keys().collect::<Vec<_>>(), [SID]);
        assert_eq!(live[SID].pid, c.pid());
    }

    #[test]
    fn stopping_a_session_sends_sigterm() {
        let d = tempfile::tempdir().unwrap();
        let mut c = fake_claude(false);
        let id = "aaaaaaaa-0000-0000-0000-000000000001";
        record(d.path(), c.pid(), serde_json::json!({ "sessionId": id, "procStart": start_of(c.pid()) }));
        stop(d.path(), id, 3000).unwrap();
        assert_eq!(c.exited(), Some(libc::SIGTERM));
    }

    #[test]
    fn a_process_ignoring_sigterm_gets_sigkill_after_the_grace() {
        let d = tempfile::tempdir().unwrap();
        let mut c = fake_claude(true);
        let id = "aaaaaaaa-0000-0000-0000-000000000002";
        record(d.path(), c.pid(), serde_json::json!({ "sessionId": id, "procStart": start_of(c.pid()) }));
        stop(d.path(), id, 300).unwrap();
        assert_eq!(c.exited(), Some(libc::SIGKILL));
    }

    #[test]
    fn stopping_a_session_not_open_is_a_clear_error_and_signals_nothing() {
        let d = tempfile::tempdir().unwrap();
        let reused = fake_claude(false);
        record(d.path(), reused.pid(), serde_json::json!({ "sessionId": "pid-riusato", "procStart": "1" }));
        assert_eq!(stop(d.path(), "non-esiste", 3000), Err("La sessione non è più aperta".into()));
        // A reused pid is never signalled.
        assert_eq!(stop(d.path(), "pid-riusato", 3000), Err("La sessione non è più aperta".into()));
        assert!(unsafe { libc::kill(reused.pid(), 0) } == 0, "still running");
    }

    #[test]
    fn the_start_time_is_known_for_a_live_process() {
        let c = fake_claude(false);
        assert!(proc_start(c.pid()).is_some());
        assert_ne!(proc_start(c.pid()), Some("1".into()));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn lstart_matches_ps_in_utc() {
        assert_eq!(lstart(1790684661), "Tue Sep 29 12:24:21 2026");
        assert_eq!(lstart(0), "Thu Jan  1 00:00:00 1970");
        assert_eq!(lstart(951782400), "Tue Feb 29 00:00:00 2000");
    }
}

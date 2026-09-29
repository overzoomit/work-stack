// PtyManager: one shell per terminal, in a pseudo-terminal opened by
// portable-pty. Output is coalesced into few messages and paused while the
// renderer is far behind (flow control through `ack`).
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Deserialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{sync_channel, Receiver};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

const FLUSH_MS: u64 = 8;
const FLUSH_SIZE: usize = 16 * 1024; // larger chunks make xterm block the UI longer per write
// Counted in UTF-16 units, like the string lengths the renderer acknowledges.
const HIGH_WATER: usize = 1024 * 1024;
const LOW_WATER: usize = 256 * 1024;
// After the shell exits, output still in flight is collected until the pty is
// quiet this long: a background job may keep it open (and writing) forever.
const DRAIN_MS: u64 = 30;

pub type OnData = Arc<dyn Fn(u32, String) + Send + Sync>;
pub type OnExit = Arc<dyn Fn(u32, i32) + Send + Sync>;

#[derive(Deserialize)]
pub struct CreateOpts {
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
    pub command: Option<String>,
}

#[derive(Default)]
struct Flow {
    unacked: usize,
    paused: bool,
    killed: bool,
}

struct Session {
    master: Mutex<Box<dyn MasterPty + Send>>,
    // Keys go through one thread per terminal, in order, so a program that
    // stops reading its input never blocks the caller.
    input: Mutex<std::sync::mpsc::Sender<Vec<u8>>>,
    pid: i32,
    cwd: PathBuf,
    flow: Mutex<Flow>,
    resume: Condvar,
}

enum Msg {
    Data(Vec<u8>),
    Exit(i32),
}

pub struct PtyManager {
    shell: String,
    sessions: Arc<Mutex<HashMap<u32, Arc<Session>>>>,
    next_id: AtomicU32,
    on_data: OnData,
    on_exit: OnExit,
}

// The user's environment, minus what `npm run dev` adds to Work's own process:
// npm_* variables (nvm refuses to run with them), INIT_CWD, NODE, COLOR,
// EDITOR (npm defaults it to vi: git would open vi instead of the system
// editor; a profile that exports it sets it again in the login shell), and the
// node_modules/.bin folders npm puts in front of PATH, which would make Work's
// own dependencies shadow the user's commands.
pub fn shell_env(vars: impl Iterator<Item = (String, String)>) -> Vec<(String, String)> {
    let vars: Vec<_> = vars.collect();
    if !vars.iter().any(|(k, _)| k == "npm_lifecycle_event") {
        return vars;
    }
    vars.into_iter()
        .filter(|(k, _)| !k.to_ascii_lowercase().starts_with("npm_") && !["INIT_CWD", "NODE", "COLOR", "EDITOR"].contains(&k.as_str()))
        .map(|(k, v)| {
            if k != "PATH" {
                return (k, v);
            }
            let path = v.split(':').filter(|d| !d.ends_with("/node_modules/.bin") && !d.ends_with("node-gyp-bin")).collect::<Vec<_>>().join(":");
            (k, path)
        })
        .collect()
}

// Takes the longest valid UTF-8 prefix of `pending`, keeping a character cut
// at the end of a read for the next one (decoding each read on its own would
// turn it into U+FFFD). Bytes that can never be valid become U+FFFD.
pub fn decode(pending: &mut Vec<u8>) -> String {
    let mut out = String::new();
    let mut rest: &[u8] = pending;
    loop {
        match std::str::from_utf8(rest) {
            Ok(s) => {
                out.push_str(s);
                rest = &[];
                break;
            }
            Err(e) => {
                let (valid, after) = rest.split_at(e.valid_up_to());
                out.push_str(std::str::from_utf8(valid).unwrap());
                match e.error_len() {
                    Some(n) => {
                        out.push('\u{FFFD}');
                        rest = &after[n..];
                    }
                    None => {
                        rest = after; // incomplete character: wait for its other bytes
                        break;
                    }
                }
            }
        }
    }
    *pending = rest.to_vec();
    out
}

// Shell convention: the exit status, or 128 + signal when killed.
fn exit_code(status: libc::c_int) -> i32 {
    if libc::WIFSIGNALED(status) {
        128 + libc::WTERMSIG(status)
    } else {
        libc::WEXITSTATUS(status)
    }
}

// The user's shell: $SHELL, else the account's login shell (an app started
// from Finder or a desktop launcher may have no $SHELL), else the OS default.
pub fn user_shell() -> String {
    if let Some(sh) = std::env::var("SHELL").ok().filter(|s| !s.is_empty()) {
        return sh;
    }
    let pw = unsafe { libc::getpwuid(libc::getuid()) };
    if !pw.is_null() {
        let sh = unsafe { std::ffi::CStr::from_ptr((*pw).pw_shell) }.to_string_lossy().into_owned();
        if !sh.is_empty() {
            return sh;
        }
    }
    if cfg!(target_os = "macos") { "/bin/zsh" } else { "/bin/bash" }.into()
}

fn home() -> PathBuf {
    std::env::var("HOME").map(PathBuf::from).unwrap_or_else(|_| "/".into())
}

impl PtyManager {
    pub fn new(on_data: OnData, on_exit: OnExit) -> Self {
        Self { shell: user_shell(), sessions: Default::default(), next_id: AtomicU32::new(1), on_data, on_exit }
    }

    pub fn create(&self, opts: CreateOpts) -> u32 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        if self.spawn(id, &opts).is_err() {
            // The shell could not start (missing, not executable): the terminal
            // ends like a shell that exits with 127. Reported a moment later, so
            // the renderer knows the id before its end arrives.
            let on_exit = self.on_exit.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(100));
                on_exit(id, 127);
            });
        }
        id
    }

    fn spawn(&self, id: u32, opts: &CreateOpts) -> Result<(), Box<dyn std::error::Error>> {
        let mut cmd = CommandBuilder::new(&self.shell);
        match &opts.command {
            Some(c) => cmd.args(["-lc", c]),
            None => cmd.arg("-l"),
        }
        // A folder deleted since (a removed worktree…) would make the spawn fail: open in home.
        let cwd = opts.cwd.as_deref().map(PathBuf::from).filter(|d| d.is_dir()).unwrap_or_else(home);
        cmd.cwd(&cwd);
        cmd.env_clear();
        for (k, v) in shell_env(std::env::vars()) {
            cmd.env(k, v);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "Work");

        let pair = native_pty_system().openpty(PtySize { rows: opts.rows, cols: opts.cols, pixel_width: 0, pixel_height: 0 })?;
        let child = pair.slave.spawn_command(cmd)?;
        drop(pair.slave); // only the shell holds the terminal: its end closes it
        let pid = child.process_id().ok_or("no pid")? as i32;
        let mut reader = pair.master.try_clone_reader()?;
        let mut writer = pair.master.take_writer()?;
        let (input, keys) = std::sync::mpsc::channel::<Vec<u8>>();
        std::thread::spawn(move || {
            // Keys sent while the shell exits hit a closed terminal: harmless, the exit follows.
            while let Ok(bytes) = keys.recv() {
                if writer.write_all(&bytes).is_err() {
                    break;
                }
            }
        });

        let session = Arc::new(Session {
            master: Mutex::new(pair.master),
            input: Mutex::new(input),
            pid,
            cwd,
            flow: Default::default(),
            resume: Condvar::new(),
        });
        self.sessions.lock().unwrap().insert(id, session.clone());

        // A small bound: while the pump is paused the reader blocks, the pty
        // buffer fills up and the program writing to it waits.
        let (tx, rx) = sync_channel::<Msg>(4);
        let data_tx = tx.clone();
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 64 * 1024];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 || data_tx.send(Msg::Data(buf[..n].to_vec())).is_err() {
                    break;
                }
            }
        });
        // The shell's end is reported even when a background job it left
        // behind keeps the pty open (the reader then never sees EOF).
        std::thread::spawn(move || {
            let _child = child; // reaped here, with waitpid, to read the raw status
            let mut status = 0;
            let code = if unsafe { libc::waitpid(pid, &mut status, 0) } == pid { exit_code(status) } else { 1 };
            let _ = tx.send(Msg::Exit(code));
        });

        let (sessions, on_data, on_exit) = (self.sessions.clone(), self.on_data.clone(), self.on_exit.clone());
        std::thread::spawn(move || {
            let code = pump(id, &session, rx, &on_data).unwrap_or(1);
            sessions.lock().unwrap().remove(&id);
            on_exit(id, code);
        });
        Ok(())
    }

    // The renderer confirms how much output xterm has processed.
    pub fn ack(&self, id: u32, chars: usize) {
        let Some(s) = self.get(id) else { return };
        let mut f = s.flow.lock().unwrap();
        f.unacked = f.unacked.saturating_sub(chars);
        if f.unacked < LOW_WATER {
            s.resume.notify_all();
        }
    }

    pub fn write(&self, id: u32, data: &str) {
        if let Some(s) = self.get(id) {
            let _ = s.input.lock().unwrap().send(data.as_bytes().to_vec());
        }
    }

    pub fn resize(&self, id: u32, cols: u16, rows: u16) {
        if let Some(s) = self.get(id) {
            let _ = s.master.lock().unwrap().resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
        }
    }

    // Hang up the shell like a closed terminal window. A session paused by
    // flow control is let go: nobody will ack any more.
    pub fn kill(&self, id: u32) {
        let Some(s) = self.get(id) else { return };
        s.flow.lock().unwrap().killed = true;
        s.resume.notify_all();
        unsafe { libc::killpg(s.pid, libc::SIGHUP) }; // the shell leads its own session and process group
    }

    pub fn kill_all(&self) {
        let ids: Vec<u32> = self.sessions.lock().unwrap().keys().copied().collect();
        ids.into_iter().for_each(|id| self.kill(id));
    }

    // Current working directory of the shell; the session's start folder if it can't be read.
    pub fn cwd(&self, id: u32) -> Option<String> {
        let s = self.get(id)?;
        Some(process_cwd(s.pid).unwrap_or_else(|| s.cwd.clone()).to_string_lossy().into_owned())
    }

    #[cfg(test)]
    fn is_paused(&self, id: u32) -> bool {
        self.get(id).is_some_and(|s| s.flow.lock().unwrap().paused)
    }

    fn get(&self, id: u32) -> Option<Arc<Session>> {
        self.sessions.lock().unwrap().get(&id).cloned()
    }
}

// Coalesces output into one message every few ms (a busy command prints
// thousands of small chunks), flushed right away past FLUSH_SIZE, and stops
// reading while the renderer is more than HIGH_WATER behind.
fn pump(id: u32, s: &Session, rx: Receiver<Msg>, on_data: &OnData) -> Option<i32> {
    let mut pending = Vec::new();
    let mut text = String::new();
    let mut exit = None;
    let mut take = |msg: Msg, text: &mut String, exit: &mut Option<i32>| match msg {
        Msg::Data(bytes) => {
            pending.extend_from_slice(&bytes);
            text.push_str(&decode(&mut pending));
        }
        Msg::Exit(code) => *exit = Some(code),
    };
    while exit.is_none() {
        let Ok(msg) = rx.recv() else { break };
        take(msg, &mut text, &mut exit);
        let deadline = Instant::now() + Duration::from_millis(FLUSH_MS);
        while exit.is_none() && text.len() < FLUSH_SIZE {
            match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(msg) => take(msg, &mut text, &mut exit),
                Err(_) => break,
            }
        }
        if exit.is_some() {
            // Relay what the shell wrote before exiting, without waiting for EOF.
            while let Ok(msg) = rx.recv_timeout(Duration::from_millis(DRAIN_MS)) {
                take(msg, &mut text, &mut exit);
            }
        }
        if text.is_empty() {
            continue;
        }
        let chunk = std::mem::take(&mut text);
        let mut f = s.flow.lock().unwrap();
        f.unacked += chunk.encode_utf16().count();
        drop(f);
        on_data(id, chunk);
        let mut f = s.flow.lock().unwrap();
        if exit.is_none() && f.unacked > HIGH_WATER && !f.killed {
            f.paused = true;
            while f.unacked >= LOW_WATER && !f.killed {
                f = s.resume.wait(f).unwrap();
            }
            f.paused = false;
        }
    }
    exit
}

// ── Tauri commands ───────────────────────────────────────────
// Output and exits share one channel, so a pane's last words always arrive
// before its end: [id, text] or [id, null, code].
pub struct PtyState {
    pub mgr: PtyManager,
    pub channel: Arc<Mutex<Option<tauri::ipc::Channel<serde_json::Value>>>>,
}

impl PtyState {
    pub fn new() -> Self {
        let channel: Arc<Mutex<Option<tauri::ipc::Channel<serde_json::Value>>>> = Default::default();
        let (data, exit) = (channel.clone(), channel.clone());
        let send = |slot: &Mutex<Option<tauri::ipc::Channel<serde_json::Value>>>, msg| {
            if let Some(c) = slot.lock().unwrap().as_ref() {
                let _ = c.send(msg);
            }
        };
        let mgr = PtyManager::new(
            Arc::new(move |id, text| send(&data, serde_json::json!([id, text]))),
            Arc::new(move |id, code| send(&exit, serde_json::json!([id, null, code]))),
        );
        Self { mgr, channel }
    }
}

#[tauri::command]
pub fn pty_subscribe(s: tauri::State<PtyState>, channel: tauri::ipc::Channel<serde_json::Value>) {
    *s.channel.lock().unwrap() = Some(channel);
}

#[tauri::command(async)]
pub fn pty_create(s: tauri::State<PtyState>, opts: CreateOpts) -> u32 {
    s.mgr.create(opts)
}

#[tauri::command]
pub fn pty_write(s: tauri::State<PtyState>, id: u32, data: String) {
    s.mgr.write(id, &data)
}

#[tauri::command]
pub fn pty_ack(s: tauri::State<PtyState>, id: u32, chars: usize) {
    s.mgr.ack(id, chars)
}

#[tauri::command]
pub fn pty_resize(s: tauri::State<PtyState>, id: u32, cols: u16, rows: u16) {
    s.mgr.resize(id, cols, rows)
}

#[tauri::command]
pub fn pty_kill(s: tauri::State<PtyState>, id: u32) {
    s.mgr.kill(id)
}

#[tauri::command(async)]
pub fn pty_cwd(s: tauri::State<PtyState>, id: u32) -> Option<String> {
    s.mgr.cwd(id)
}

#[cfg(target_os = "linux")]
fn process_cwd(pid: i32) -> Option<PathBuf> {
    std::fs::read_link(format!("/proc/{pid}/cwd")).ok()
}

#[cfg(target_os = "macos")]
fn process_cwd(pid: i32) -> Option<PathBuf> {
    use std::ffi::CStr;
    let mut info: libc::proc_vnodepathinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as libc::c_int;
    let n = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDVNODEPATHINFO, 0, &mut info as *mut _ as *mut libc::c_void, size) };
    if n != size {
        return None;
    }
    let path = unsafe { CStr::from_ptr(info.pvi_cdir.vip_path.as_ptr() as *const libc::c_char) };
    Some(PathBuf::from(path.to_str().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::{channel, Sender};

    enum Ev {
        Data(u32, String),
        Exit(u32, i32),
    }

    fn manager() -> (Arc<PtyManager>, Receiver<Ev>) {
        let (tx, rx) = channel::<Ev>();
        let (d, e): (Sender<Ev>, Sender<Ev>) = (tx.clone(), tx);
        let d = Mutex::new(d);
        let e = Mutex::new(e);
        let m = PtyManager::new(
            Arc::new(move |id, s| {
                let _ = d.lock().unwrap().send(Ev::Data(id, s));
            }),
            Arc::new(move |id, c| {
                let _ = e.lock().unwrap().send(Ev::Exit(id, c));
            }),
        );
        (Arc::new(m), rx)
    }

    fn opts(command: &str) -> CreateOpts {
        CreateOpts { cwd: Some("/tmp".into()), cols: 80, rows: 24, command: Some(command.into()) }
    }

    // Output and exit code of a command, acknowledging everything it prints.
    fn run(command: &str) -> (String, i32) {
        run_in(None, command)
    }

    fn run_in(shell: Option<&str>, command: &str) -> (String, i32) {
        let (m, rx) = manager();
        let mut m = Arc::try_unwrap(m).ok().unwrap();
        if let Some(sh) = shell {
            m.shell = sh.into();
        }
        m.create(opts(command));
        let mut out = String::new();
        loop {
            match rx.recv_timeout(Duration::from_secs(10)).expect("the command ends") {
                Ev::Data(id, s) => {
                    m.ack(id, s.encode_utf16().count());
                    out += &s;
                }
                Ev::Exit(_, code) => return (out, code),
            }
        }
    }

    #[test]
    fn decode_keeps_a_character_split_across_reads() {
        let bytes = "è─✓".as_bytes();
        let mut pending = Vec::new();
        let mut out = String::new();
        for b in bytes {
            pending.push(*b);
            out += &decode(&mut pending);
        }
        assert_eq!(out, "è─✓");
        let mut bad = vec![b'a', 0xff, b'b'];
        assert_eq!(decode(&mut bad), "a\u{FFFD}b");
    }

    #[test]
    fn multi_byte_characters_split_between_writes_arrive_intact() {
        // "è─✓" one byte at a time: every multi-byte character is split across writes.
        let script = r"for b in '\303' '\250' '\342' '\224' '\200' '\342' '\234' '\223'; do printf $b; sleep 0.02; done";
        assert_eq!(run(script).0.trim(), "è─✓");
    }

    #[test]
    fn exit_code_is_reported() {
        assert_eq!(run("exit 3").1, 3);
        assert_eq!(run("kill -TERM $$").1, 128 + 15, "killed by a signal: shell convention");
    }

    #[test]
    fn terminal_has_the_requested_size_and_is_an_xterm() {
        assert_eq!(run("stty size").0.trim(), "24 80");
        assert_eq!(run("echo \"$TERM $COLORTERM\"").0.trim(), "xterm-256color truecolor");
    }

    #[test]
    fn cwd_reads_the_shell_folder() {
        let (m, _rx) = manager();
        let dir = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        let id = m.create(CreateOpts { cwd: Some(dir.to_string_lossy().into()), cols: 80, rows: 24, command: None });
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(m.cwd(id).map(PathBuf::from), Some(dir));
        m.kill_all();
    }

    #[test]
    fn output_is_coalesced_into_few_messages() {
        let (m, rx) = manager();
        m.create(opts("seq 1 200000"));
        let (mut messages, mut out) = (0, String::new());
        while let Ev::Data(id, s) = rx.recv_timeout(Duration::from_secs(10)).unwrap() {
            messages += 1;
            m.ack(id, s.encode_utf16().count());
            out += &s;
        }
        assert!(out.contains("200000"));
        assert!(messages < 200, "messaggi: {messages}");
    }

    #[test]
    fn without_acks_the_shell_is_paused_and_with_them_it_ends() {
        let (m, rx) = manager();
        let id = m.create(opts("seq 1 2000000"));
        std::thread::sleep(Duration::from_millis(1500));
        let mut received = 0;
        while let Ok(ev) = rx.try_recv() {
            match ev {
                Ev::Data(_, s) => received += s.len(),
                Ev::Exit(..) => panic!("~14 MB in total: it must stop a little past the 1 MB high-water mark"),
            }
        }
        assert!(received < 2 * 1024 * 1024, "ricevuti {received}");
        assert!(m.is_paused(id));
        loop {
            m.ack(id, usize::MAX);
            if let Ev::Exit(..) = rx.recv_timeout(Duration::from_secs(10)).unwrap() {
                break;
            }
        }
    }

    #[test]
    fn killing_a_paused_session_still_ends_it() {
        let (m, rx) = manager();
        let id = m.create(opts("seq 1 5000000"));
        std::thread::sleep(Duration::from_millis(1000));
        assert!(m.is_paused(id), "nobody acked: the shell is paused");
        m.kill(id);
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())).expect("the session ends") {
                Ev::Exit(..) => break,
                Ev::Data(..) => {}
            }
        }
    }

    #[test]
    fn write_sends_input_and_resize_changes_the_size_programs_see() {
        let (m, rx) = manager();
        let id = m.create(opts("read line; echo \"got:$line\"; sleep 0.3; stty size"));
        std::thread::sleep(Duration::from_millis(300));
        m.resize(id, 100, 30);
        m.write(id, "ciao\r");
        let mut out = String::new();
        while let Ev::Data(id, s) = rx.recv_timeout(Duration::from_secs(10)).unwrap() {
            m.ack(id, s.len());
            out += &s;
        }
        assert!(out.contains("got:ciao"), "{out}");
        assert!(out.contains("30 100"), "{out}");
    }

    #[test]
    fn shells_do_not_inherit_what_npm_adds_regression() {
        let vars = [
            ("npm_lifecycle_event", "start"),
            ("npm_config_prefix", "/tmp/prefisso"),
            ("INIT_CWD", "/tmp/work-app"),
            ("NODE", "/tmp/node"),
            ("EDITOR", "vi"),
            ("COLOR", "0"),
            ("HOME", "/Users/x"),
            ("PATH", "/tmp/work-app/node_modules/.bin:/tmp/node_modules/.bin:/x/@npmcli/run-script/lib/node-gyp-bin:/usr/bin:/bin"),
        ];
        let env = shell_env(vars.iter().map(|(k, v)| (k.to_string(), v.to_string())));
        let keys: Vec<&str> = env.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, ["HOME", "PATH"]);
        assert_eq!(env[1].1, "/usr/bin:/bin");
        // Not started by npm: nothing is touched.
        let plain = shell_env([("EDITOR".to_string(), "vi".to_string())].into_iter());
        assert_eq!(plain, [("EDITOR".to_string(), "vi".to_string())]);
    }

    #[test]
    fn a_folder_that_no_longer_exists_opens_in_home_regression() {
        let (m, rx) = manager();
        m.create(CreateOpts { cwd: Some("/cartella/che/non/esiste".into()), cols: 80, rows: 24, command: Some("pwd".into()) });
        let mut out = String::new();
        let code = loop {
            match rx.recv_timeout(Duration::from_secs(10)).unwrap() {
                Ev::Data(_, s) => out += &s,
                Ev::Exit(_, c) => break c,
            }
        };
        assert_eq!(code, 0);
        assert_eq!(PathBuf::from(out.trim()), std::fs::canonicalize(home()).unwrap());
    }

    #[test]
    fn keys_and_resizes_sent_while_the_shell_exits_do_not_crash_regression() {
        let (m, rx) = manager();
        let ids: Vec<u32> = (0..20).map(|_| m.create(opts("exit 0"))).collect();
        let spam = {
            let m = m.clone();
            let ids = ids.clone();
            std::thread::spawn(move || {
                for _ in 0..200 {
                    for &id in &ids {
                        m.write(id, &"x".repeat(1000));
                        m.resize(id, 80, 24);
                    }
                }
            })
        };
        let mut exited = 0;
        while exited < ids.len() {
            if let Ev::Exit(..) = rx.recv_timeout(Duration::from_secs(10)).unwrap() {
                exited += 1;
            }
        }
        spam.join().unwrap();
    }

    #[test]
    fn a_shell_that_cannot_start_ends_with_127() {
        let (m, rx) = manager();
        let mut m = Arc::try_unwrap(m).ok().unwrap();
        m.shell = "/percorso/vuoto/shell".into();
        let id = m.create(opts("true"));
        match rx.recv_timeout(Duration::from_secs(5)).unwrap() {
            Ev::Exit(i, code) => assert_eq!((i, code), (id, 127)),
            Ev::Data(..) => panic!("no output from a shell that never started"),
        }
    }

    #[test]
    fn the_end_is_reported_at_once_even_if_a_background_job_keeps_the_terminal_open_regression() {
        // With job control the background sleep survives the shell and keeps the
        // terminal open: the reader sees no EOF until it ends. bash: zsh won't
        // exit with a stopped-job warning pending the same way.
        let started = Instant::now();
        let (out, code) = run_in(Some("/bin/bash"), "set -m; sleep 6 & echo avviato; exit 4");
        let elapsed = started.elapsed();
        let _ = std::process::Command::new("pkill").args(["-f", "^sleep 6$"]).status();
        assert!(out.contains("avviato"), "output written before the exit is not lost");
        assert_eq!(code, 4);
        assert!(elapsed < Duration::from_secs(3), "exit reported after {elapsed:?}");
    }
}

// File-system operations for the Project tree. Every path must live inside
// one of the open projects, so the renderer can't touch anything else.
use serde::Serialize;
use serde_json::{json, Value};
use std::cmp::Ordering;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::RwLock;
use tauri::State;
use tauri_plugin_opener::OpenerExt;

// Real paths of the open projects.
#[derive(Default)]
pub struct Roots(pub RwLock<Vec<PathBuf>>);

impl Roots {
    pub fn set(&self, list: &[String]) {
        let real = list.iter().map(|p| resolve(Path::new(p))).map(|p| fs::canonicalize(&p).unwrap_or(p)).collect();
        *self.0.write().unwrap() = real;
    }

    fn get(&self) -> Vec<PathBuf> {
        self.0.read().unwrap().clone()
    }
}

// Like Node's path.resolve: absolute and without "." / "..", lexically.
fn resolve(p: &Path) -> PathBuf {
    let mut out = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            c => out.push(c),
        }
    }
    out
}

fn base(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

fn err(e: std::io::Error) -> String {
    e.to_string()
}

// Real path of `p` even if its last parts don't exist yet: resolve the
// deepest existing ancestor and append the rest.
fn real_of(p: &Path) -> PathBuf {
    let mut cur = p;
    let mut tail = vec![];
    loop {
        if let Ok(real) = fs::canonicalize(cur) {
            return tail.iter().rev().fold(real, |acc, n| acc.join(n));
        }
        match (cur.parent(), cur.file_name()) {
            (Some(up), Some(name)) => {
                tail.push(name);
                cur = up;
            }
            _ => return p.to_path_buf(),
        }
    }
}

// Path::starts_with compares whole components, like `real.startsWith(r + sep)`.
fn inside(roots: &[PathBuf], real: &Path) -> bool {
    roots.iter().any(|r| real.starts_with(r))
}

// Checks a path against the open projects using real paths, so a symlink
// inside a project can't be used to reach files outside it.
//  follow: true  → the operation follows the link (read, list, open): check its target
//  follow: false → the operation acts on the entry itself (rename, move, trash): check its folder
fn guard(roots: &[PathBuf], p: &Path, follow: bool) -> Result<PathBuf, String> {
    let abs = resolve(p);
    let real = match (follow, abs.parent(), abs.file_name()) {
        (false, Some(dir), Some(name)) => real_of(dir).join(name),
        _ => real_of(&abs),
    };
    if !inside(roots, &real) {
        return Err(format!("Percorso fuori dai progetti aperti: {}", abs.display()));
    }
    Ok(abs)
}

fn is_root(roots: &[PathBuf], abs: &Path) -> bool {
    roots.contains(&real_of(abs))
}

// ".git" is refused too: the tree hides it, and a stray one breaks git there.
fn check_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name == "." || name == ".." || name.eq_ignore_ascii_case(".git") {
        return Err(format!("Nome non valido: {name}"));
    }
    Ok(())
}

fn exists(p: &Path) -> bool {
    fs::symlink_metadata(p).is_ok()
}

// Natural order like Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }):
// digit runs compare as numbers, letters ignore case, punctuation sorts before
// digits and digits before letters.
// ponytail: no accent folding (é ≠ e) — add unicode normalization if names need it.
fn natural(a: &str, b: &str) -> Ordering {
    let (mut a, mut b) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (a.peek().copied(), b.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, _) => return Ordering::Less,
            (_, None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let take = |it: &mut std::iter::Peekable<std::str::Chars>| {
                    let mut s = String::new();
                    while let Some(c) = it.next_if(char::is_ascii_digit) {
                        s.push(c);
                    }
                    s.trim_start_matches('0').to_string()
                };
                let (m, n) = (take(&mut a), take(&mut b));
                let o = m.len().cmp(&n.len()).then_with(|| m.cmp(&n));
                if o != Ordering::Equal {
                    return o;
                }
            }
            (Some(x), Some(y)) => {
                let class = |c: char| if c.is_alphabetic() { 2 } else if c.is_numeric() { 1 } else { 0 };
                let o = class(x).cmp(&class(y)).then_with(|| x.to_lowercase().cmp(y.to_lowercase()));
                if o != Ordering::Equal {
                    return o;
                }
                a.next();
                b.next();
            }
        }
    }
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Entry {
    name: String,
    path: String,
    dir: bool,
}

fn list(roots: &[PathBuf], dir: &str) -> Result<Vec<Entry>, String> {
    let abs = guard(roots, Path::new(dir), true)?;
    let mut out = vec![];
    for e in fs::read_dir(&abs).map_err(err)? {
        let e = e.map_err(err)?;
        let name = e.file_name().to_string_lossy().into_owned();
        if name == ".git" {
            continue;
        }
        let path = abs.join(&name);
        let ft = e.file_type().map_err(err)?;
        // A dangling link fails the stat: show it as a file.
        let dir = if ft.is_symlink() { fs::metadata(&path).is_ok_and(|m| m.is_dir()) } else { ft.is_dir() };
        out.push(Entry { name, path: path.to_string_lossy().into_owned(), dir });
    }
    out.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| natural(&a.name, &b.name)));
    Ok(out)
}

const MAX_PREVIEW: u64 = 1024 * 1024;

fn read(roots: &[PathBuf], file: &str) -> Result<Value, String> {
    let abs = guard(roots, Path::new(file), true)?;
    let st = fs::metadata(&abs).map_err(err)?;
    if st.is_dir() {
        return Err(format!("{} è una cartella: aprila dal tab Project.", base(&abs)));
    }
    let size = st.len();
    if size > MAX_PREVIEW {
        return Ok(json!({ "tooBig": true, "size": size }));
    }
    let buf = fs::read(&abs).map_err(err)?;
    if buf[..buf.len().min(8000)].contains(&0) {
        return Ok(json!({ "binary": true, "size": size }));
    }
    Ok(json!({ "text": String::from_utf8_lossy(&buf), "size": size }))
}

// ── Project-wide search ──────────────────────────────────────
const MAX_FILES: usize = 50_000;
// Without git, the folders no one searches in.
const SKIP_DIRS: [&str; 9] = [".git", "node_modules", "target", "dist", "build", ".next", ".venv", "venv", "__pycache__"];

#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct Found {
    path: String,
    ignored: bool,
}

// A git command's NUL-separated output, or None if git can't run there (not a repository).
fn git_z(dir: &Path, args: &[&str]) -> Option<Vec<String>> {
    use std::process::{Command, Stdio};
    let out = Command::new("git").args(args).current_dir(dir).env("GIT_OPTIONAL_LOCKS", "0").stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    out.status.success().then(|| out.stdout.split(|b| *b == 0).filter(|p| !p.is_empty()).map(|p| String::from_utf8_lossy(p).into_owned()).collect())
}

// Tracked and new files, then the ignored ones (.env) but not what is inside
// ignored folders (node_modules/, target/): git reports those as one entry
// ending in "/", which is dropped. Files deleted but still in the index go.
fn git_files(dir: &Path) -> Option<Vec<Found>> {
    let mut tracked = git_z(dir, &["ls-files", "-z", "--cached", "--others", "--exclude-standard"])?;
    tracked.dedup(); // a conflicted file is listed once per stage
    let deleted: std::collections::HashSet<String> = git_z(dir, &["ls-files", "-z", "--deleted"]).unwrap_or_default().into_iter().collect();
    let ignored = git_z(dir, &["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]).unwrap_or_default();
    let found = |ignored| move |path| Found { path, ignored };
    Some(tracked.into_iter().filter(|p| !deleted.contains(p)).map(found(false)).chain(ignored.into_iter().filter(|p| !p.ends_with('/')).map(found(true))).collect())
}

// Without git: every file, not following links into folders, skipping SKIP_DIRS.
fn walk_files(dir: &Path) -> Vec<Found> {
    let mut out = vec![];
    let mut stack = vec![PathBuf::new()];
    while let Some(rel) = stack.pop() {
        let Ok(rd) = fs::read_dir(dir.join(&rel)) else { continue };
        for e in rd.flatten() {
            let name = e.file_name();
            let path = rel.join(&name);
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                if !SKIP_DIRS.iter().any(|d| name == *d) {
                    stack.push(path);
                }
            } else if !ft.is_symlink() || fs::metadata(dir.join(&path)).is_ok_and(|m| m.is_file()) {
                out.push(Found { path: path.to_string_lossy().into_owned(), ignored: false });
                if out.len() > MAX_FILES {
                    return out;
                }
            }
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

fn files(roots: &[PathBuf], root: &str) -> Result<Value, String> {
    let abs = guard(roots, Path::new(root), true)?;
    let mut list = git_files(&abs).unwrap_or_else(|| walk_files(&abs));
    let truncated = list.len() > MAX_FILES;
    list.truncate(MAX_FILES);
    Ok(json!({ "files": list, "truncated": truncated }))
}

fn create(roots: &[PathBuf], parent: &str, name: &str, dir: bool) -> Result<PathBuf, String> {
    check_name(name)?;
    let abs = guard(roots, &Path::new(parent).join(name), false)?;
    if exists(&abs) {
        return Err(format!("Esiste già: {name}"));
    }
    if dir {
        fs::create_dir(&abs).map_err(err)?;
    } else {
        fs::OpenOptions::new().write(true).create_new(true).open(&abs).map_err(err)?;
    }
    Ok(abs)
}

fn rename(roots: &[PathBuf], from: &str, name: &str) -> Result<PathBuf, String> {
    check_name(name)?;
    let src = guard(roots, Path::new(from), false)?;
    if is_root(roots, &src) {
        return Err("Non puoi rinominare la cartella del progetto.".into());
    }
    let dest = guard(roots, &src.parent().unwrap_or(&src).join(name), false)?;
    if dest == src {
        return Ok(dest);
    }
    if exists(&dest) {
        return Err(format!("Esiste già: {name}"));
    }
    fs::rename(&src, &dest).map_err(err)?;
    Ok(dest)
}

fn move_to(roots: &[PathBuf], from: &str, to_dir: &str) -> Result<PathBuf, String> {
    let src = guard(roots, Path::new(from), false)?;
    if is_root(roots, &src) {
        return Err("Non puoi spostare la cartella del progetto.".into());
    }
    let dest_dir = guard(roots, Path::new(to_dir), true)?;
    let dest = dest_dir.join(base(&src));
    if dest == src {
        return Ok(dest);
    }
    if dest_dir.starts_with(&src) {
        return Err("Non puoi spostare una cartella dentro sé stessa.".into());
    }
    if exists(&dest) {
        return Err(format!("In {} esiste già {}", base(&dest_dir), base(&src)));
    }
    fs::rename(&src, &dest).map_err(err)?;
    Ok(dest)
}

// Like fs.cp(recursive, no overwrite): links are copied as links, not followed.
fn copy_rec(src: &Path, dest: &Path) -> std::io::Result<()> {
    let ft = fs::symlink_metadata(src)?.file_type();
    if ft.is_symlink() {
        std::os::unix::fs::symlink(fs::read_link(src)?, dest)
    } else if ft.is_dir() {
        fs::create_dir(dest)?;
        for e in fs::read_dir(src)? {
            let e = e?;
            copy_rec(&e.path(), &dest.join(e.file_name()))?;
        }
        Ok(())
    } else {
        fs::copy(src, dest).map(|_| ())
    }
}

// Copies files/folders dropped from outside Work into a project folder.
// Only the destination is guarded: the sources are what the user dragged in.
// All names are checked first, so a conflict copies nothing.
fn copy_in(roots: &[PathBuf], srcs: &[String], to_dir: &str) -> Result<Vec<PathBuf>, String> {
    let dest_dir = guard(roots, Path::new(to_dir), true)?;
    let pairs: Vec<(PathBuf, PathBuf)> = srcs
        .iter()
        .map(|s| {
            let src = resolve(Path::new(s));
            let dest = dest_dir.join(base(&src));
            (src, dest)
        })
        .collect();
    for (src, dest) in &pairs {
        check_name(&base(dest))?;
        if exists(dest) {
            return Err(format!("In {} esiste già {}", base(&dest_dir), base(dest)));
        }
        // fs.cp refuses this too; without it the copy would recurse into itself.
        if dest.starts_with(src) {
            return Err(format!("Cannot copy {} to a subdirectory of self {}", src.display(), dest.display()));
        }
    }
    for (src, dest) in &pairs {
        copy_rec(src, dest).map_err(err)?;
    }
    Ok(pairs.into_iter().map(|(_, dest)| dest).collect())
}

fn check_trash(roots: &[PathBuf], p: &str) -> Result<PathBuf, String> {
    let abs = guard(roots, Path::new(p), false)?;
    if is_root(roots, &abs) {
        return Err("Non puoi eliminare la cartella del progetto.".into());
    }
    Ok(abs)
}

// Disk work runs off the main thread.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn fs_list(roots: State<'_, Roots>, dir: String) -> Result<Vec<Entry>, String> {
    let r = roots.get();
    blocking(move || list(&r, &dir)).await
}

#[tauri::command]
pub async fn fs_read(roots: State<'_, Roots>, file: String) -> Result<Value, String> {
    let r = roots.get();
    blocking(move || read(&r, &file)).await
}

#[tauri::command]
pub async fn fs_files(roots: State<'_, Roots>, root: String) -> Result<Value, String> {
    let r = roots.get();
    blocking(move || files(&r, &root)).await
}

#[tauri::command]
pub async fn fs_create(roots: State<'_, Roots>, parent: String, name: String, dir: bool) -> Result<PathBuf, String> {
    let r = roots.get();
    blocking(move || create(&r, &parent, &name, dir)).await
}

#[tauri::command]
pub async fn fs_rename(roots: State<'_, Roots>, from: String, name: String) -> Result<PathBuf, String> {
    let r = roots.get();
    blocking(move || rename(&r, &from, &name)).await
}

#[tauri::command]
pub async fn fs_move(roots: State<'_, Roots>, from: String, to_dir: String) -> Result<PathBuf, String> {
    let r = roots.get();
    blocking(move || move_to(&r, &from, &to_dir)).await
}

#[tauri::command]
pub async fn fs_copy_in(roots: State<'_, Roots>, srcs: Vec<String>, to_dir: String) -> Result<Vec<PathBuf>, String> {
    let r = roots.get();
    blocking(move || copy_in(&r, &srcs, &to_dir)).await
}

#[tauri::command]
pub async fn fs_trash(roots: State<'_, Roots>, path: String) -> Result<(), String> {
    let r = roots.get();
    blocking(move || {
        let abs = check_trash(&r, &path)?;
        #[allow(unused_mut)]
        let mut ctx = trash::TrashContext::default();
        // NSFileManager, like Electron's shell.trashItem: the Finder method
        // needs Automation permission and plays a sound.
        #[cfg(target_os = "macos")]
        trash::macos::TrashContextExtMacos::set_delete_method(&mut ctx, trash::macos::DeleteMethod::NsFileManager);
        ctx.delete(&abs).map_err(|e| e.to_string())
    })
    .await
}

// Opening follows links (it may launch the target), revealing only shows the entry.
#[tauri::command]
pub async fn fs_open_path(app: tauri::AppHandle, roots: State<'_, Roots>, path: String) -> Result<(), String> {
    let abs = guard(&roots.get(), Path::new(&path), true)?;
    app.opener().open_path(abs.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fs_reveal(app: tauri::AppHandle, roots: State<'_, Roots>, path: String) -> Result<(), String> {
    let abs = guard(&roots.get(), Path::new(&path), false)?;
    app.opener().reveal_item_in_dir(abs).map_err(|e| e.to_string())
}

// Integration: the Project tree's file operations on a real temp folder.
// Trash/open/reveal have OS side effects: only their guard is tested.
#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    struct Fx {
        _tmp: tempfile::TempDir,
        project: PathBuf,
        outside: PathBuf,
        roots: Vec<PathBuf>,
    }

    fn fx() -> Fx {
        let tmp = tempfile::Builder::new().prefix("work-fs-").tempdir().unwrap();
        let project = tmp.path().join("project");
        let outside = tmp.path().join("outside");
        fs::create_dir_all(project.join("src")).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(project.join("src/a.txt"), "dentro\n").unwrap();
        fs::write(outside.join("secret.txt"), "segreto\n").unwrap();
        symlink(outside.join("secret.txt"), project.join("link-file")).unwrap();
        symlink(&outside, project.join("link-dir")).unwrap();
        let r = Roots::default();
        r.set(&[s(&project)]);
        Fx { roots: r.get(), _tmp: tmp, project, outside }
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    fn rejects<T: std::fmt::Debug>(r: Result<T, String>, needle: &str) {
        let e = r.unwrap_err();
        assert!(e.contains(needle), "{e:?} does not contain {needle:?}");
    }

    #[test]
    fn elenca_le_cartelle_prima_dei_file_in_ordine_naturale_senza_git() {
        let f = fx();
        fs::create_dir(f.project.join(".git")).unwrap();
        fs::write(f.project.join("file10.txt"), "").unwrap();
        fs::write(f.project.join("file2.txt"), "").unwrap();
        let names: Vec<String> = list(&f.roots, &s(&f.project)).unwrap().into_iter().map(|e| e.name).collect();
        assert_eq!(names, ["link-dir", "src", "file2.txt", "file10.txt", "link-file"]);
    }

    fn git(dir: &Path, args: &[&str]) {
        let ok = std::process::Command::new("git").args(args).current_dir(dir).output().unwrap().status.success();
        assert!(ok, "git {args:?}");
    }

    fn paths(v: &Value) -> Vec<(String, bool)> {
        v["files"].as_array().unwrap().iter().map(|f| (f["path"].as_str().unwrap().to_string(), f["ignored"].as_bool().unwrap())).collect()
    }

    #[test]
    fn i_file_di_un_repository_includono_il_env_ignorato_ma_non_node_modules() {
        let f = fx();
        let p = &f.project;
        git(p, &["init", "-q"]);
        fs::write(p.join(".gitignore"), ".env*\nnode_modules/\n").unwrap();
        fs::write(p.join("vecchio.txt"), "").unwrap();
        git(p, &["add", "."]);
        git(p, &["-c", "user.name=T", "-c", "user.email=t@t", "commit", "-qm", "x"]);
        fs::remove_file(p.join("vecchio.txt")).unwrap();
        fs::write(p.join(".env.local"), "A=1\n").unwrap();
        fs::write(p.join("nuovo.js"), "").unwrap();
        fs::create_dir_all(p.join("node_modules/lib")).unwrap();
        fs::write(p.join("node_modules/lib/index.js"), "").unwrap();

        let got = paths(&files(&f.roots, &s(p)).unwrap());
        let has = |path: &str, ignored: bool| got.contains(&(path.to_string(), ignored));
        assert!(has("src/a.txt", false) && has("nuovo.js", false) && has(".gitignore", false), "{got:?}");
        assert!(has(".env.local", true), "{got:?}");
        assert!(!got.iter().any(|(p, _)| p.starts_with("node_modules")), "{got:?}");
        assert!(!got.iter().any(|(p, _)| p == "vecchio.txt"), "deleted from disk: {got:?}");
    }

    #[test]
    fn i_file_senza_git_saltano_le_cartelle_della_lista() {
        let f = fx();
        for d in ["node_modules/x", "target/debug", ".venv"] {
            fs::create_dir_all(f.project.join(d)).unwrap();
            fs::write(f.project.join(d).join("f"), "").unwrap();
        }
        fs::write(f.project.join(".env"), "").unwrap();
        let v = files(&f.roots, &s(&f.project)).unwrap();
        assert_eq!(v["truncated"], false);
        let got: Vec<String> = paths(&v).into_iter().map(|(p, _)| p).collect();
        assert_eq!(got, [".env", "link-file", "src/a.txt"], "the link to a folder is not followed");
    }

    #[test]
    fn non_elenca_i_file_fuori_dal_progetto() {
        let f = fx();
        rejects(files(&f.roots, &s(&f.outside)), "fuori dai progetti");
        rejects(files(&f.roots, &s(&f.project.join("link-dir"))), "fuori dai progetti");
    }

    #[test]
    fn ordine_naturale() {
        assert_eq!(natural("a2", "a10"), Ordering::Less);
        assert_eq!(natural("B", "a"), Ordering::Greater);
        assert_eq!(natural("Readme", "readme"), Ordering::Equal);
        assert_eq!(natural("a_b", "a1"), Ordering::Less);
        assert_eq!(natural("x007", "x7"), Ordering::Equal);
    }

    #[test]
    fn legge_un_file_del_progetto() {
        let f = fx();
        assert_eq!(read(&f.roots, &s(&f.project.join("src/a.txt"))).unwrap()["text"], "dentro\n");
    }

    #[test]
    fn non_legge_un_file_fuori_dal_progetto() {
        let f = fx();
        rejects(read(&f.roots, &s(&f.outside.join("secret.txt"))), "fuori dai progetti");
    }

    #[test]
    fn non_legge_un_file_esterno_tramite_un_symlink_nel_progetto_regressione() {
        let f = fx();
        rejects(read(&f.roots, &s(&f.project.join("link-file"))), "fuori dai progetti");
    }

    #[test]
    fn non_elenca_una_cartella_esterna_tramite_un_symlink_regressione() {
        let f = fx();
        rejects(list(&f.roots, &s(&f.project.join("link-dir"))), "fuori dai progetti");
    }

    #[test]
    fn non_crea_file_dentro_una_cartella_esterna_raggiunta_da_un_symlink_regressione() {
        let f = fx();
        rejects(create(&f.roots, &s(&f.project.join("link-dir")), "x.txt", false), "fuori dai progetti");
        assert!(!f.outside.join("x.txt").exists());
    }

    #[test]
    fn non_sposta_file_in_una_cartella_esterna_raggiunta_da_un_symlink_regressione() {
        let f = fx();
        rejects(move_to(&f.roots, &s(&f.project.join("src/a.txt")), &s(&f.project.join("link-dir"))), "fuori dai progetti");
        assert!(f.project.join("src/a.txt").exists());
    }

    #[test]
    fn non_apre_file_fuori_dal_progetto_regressione() {
        let f = fx();
        rejects(guard(&f.roots, Path::new("/etc/passwd"), true), "fuori dai progetti");
        rejects(guard(&f.roots, &f.project.join("link-file"), true), "fuori dai progetti");
    }

    #[test]
    fn un_symlink_si_puo_rinominare_e_cestinare() {
        let f = fx();
        let renamed = rename(&f.roots, &s(&f.project.join("link-file")), "link-renamed").unwrap();
        assert_eq!(base(&renamed), "link-renamed");
        assert_eq!(check_trash(&f.roots, &s(&f.project.join("link-dir"))).unwrap(), f.project.join("link-dir"));
        assert!(f.outside.join("secret.txt").exists(), "the outside target is untouched");
    }

    #[test]
    fn rifiuta_nomi_con_separatori_o_dotdot() {
        let f = fx();
        rejects(create(&f.roots, &s(&f.project), "../evil", false), "Nome non valido");
        rejects(rename(&f.roots, &s(&f.project.join("src/a.txt")), "x/y"), "Nome non valido");
    }

    #[test]
    fn non_crea_un_file_che_esiste_gia() {
        let f = fx();
        rejects(create(&f.roots, &s(&f.project.join("src")), "a.txt", false), "Esiste già");
    }

    #[test]
    fn non_sposta_una_cartella_dentro_se_stessa() {
        let f = fx();
        fs::create_dir(f.project.join("src/sub")).unwrap();
        rejects(move_to(&f.roots, &s(&f.project.join("src")), &s(&f.project.join("src/sub"))), "dentro sé stessa");
    }

    #[test]
    fn non_cestina_la_cartella_del_progetto() {
        let f = fx();
        rejects(check_trash(&f.roots, &s(&f.project)), "cartella del progetto");
    }

    #[test]
    fn riconosce_file_binari_e_file_troppo_grandi_per_l_anteprima() {
        let f = fx();
        fs::write(f.project.join("img.bin"), [0x89, 0x50, 0, 0x47]).unwrap();
        fs::write(f.project.join("big.txt"), vec![b'a'; 1024 * 1024 + 1]).unwrap();
        assert_eq!(read(&f.roots, &s(&f.project.join("img.bin"))).unwrap(), json!({ "binary": true, "size": 4 }));
        assert_eq!(read(&f.roots, &s(&f.project.join("big.txt"))).unwrap(), json!({ "tooBig": true, "size": 1024 * 1024 + 1 }));
    }

    #[test]
    fn un_symlink_rotto_compare_come_file_e_non_blocca_l_elenco() {
        let f = fx();
        symlink(f.project.join("non-esiste"), f.project.join("rotto")).unwrap();
        let entry = list(&f.roots, &s(&f.project)).unwrap().into_iter().find(|e| e.name == "rotto").unwrap();
        assert_eq!(entry, Entry { name: "rotto".into(), path: s(&f.project.join("rotto")), dir: false });
    }

    #[test]
    fn crea_una_cartella_che_poi_compare_come_cartella() {
        let f = fx();
        let created = create(&f.roots, &s(&f.project.join("src")), "nuova", true).unwrap();
        assert_eq!(created, f.project.join("src/nuova"));
        assert!(list(&f.roots, &s(&f.project.join("src"))).unwrap().into_iter().find(|e| e.name == "nuova").unwrap().dir);
    }

    #[test]
    fn non_sposta_un_file_dove_esiste_gia_e_lascia_intatto_l_originale() {
        let f = fx();
        fs::create_dir(f.project.join("dest")).unwrap();
        fs::write(f.project.join("dest/a.txt"), "altro\n").unwrap();
        rejects(move_to(&f.roots, &s(&f.project.join("src/a.txt")), &s(&f.project.join("dest"))), "esiste già");
        assert_eq!(fs::read_to_string(f.project.join("src/a.txt")).unwrap(), "dentro\n");
        assert_eq!(fs::read_to_string(f.project.join("dest/a.txt")).unwrap(), "altro\n");
    }

    #[test]
    fn rinominare_con_lo_stesso_nome_non_cambia_nulla() {
        let f = fx();
        let p = f.project.join("src/a.txt");
        assert_eq!(rename(&f.roots, &s(&p), "a.txt").unwrap(), p);
        assert!(p.exists());
    }

    #[test]
    fn mostra_nel_file_manager_solo_elementi_del_progetto() {
        let f = fx();
        let p = f.project.join("src/a.txt");
        assert_eq!(guard(&f.roots, &p, false).unwrap(), p);
        rejects(guard(&f.roots, &f.outside.join("secret.txt"), false), "fuori dai progetti");
    }

    #[test]
    fn la_cartella_del_progetto_non_si_puo_rinominare_ne_spostare_regressione() {
        let f = fx();
        rejects(rename(&f.roots, &s(&f.project), "altro-nome"), "cartella del progetto");
        fs::create_dir(f.project.join("dentro")).unwrap();
        let e = move_to(&f.roots, &s(&f.project), &s(&f.project.join("dentro"))).unwrap_err();
        assert!(e.contains("cartella del progetto") || e.contains("dentro sé stessa"), "{e}");
        assert!(f.project.join("src/a.txt").exists(), "the project is where it was");
    }

    #[test]
    fn rifiuta_dot_git_come_nome_regressione() {
        let f = fx();
        rejects(create(&f.roots, &s(&f.project.join("src")), ".git", false), "Nome non valido");
        rejects(create(&f.roots, &s(&f.project), ".GIT", true), "Nome non valido");
        rejects(rename(&f.roots, &s(&f.project.join("src/a.txt")), ".git"), "Nome non valido");
        assert!(!f.project.join("src/.git").exists());
    }

    #[test]
    fn leggere_una_cartella_da_un_messaggio_chiaro_invece_di_eisdir_regressione() {
        let f = fx();
        let e = read(&f.roots, &s(&f.project.join("src"))).unwrap_err();
        assert!(e.to_lowercase().contains("cartella") && !e.contains("EISDIR"), "{e}");
    }

    #[test]
    fn copia_file_e_cartelle_trascinati_da_fuori_in_una_cartella_del_progetto() {
        let f = fx();
        fs::create_dir_all(f.outside.join("assets/img")).unwrap();
        fs::write(f.outside.join("assets/img/a.png"), "png").unwrap();
        let copied = copy_in(&f.roots, &[s(&f.outside.join("assets")), s(&f.outside.join("secret.txt"))], &s(&f.project.join("src"))).unwrap();
        assert_eq!(copied, [f.project.join("src/assets"), f.project.join("src/secret.txt")]);
        assert_eq!(fs::read_to_string(f.project.join("src/assets/img/a.png")).unwrap(), "png");
        assert!(f.outside.join("secret.txt").exists(), "the source stays where it was");
    }

    #[test]
    fn la_copia_da_fuori_non_sovrascrive_e_non_esce_dai_progetti() {
        let f = fx();
        fs::write(f.outside.join("a.txt"), "fuori\n").unwrap();
        fs::write(f.outside.join("nuovo.txt"), "").unwrap();
        let to = s(&f.project.join("src"));
        rejects(copy_in(&f.roots, &[s(&f.outside.join("nuovo.txt")), s(&f.outside.join("a.txt"))], &to), "esiste già a.txt");
        assert_eq!(fs::read_to_string(f.project.join("src/a.txt")).unwrap(), "dentro\n");
        assert!(!f.project.join("src/nuovo.txt").exists(), "a conflict copies nothing");
        rejects(copy_in(&f.roots, &[s(&f.project.join("src/a.txt"))], &s(&f.project.join("link-dir"))), "fuori dai progetti");
    }
}

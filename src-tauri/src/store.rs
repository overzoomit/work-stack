// Persistent app state (open projects, active project) in the app data dir.
use serde_json::{json, Value};
use std::fs;
use std::io;
use std::path::Path;

// A file edited by hand may be valid JSON of the wrong shape: keep only what
// the app can use, so it still starts.
fn normalize(s: Value) -> Value {
    let Value::Object(mut s) = s else {
        return json!({ "projects": [], "active": null });
    };
    let projects: Vec<Value> = match s.remove("projects") {
        Some(Value::Array(list)) => list.into_iter().filter(|p| p.get("path").is_some_and(Value::is_string)).collect(),
        _ => vec![],
    };
    let active = match s.remove("active") {
        Some(a @ Value::String(_)) => a,
        _ => Value::Null,
    };
    s.insert("projects".into(), Value::Array(projects));
    s.insert("active".into(), active);
    Value::Object(s)
}

fn read(file: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(file).ok()?).ok()
}

// `legacy` is the Electron build's state.json: read once, until this build saves its own.
pub fn load(file: &Path, legacy: Option<&Path>) -> Value {
    normalize(read(file).or_else(|| legacy.and_then(read)).unwrap_or(Value::Null))
}

// Written to a temporary file and renamed over the old one: a write cut short
// (disk full, crash) never leaves a truncated state.json behind.
pub fn save(file: &Path, state: &Value) -> io::Result<()> {
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = file.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string_pretty(state)?)?;
    fs::rename(tmp, file)
}

// Keys the renderer sends replace the saved ones; the others stay.
pub fn merge(state: &mut Value, next: Value) {
    if let (Value::Object(s), Value::Object(n)) = (state, next) {
        s.extend(n);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn saves_and_reads_back() {
        let d = dir();
        let f = d.path().join("state.json");
        save(&f, &json!({ "projects": [{ "path": "/a" }], "active": "/a" })).unwrap();
        assert_eq!(load(&f, None), json!({ "projects": [{ "path": "/a" }], "active": "/a" }));
    }

    #[test]
    fn missing_or_broken_file_starts_empty() {
        let d = dir();
        let f = d.path().join("state.json");
        assert_eq!(load(&f, None), json!({ "projects": [], "active": null }));
        fs::write(&f, "{ rotto").unwrap();
        assert_eq!(load(&f, None), json!({ "projects": [], "active": null }));
    }

    #[test]
    fn wrong_shape_does_not_stop_the_start() {
        let d = dir();
        let f = d.path().join("state.json");
        for text in ["null", "[]", r#"{"projects": null}"#, r#"{"projects": {"path": "/a"}}"#, r#"{"projects": [{"path": "/a"}, 3, null, {}]}"#] {
            fs::write(&f, text).unwrap();
            let s = load(&f, None);
            let list = s["projects"].as_array().expect(text);
            assert!(list.iter().all(|p| p["path"].is_string()), "{text}");
        }
        fs::write(&f, r#"{"projects": [{"path": "/a"}, 3], "active": "/a", "theme": "x"}"#).unwrap();
        assert_eq!(load(&f, None), json!({ "projects": [{ "path": "/a" }], "active": "/a", "theme": "x" }));
    }

    #[test]
    fn imports_the_electron_state_until_the_first_save() {
        let d = dir();
        let f = d.path().join("new/state.json");
        let old = d.path().join("old.json");
        fs::write(&old, r#"{"projects": [{"path": "/old"}], "active": "/old"}"#).unwrap();
        assert_eq!(load(&f, Some(&old))["active"], "/old");
        save(&f, &json!({ "projects": [], "active": "/new" })).unwrap();
        assert_eq!(load(&f, Some(&old))["active"], "/new");
    }

    #[test]
    fn merge_keeps_keys_not_sent() {
        let mut s = json!({ "projects": [], "active": null, "theme": "x" });
        merge(&mut s, json!({ "active": "/a" }));
        assert_eq!(s, json!({ "projects": [], "active": "/a", "theme": "x" }));
    }
}

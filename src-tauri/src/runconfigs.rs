// Detects runnable commands in a project folder, like WebStorm's run
// configurations: npm scripts, Make targets, Cargo, Django, Compose, Go.
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Debug, PartialEq)]
pub struct Config {
    pub id: String,
    pub group: String,
    pub name: String,
    pub command: String,
}

// The "packageManager" field (Corepack) wins, then the lockfile. Only known
// names are trusted: the value ends up in a shell command.
fn package_manager(dir: &Path, pkg: &Value) -> &'static str {
    let declared = pkg.get("packageManager").and_then(Value::as_str).unwrap_or("");
    let declared = declared.split('@').next().unwrap_or("");
    if let Some(pm) = ["npm", "pnpm", "yarn", "bun"].into_iter().find(|&pm| pm == declared) {
        return pm;
    }
    if dir.join("pnpm-lock.yaml").exists() {
        "pnpm"
    } else if dir.join("yarn.lock").exists() {
        "yarn"
    } else if dir.join("bun.lockb").exists() || dir.join("bun.lock").exists() {
        "bun"
    } else {
        "npm"
    }
}

// Most useful scripts first, the rest alphabetically.
const PRIORITY: [&str; 7] = ["dev", "start", "serve", "watch", "build", "test", "lint"];

fn rank(name: &str) -> usize {
    PRIORITY.iter().position(|&p| p == name).unwrap_or(PRIORITY.len())
}

// Script names may contain spaces or shell characters ("e2e test"): quote
// anything that isn't a plain word so the shell passes it as one argument.
fn shell_arg(s: &str) -> String {
    let plain = !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "_:.@/+=-".contains(c));
    if plain {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', r"'\''"))
    }
}

fn read(p: PathBuf) -> Option<String> {
    fs::read(p).ok().map(|b| String::from_utf8_lossy(&b).into_owned())
}

fn is_name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-'
}

// "a b:" or "a::" is a rule (one line may name several targets);
// "name := …", "::=" and ":::=" are assignments.
// Names start with a letter or digit, then [A-Za-z0-9_.-].
fn rule_targets(line: &str) -> Vec<&str> {
    let mut names = vec![];
    let mut rest = line;
    loop {
        if !rest.starts_with(|c: char| c.is_ascii_alphanumeric()) {
            return vec![];
        }
        let end = rest.find(|c| !is_name_char(c)).unwrap_or(rest.len());
        names.push(&rest[..end]);
        let after = &rest[end..];
        rest = after.trim_start_matches([' ', '\t']);
        if let Some(after_colon) = rest.strip_prefix(':') {
            let tail = after_colon.trim_start_matches(':');
            // At most two more colons before "=" make an assignment.
            let colons = after_colon.len() - tail.len();
            return if colons <= 2 && tail.starts_with('=') { vec![] } else { names };
        }
        if rest.len() == after.len() {
            return vec![]; // a character that is neither a name, blank nor ':'
        }
    }
}

pub fn detect(dir: &Path) -> Vec<Config> {
    let mut configs = vec![];
    let mut add = |group: &str, name: &str, command: String| {
        configs.push(Config { id: format!("{group}:{name}"), group: group.into(), name: name.into(), command });
    };

    if let Some(pkg) = read(dir.join("package.json")).and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
        if pkg.is_object() {
            let pm = package_manager(dir, &pkg);
            let mut names: Vec<&String> = pkg.get("scripts").and_then(Value::as_object).map(|s| s.keys().collect()).unwrap_or_default();
            // ponytail: case-insensitive byte order stands in for localeCompare; ICU collation if non-ASCII names matter.
            names.sort_by(|a, b| rank(a).cmp(&rank(b)).then_with(|| a.to_lowercase().cmp(&b.to_lowercase())).then_with(|| a.cmp(b)));
            for name in names {
                add(pm, name, format!("{pm} run {}", shell_arg(name)));
            }
        }
    }

    // The first of these make reads, in its own order.
    if let Some(make) = ["GNUmakefile", "makefile", "Makefile"].iter().find_map(|f| read(dir.join(f))) {
        let mut seen: Vec<&str> = vec![];
        for line in make.split(['\n', '\r', '\u{2028}', '\u{2029}']) {
            for t in rule_targets(line) {
                if !seen.contains(&t) {
                    seen.push(t);
                    add("make", t, format!("make {t}"));
                }
            }
        }
    }

    if dir.join("Cargo.toml").exists() {
        add("cargo", "run", "cargo run".into());
        add("cargo", "test", "cargo test".into());
        add("cargo", "build", "cargo build".into());
    }
    if dir.join("manage.py").exists() {
        add("django", "runserver", "python3 manage.py runserver".into()); // no bare "python" on Ubuntu 20.04 / recent macOS
    }
    if dir.join("go.mod").exists() {
        add("go", "run", "go run .".into());
        add("go", "test", "go test ./...".into());
    }
    if ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"].iter().any(|f| dir.join(f).exists()) {
        add("docker", "compose up", "docker compose up".into());
    }
    configs
}

#[tauri::command]
pub async fn run_detect(dir: String) -> Result<Vec<Config>, String> {
    tauri::async_runtime::spawn_blocking(move || detect(Path::new(&dir))).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn folder(files: &[(&str, &str)]) -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        for (name, text) in files {
            fs::write(d.path().join(name), text).unwrap();
        }
        d
    }

    fn names(d: &tempfile::TempDir) -> Vec<String> {
        detect(d.path()).into_iter().map(|c| c.name).collect()
    }

    fn commands(d: &tempfile::TempDir) -> Vec<String> {
        detect(d.path()).into_iter().map(|c| c.command).collect()
    }

    #[test]
    fn most_used_scripts_first_then_alphabetical() {
        let d = folder(&[("package.json", r#"{"scripts":{"lint":"x","zeta":"x","build":"x","dev":"x","alpha":"x"}}"#)]);
        assert_eq!(names(&d), ["dev", "build", "lint", "alpha", "zeta"]);
    }

    #[test]
    fn package_manager_from_lockfile() {
        let d = folder(&[("package.json", r#"{"scripts":{"dev":"x"}}"#), ("pnpm-lock.yaml", "")]);
        assert_eq!(commands(&d), ["pnpm run dev"]);
    }

    #[test]
    fn makefile_targets_skip_variable_assignments() {
        let d = folder(&[("Makefile", "CC := gcc\nbuild:\n\tgo build\ntest: build\n\tgo test\n.PHONY: build\n")]);
        assert_eq!(commands(&d), ["make build", "make test"]);
    }

    #[test]
    fn folder_without_projects_has_no_configs() {
        let d = folder(&[("README.md", "# x")]);
        assert_eq!(detect(d.path()), []);
    }

    #[test]
    fn invalid_package_json_does_not_stop_the_rest() {
        let d = folder(&[("package.json", "{ non json"), ("Cargo.toml", "[package]")]);
        assert_eq!(commands(&d), ["cargo run", "cargo test", "cargo build"]);
    }

    #[test]
    fn script_names_with_shell_characters_arrive_as_one_argument() {
        let list = ["e2e test", "it's", "a;touch PWNED", "$(id)", "build:prod"];
        let scripts: serde_json::Map<String, Value> = list.iter().map(|n| (n.to_string(), json!("x"))).collect();
        let d = folder(&[("package.json", &json!({ "scripts": scripts }).to_string())]);
        let configs = detect(d.path());
        assert_eq!(configs.len(), list.len());
        for c in &configs {
            // Replace the package manager with printf: the shell must hand over the name unchanged, as one word.
            let cmd = c.command.replacen("npm run ", "printf '%s\\n' ", 1);
            let out = std::process::Command::new("sh").args(["-c", &cmd]).current_dir(d.path()).output().unwrap();
            assert_eq!(String::from_utf8(out.stdout).unwrap(), format!("{}\n", c.name), "{}", c.command);
        }
        assert!(!d.path().join("PWNED").exists());
        let prod = configs.iter().find(|c| c.name == "build:prod").unwrap();
        assert_eq!(prod.command, "npm run build:prod", "plain names stay unquoted");
    }

    #[test]
    fn posix_assignments_are_not_targets_double_colon_rules_are() {
        let d = folder(&[("Makefile", "CC ::= gcc\nFLAGS :::= -O2\nclean::\n\trm -f *.o\nbuild: deps\n\tcc main.c\n")]);
        assert_eq!(names(&d), ["clean", "build"]);
    }

    #[test]
    fn cargo_django_go_and_one_compose() {
        let d = folder(&[("Cargo.toml", ""), ("manage.py", ""), ("go.mod", "module x\n"), ("compose.yaml", ""), ("docker-compose.yml", "")]);
        let got: Vec<(String, String)> = detect(d.path()).into_iter().map(|c| (c.id, c.command)).collect();
        let want = [
            ("cargo:run", "cargo run"),
            ("cargo:test", "cargo test"),
            ("cargo:build", "cargo build"),
            // python3, not python: Ubuntu 20.04 and recent macOS have no bare "python".
            ("django:runserver", "python3 manage.py runserver"),
            ("go:run", "go run ."),
            ("go:test", "go test ./..."),
            ("docker:compose up", "docker compose up"),
        ];
        assert_eq!(got, want.map(|(a, b)| (a.to_string(), b.to_string())));
    }

    #[test]
    fn declared_package_manager_without_lockfile() {
        let d = folder(&[("package.json", r#"{"packageManager":"pnpm@9.1.0","scripts":{"dev":"x"}}"#)]);
        assert_eq!(commands(&d), ["pnpm run dev"]);
        let yarn = folder(&[("package.json", r#"{"packageManager":"yarn@4.0.2+sha256.abc","scripts":{"dev":"x"}}"#)]);
        assert_eq!(commands(&yarn), ["yarn run dev"]);
        let weird = folder(&[("package.json", r#"{"packageManager":"rm -rf /@1","scripts":{"dev":"x"}}"#)]);
        assert_eq!(commands(&weird), ["npm run dev"], "only known managers are trusted");
    }

    #[test]
    fn make_reads_makefile_and_gnumakefile_and_every_target_on_a_line() {
        let lower = folder(&[("makefile", "build test: deps\n\tgo build\ndeps:\n\ttrue\n")]);
        assert_eq!(commands(&lower), ["make build", "make test", "make deps"]);
        let gnu = folder(&[("GNUmakefile", "all:\n\ttrue\n"), ("Makefile", "ignored:\n")]);
        assert_eq!(commands(&gnu), ["make all"], "GNUmakefile wins, as in make itself");
    }
}

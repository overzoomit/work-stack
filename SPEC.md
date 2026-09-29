# Spec: Work su Tauri 2

## Obiettivo
Work (terminali, git e agenti AI in un'unica dashboard desktop) passa da Electron a Tauri 2 con il
backend in Rust, per diventare un prodotto installabile e più leggero. Per chi lo usa non cambia niente:
ogni funzione descritta nel README fa quello che fa oggi.

Utente: sviluppatore su macOS o Linux che lavora con più repository, terminali e agenti CLI
(Claude Code, Codex, Gemini…).

## Tech stack
- **Shell**: Tauri 2 (`tauri` 2.x), Rust stable (edition 2021).
- **Renderer**: HTML/CSS/JS ES module già esistente, senza bundler; xterm.js 6, marked, DOMPurify
  copiati in `src/renderer/vendor/` da `scripts/vendor.mjs` (`postinstall`).
- **Ponte**: `src/renderer/bridge.js` espone `window.work` con la stessa API di `src/main/preload.js`.
- **Crate approvati**: `serde`, `serde_json`, `portable-pty`, `notify`, `trash`, `sysinfo`, `tokio`,
  `libc`, `tauri-plugin-dialog`, `tauri-plugin-opener`, `tauri-plugin-clipboard-manager`;
  `tempfile` solo nei test.
- **Esterni a runtime**: `git` (CLI, per rispettare config, hook, credenziali e firma dell'utente),
  la shell di login dell'utente. `python3` non serve più.
- **Piattaforme**: macOS arm64; Linux x86_64 con webkit2gtk-4.1 (Ubuntu 22.04+). Windows fuori scope.
- **Nome e identificatore**: Work, `it.overzoom.work`.

## Comandi
```
Installazione:  npm install                        # copia anche le librerie in src/renderer/vendor
Sviluppo:       npm run dev                        # tauri dev
Build:          npm run build                      # tauri build → .app/.dmg (macOS), .deb/.AppImage (Linux)
Test:           npm test                           # node --test (renderer) && cargo test (backend)
Solo backend:   cargo test --manifest-path src-tauri/Cargo.toml
Formato:        cargo fmt --manifest-path src-tauri/Cargo.toml
Lint:           cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

## Struttura
```
src-tauri/            backend Rust
  src/main.rs         builder Tauri, registrazione dei comandi (solo collegamento)
  src/<modulo>.rs     un file per area: store, pty, git, gitwatch, fsops, runconfigs, agents, claudeprocs, sysstats
  capabilities/       permessi Tauri della finestra
  tauri.conf.json     finestra, bundle, icone
src/renderer/         interfaccia (invariata tranne import e bridge.js)
scripts/vendor.mjs    copia delle librerie del renderer
test/                 test del renderer (node --test); i test del main JS spariscono con T9
tasks/                piano e todo della migrazione
```
Comandi Tauri: nome = canale Electron in snake_case (`git:fileDiff` → `git_file_diff`). Eventi dal
backend: stesso nome del canale Electron (`pty:data`, `git:changed`, `agents:update`, `app:focus`),
con gli argomenti come array nel payload.

## Stile del codice
- Commenti in inglese, pochi, sul *perché* (come nel JS di oggi). Messaggi per l'utente in italiano.
- Errori verso il renderer come `Result<T, String>` con il messaggio italiano che c'è oggi.
- Niente astrazioni per un solo uso; funzioni piccole, logica pura separata dall'I/O quando serve a testarla.

```rust
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
```

## Strategia di test
- **Backend**: `cargo test`, test unitari nel modulo (`#[cfg(test)] mod tests`). I casi di
  `test/<modulo>.test.js` si portano in Rust, compresi tutti quelli marcati "regressione"; git su repository
  temporanei reali, PTY con shell reali, file system su cartelle temporanee (symlink compresi).
- **Renderer**: `node --test` resta com'è e deve restare verde.
- Un test JS del main si elimina solo quando il suo modulo Rust ne copre i casi.
- **UI**: verifica manuale con `npm run dev` ai checkpoint (screenshot).
- I 3 test JS che oggi falliscono su macOS (`claudeprocs` ×2, PTY con job in background) devono passare
  nella versione Rust.

## Confini
- **Sempre**: `cargo test` e `node --test` verdi prima di ogni commit; un commit per task con la skill
  conventional-commits; guardia sui percorsi reali per ogni operazione su file; nessun comando shell
  costruito con input del renderer non validato.
- **Chiedere prima**: crate non in lista; cambiare l'API di `window.work` o il renderer oltre import/ponte;
  firma, notarization, pubblicazione di release; toccare file fuori dal repository.
- **Mai**: indebolire o saltare test per farli passare; `git push` o operazioni di rete oltre a scaricare
  crate/pacchetti; salvare segreti; cambiare il comportamento visibile all'utente senza dirlo.

## Criteri di successo
1. Ogni voce di "Cosa fa" e ogni scorciatoia del README funziona nella build Tauri (verifica manuale al Checkpoint C).
2. `npm test` verde, con i casi del main portati in `cargo test`.
3. Nessuna dipendenza da Electron, Node a runtime o `python3` (dopo T9).
4. `npm run build` produce un `.dmg` che si installa e si avvia da Finder; config Linux per `.deb`/`.AppImage`.
5. Misure sulla stessa macchina, 1 progetto e 1 terminale aperti, riportate nel README:
   - RAM a riposo ≤ 150 MB (Electron: 205–280 MB);
   - installer ≤ 25 MB (Electron: ~150 MB);
   - CPU a riposo ≤ 0,5%;
   - `seq 1 1000000` in un terminale: nessun task della UI sopra 50 ms.
6. Lo stato di Electron (progetti aperti) viene importato al primo avvio.

## Domande aperte
- Nessuna bloccante. Firma macOS, auto-update e CI di release sono fuori scope per ora.

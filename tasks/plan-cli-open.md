# Piano: `work <cartella>` + installazione Linux

Spec: `SPEC-cli-open.md`. Due branch, in quest'ordine.

## Branch `cli-open-mac` (da `main`, verificato su macOS)

- [ ] **M1: `open_arg` + test**
  - Accettazione: funzione pura in `app.rs` con i 7 casi della spec coperti da test.
  - Verifica: `cargo test --manifest-path src-tauri/Cargo.toml open_arg`
  - File: `src-tauri/src/app.rs`
- [ ] **M2: cartella all'avvio**
  - Accettazione: `app_info` restituisce `open`; al boot il renderer apre `info.open` come tab attivo; senza argomento niente cambia.
  - Verifica: build debug, `src-tauri/target/debug/work /tmp/x` con `WORK_USER_DATA` temporaneo; `state.json` ha `/tmp/x` come `active`.
  - File: `src-tauri/src/app.rs`, `src/renderer/app.js`
- [ ] **M3: single-instance + `app:open`**
  - Accettazione: seconda istanza passa la cartella alla prima ed esce; la prima apre il tab, esce dallo stato minimizzato e prende il focus.
  - Verifica: due lanci della build debug; `pgrep -x work` = 1; `state.json` contiene entrambe le cartelle.
  - File: `src-tauri/Cargo.toml`, `src-tauri/src/main.rs`, `src/renderer/bridge.js`, `src/renderer/app.js`
  - Rischio: supporto macOS del plugin. Se manca, ripiego della spec (`open -na Work --args`) e si chiede prima di procedere.
- [ ] **M4: distacco dal terminale (solo release)**
  - Accettazione: da terminale il prompt torna subito; errore su cartella non valida con exit 1; `npm run dev` invariato.
  - Verifica: `npm run build`, poi i criteri 2–6 della spec con il binario in `Work.app`.
  - File: `src-tauri/src/main.rs`
- [ ] **M5: wrapper macOS + README**
  - Accettazione: comando nel README che installa il wrapper; criterio 7.
  - Verifica: installazione del wrapper, `work .` da una nuova shell, icona in dock.
  - File: `README.md`
- [ ] **Checkpoint Mac**: criteri 1–7 verificati, revisione con l'utente, push di `cli-open-mac` e PR.

## Branch `install-linux` (PR #2, sopra `cli-open-mac`, verificato in container)

- [ ] **L0: rebase della PR su `cli-open-mac`**
  - Chiedere prima: serve un force-push sul branch di Flavio.
- [ ] **L1: ambiente di prova Linux**
  - Accettazione: immagine Docker arm64 Ubuntu 24.04 con dipendenze Tauri (come `release.yml`), Node 22, Rust, Xvfb, Weston, `desktop-file-utils`. Dockerfile nello scratchpad, fuori dal repo.
  - Verifica: `npm test` verde nel container (criterio 8).
- [ ] **L2: correzioni all'installer**
  - Accettazione: controllo `uname`, via `rustup`, `Exec` tra virgolette; criteri 9 e 12.
  - Verifica: `npm run install:linux` nel container; `desktop-file-validate`; `bash scripts/install-linux.sh` su macOS esce con 1.
  - File: `scripts/install-linux.sh`
- [ ] **L3: app_id Wayland**
  - Accettazione: nome del file `.desktop` uguale all'app_id (criterio 11).
  - Verifica: Weston headless + `WAYLAND_DEBUG=1`, grep di `set_app_id`.
  - File: `scripts/install-linux.sh`
- [ ] **L4: `work .` su Linux**
  - Accettazione: criterio 10, su Xvfb e su Weston.
  - Verifica: script di prova nello scratchpad che lancia `work`, controlla `pgrep` e `state.json`.
- [ ] **Checkpoint Linux**: criteri 8–12, push della PR #2, richiesta a Flavio per il criterio 13.

## Rischi

- Plugin single-instance su macOS (M3): verificato subito, prima di M4.
- Il container è arm64: le prove non coprono x86_64, che però è l'architettura della release. Il codice non ha parti specifiche per architettura; la build x86_64 resta coperta da `release.yml`.
- Nessun desktop vero nel container: menu applicazioni e dock restano a Flavio (criterio 13).

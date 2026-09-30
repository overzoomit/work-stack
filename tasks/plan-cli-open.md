# Piano: `work <cartella>` + installazione Linux

Spec: `SPEC-cli-open.md`. Due branch, in quest'ordine.

## Branch `cli-open-mac` (da `main`, verificato su macOS)

- [x] **M1: `open_arg` + test**
  - Accettazione: funzione pura in `app.rs` con i 7 casi della spec coperti da test.
  - Verifica: `cargo test --manifest-path src-tauri/Cargo.toml open_arg`
  - File: `src-tauri/src/app.rs`
- [x] **M2: cartella all'avvio**
  - Accettazione: `app_info` restituisce `open`; al boot il renderer apre `info.open` come tab attivo; senza argomento niente cambia.
  - Verifica: build debug, `src-tauri/target/debug/work /tmp/x` con `WORK_USER_DATA` temporaneo; `state.json` ha `/tmp/x` come `active`.
  - File: `src-tauri/src/app.rs`, `src/renderer/app.js`
- [x] **M3: single-instance + `app:open`**
  - Accettazione: seconda istanza passa la cartella alla prima ed esce; la prima apre il tab, esce dallo stato minimizzato e prende il focus.
  - Verifica: due lanci della build debug; `pgrep -x work` = 1; `state.json` contiene entrambe le cartelle.
  - File: `src-tauri/Cargo.toml`, `src-tauri/src/main.rs`, `src/renderer/bridge.js`, `src/renderer/app.js`
  - Rischio: supporto macOS del plugin. Se manca, ripiego della spec (`open -na Work --args`) e si chiede prima di procedere.
- [x] **M4: distacco dal terminale (solo release)**
  - Accettazione: da terminale il prompt torna subito; errore su cartella non valida con exit 1; `npm run dev` invariato.
  - Verifica: `npm run build`, poi i criteri 2–6 della spec con il binario in `Work.app`.
  - File: `src-tauri/src/main.rs`
- [x] **M5: wrapper macOS + README**
  - Accettazione: comando nel README che installa il wrapper; criterio 7.
  - Verifica: installazione del wrapper, `work .` da una nuova shell, icona in dock.
  - File: `README.md`
- [ ] **Checkpoint Mac**: criteri 1–7 verificati, revisione con l'utente, push di `cli-open-mac` e PR.

## Branch `install-linux` (PR #2, sopra `cli-open-mac`, verificato su un PC Linux)

- [x] **L0: `cli-open-mac` dentro la PR**
  - Merge invece del rebase: nessuna riscrittura della storia di Flavio, push senza force.
- [x] **L1: ambiente di prova Linux**
  - Il container Docker sul Mac è saltato (disco pieno): le prove girano su un PC Linux vero, con `tasks/linux-check.sh`.
- [x] **L2: correzioni all'installer**
  - Controllo `uname`, via `rustup`, `Exec` tra virgolette. Su macOS lo script esce con 1 (verificato).
  - File: `scripts/install-linux.sh`
- [ ] **L3: app_id Wayland**
  - Tauri 2 non imposta l'app_id GTK (`enableGTKAppId` è false di default), quindi l'app_id atteso è il nome del binario, `work`, e `work.desktop` dovrebbe già andare bene.
  - Verifica: `tasks/linux-check.sh`, sezione 11. Se fallisce, rinominare il file `.desktop` come indicato.
- [ ] **L4: `work .` su Linux**
  - Verifica: `npm run install:linux && tasks/linux-check.sh` (criteri 8–11).
- [ ] **Checkpoint Linux**: criteri 8–12 verdi, controllo a occhio di icona nel menu e nella dock (criterio 13).

## Rischi

- Plugin single-instance su macOS (M3): verificato subito, prima di M4.

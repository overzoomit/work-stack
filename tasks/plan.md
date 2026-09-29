# Piano: Work su Tauri 2 (backend in Rust)

## Obiettivo
Portare il processo principale da Electron/Node a Rust con Tauri 2. L'interfaccia (`src/renderer/`)
resta com'è: cambia solo il ponte `window.work`. Risultato atteso: meno memoria (oggi 205–280 MB),
bundle da ~10 MB invece di ~150 MB, niente più `python3` per la PTY, installer per macOS e Linux.

## Decisioni
- **Tauri 2, niente bundler.** `withGlobalTauri: true`; `src/renderer/bridge.js` sostituisce
  `preload.js` ed espone lo stesso `window.work` (stessi nomi, stessi argomenti). Il renderer non cambia.
- **Librerie del renderer** (xterm, marked, dompurify) copiate in `src/renderer/vendor/` da
  `scripts/vendor.mjs` (gitignored, lanciato da `predev`/`prebuild`/`pretest`): Tauri incorpora solo
  `frontendDist`, e `../../node_modules` resterebbe fuori.
- **git resta la CLI** (config, hook, credenziali, firma dell'utente). Solo il wrapper passa in Rust.
- **PTY con `portable-pty`**: un thread di lettura per sessione, blocchi da 8 ms / 16 KB,
  controllo di flusso con `ack` (in unità UTF-16, come `string.length` in JS), UTF-8 spezzato gestito.
  Output tramite `tauri::ipc::Channel` (più veloce degli eventi per lo streaming).
- **Watcher con `notify`** (FSEvents / inotify), con la stessa logica di debounce di oggi.
- **Test**: `cargo test` per il backend (portando i casi di `test/*.test.js`); `npm test` resta per
  il renderer. I test JS del main vengono rimossi solo quando il loro modulo Rust è coperto.
- **Linux**: Ubuntu 22.04+ (webkit2gtk-4.1). **Deliverable**: installer non firmati (.dmg, .deb, .AppImage).
- **Stato**: al primo avvio si importa `state.json` dal profilo Electron (`<appData>/Work/`).

## Task

### Fase 1 — Fondamenta (rischio prima)
- [x] **T1: Scheletro Tauri + ponte + stato.** Rust installato, `src-tauri/` con finestra che carica il
  renderer, `bridge.js`, `vendor.mjs`; comandi `app:info`, `projects:load/save` (con import dal profilo
  Electron).
  - Accetta: `npm run dev` apre Work con la UI; `cargo test` verde (store, import); `npm test` verde.
    I progetti salvati compaiono dopo T3+T5 (il boot li valida con `fs.list` e `git.root`).
  - File: `package.json`, `src-tauri/*`, `src/renderer/bridge.js`, `src/renderer/index.html`,
    `scripts/vendor.mjs`, import in `terminals.js`/`preview.js`, `.gitignore`.
- [x] **T2: PTY in Rust.** create/write/resize/kill/ack/cwd, exit code (128+segnale), ambiente shell
  ripulito da `npm_*`, `TERM`/`COLORTERM`/`TERM_PROGRAM`, hang up alla chiusura.
  - Accetta: terminali e Run funzionano; `seq 1 1000000` non blocca la UI; casi di `pty.test.js` portati;
    drag & drop HTML5 interno (riordino terminali) funziona con il drag & drop nativo di Tauri attivo.
  - Dipende da: T1.

### Checkpoint A — terminali usabili su Tauri

### Fase 2 — Parità funzionale
- [x] **T3: git (letture).** root, status, log, branches, commit, containing, fileDiff.
  - Accetta: Modifiche, Graph e diff identici a Electron; casi di `git-repo`/`git-branch` portati. Dipende da: T1.
- [x] **T4: git (azioni) + watcher.** `action` (stage…revert, push/pull/checkout con le stesse regole),
  `watch/unwatch` con debounce 300 ms e tipo `index`/`full`, worktree collegati.
  - Accetta: casi di `git-repo` (azioni) e `gitwatch.test.js` portati. Dipende da: T3.
- [x] **T5: file system del Project.** list/read/create/rename/move/copyIn/trash/openPath/reveal con la
  guardia sui percorsi reali (symlink); percorsi dei file trascinati da fuori tramite l'evento drag & drop
  di Tauri (sostituisce `webUtils.getPathForFile`).
  - Accetta: casi di `fsops.test.js` portati, compresi quelli di regressione. Dipende da: T1.
- [x] **T6: Run configs.** `run:detect` (npm/pnpm/yarn/bun, Make, Cargo, Django, Go, Compose).
  - Accetta: casi di `runconfigs.test.js` portati. Dipende da: T1.

### Checkpoint B — terminali, git, albero e Run alla pari

- [x] **T7: Agenti.** Watcher dei `.jsonl` (lettura in coda, modo permessi all'indietro, stati),
  `~/.claude/sessions` (live/stop con SIGTERM → SIGKILL), `hasHistory`, `available`.
  - Accetta: casi di `agents.test.js` e `claudeprocs.test.js` portati. Dipende da: T1.
- [x] **T8: Finestra e sistema.** stats (`sysinfo`, RAM corretta su macOS), scelta cartella, appunti,
  `openExternal` solo http(s)/mailto, blocco della navigazione, menu macOS senza ⌘W, evento focus,
  versioni nella barra di stato (Tauri/WebView al posto di Electron/Chromium/Node).
  - Accetta: tutte le voci del README funzionano su Tauri. Dipende da: T1.

### Checkpoint C — parità completa, revisione con l'utente

### Fase 3 — Prodotto
- [x] **T9: Via Electron.** Rimuovi `src/main/`, `electron`, i test JS del main già portati; aggiorna README
  (avvio, requisiti, struttura, debug) e `evaluate.sh` se serve.
  - Accetta: `npm test` e `cargo test` verdi; nessun riferimento a Electron nel codice. Dipende da: T2–T8.
- [ ] **T10: Installer.** `npm run build` produce `.dmg` (macOS) e `.deb`/`.AppImage` (Linux, da compilare
  su Linux), icone da `assets/`.
  - Accetta: il `.dmg` si installa e si avvia da Finder (PATH del login shell per git e agenti). Dipende da: T9.
- [ ] **T11: Misure.** CPU a riposo, memoria (PSS/footprint), dimensione del bundle, `seq 1 1000000`;
  tabella nel README accanto ai numeri di Electron. Soglie in `SPEC.md` (criterio 5). Dipende da: T10.

### Checkpoint finale — pronto per la release

## Rischi
| Rischio | Impatto | Mitigazione |
|---|---|---|
| Il drag & drop nativo di Tauri blocca quello HTML5 interno | Alto | Verifica in T1; se serve `dragDropEnabled: false` e drop esterni solo da evento nativo |
| xterm più lento su WebKitGTK (Linux) | Medio | Misura in T11; renderer WebGL di xterm se serve |
| App avviata da Finder senza il PATH dell'utente | Medio | T10: leggere l'ambiente del login shell all'avvio |
| ⌘C/⌘V e appunti in WKWebView | Medio | T8: menu Modifica nativo + plugin clipboard |
| Installer non firmati: avviso di Gatekeeper | Basso | Documentato; firma e notarization fuori scope |

## Decisioni prese
- Nome e identificatore: Work, `it.overzoom.work`. Target e confini in `SPEC.md`.
- T9 (rimozione di Electron) procede in automatico quando T2–T8 sono verdi.

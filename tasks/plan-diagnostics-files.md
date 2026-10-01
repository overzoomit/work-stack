# Piano: diagnostica + ricerca e modifica dei file

Spec: `SPEC-diagnostics.md` (prima) e `SPEC-files.md` (dopo). I criteri di accettazione completi
stanno nelle spec; qui c'è l'ordine, il taglio e come verificare ogni passo.

## Decisioni
- **Prima la diagnostica.** Corregge due cause già confermate (✦ vuoto da Dock, permessi TCC) e il log
  serve poi anche per vedere come si comportano `fs_files`/`fs_grep` su progetti grandi.
- **Due branch, entrambi da `install-linux`** (14 commit non ancora in `main`, tra cui
  `detach_from_terminal` che `diag-log` tocca): `diagnostics`, poi `files`. Se `install-linux` entra in
  `main` prima, si parte da `main`.
- **Rischio prima**: in `diagnostics` la shell `-lic` (D2) viene subito dopo il logger, perché è la
  correzione che può bloccare l'avvio (rc che fa `exec tmux`, prompt che aspetta input). In `files` i
  comandi backend (F1, F2) precedono la palette, perché il limite dei 50 000 file e il timeout di
  `git grep` si misurano lì.
- **Nessuna dipendenza nuova** in nessuno dei due.
- Ogni task: `npm test`, `cargo clippy … -D warnings`, `cargo fmt` verdi; commit con
  `/conventional-commits`.

## Grafo delle dipendenze
```
D1 diag.rs ──┬── D2 -lic ──────────────┐
             ├── D3 log git ───────────┼── D7 ⋯ Linux + azioni nei toast
             ├── D4 log agenti         │
             ├── D5 watchdog/stalli ───┤
             └── D6 export + Aiuto ────┘── D8 README
D9 firma macOS (indipendente, ultima: serve l'utente per i secret)

F1 fs_files ── F3 palette File ── F5 rifiniture palette
F2 fs_grep  ── F4 palette Testo ─┘
E1 fs_read/fs_write ── E2 Modifica + Salva + guardia ── E3 conflitto
                                                    └── E4 vista .env
```

## Branch `diagnostics`

- [x] **D1: `diag.rs`, file di log e riga di avvio**
  - Accettazione: `diag::log(level, area, msg)` scrive su `work.log` (o `$WORK_USER_DATA/work.log`) e su
    stderr, nel formato della spec; rotazione oltre 5 MB in `work.log.1`; `DEBUG` solo con
    `WORK_DEBUG=1`; `debug_log` del renderer passa da `diag`; riga `INFO` di avvio con esito della shell
    di login (dal `OnceLock` scritto da `adopt_login_path`). Errori di scrittura ignorati.
  - Verifica: `cargo test --manifest-path src-tauri/Cargo.toml diag` (formato, rotazione, filtro DEBUG);
    `npm run dev` mostra la riga di avvio nel terminale e nel file.
  - File: `src-tauri/src/diag.rs` (nuovo), `src-tauri/src/main.rs`, `src-tauri/src/app.rs`
  - Scope: M
- [x] **D2: shell `-lic` con marcatore e ripiego (`fix-login-shell`)**
  - Accettazione: `login_path` e `available` usano `-lic`; `login_path` legge solo dopo
    `__WORK_PATH__`; se `-lic` fallisce o scade, `login_path` riprova con `-lc`; il log di avvio e di
    `available` dice quale ha funzionato, i ms, i CLI trovati e mancanti.
  - Verifica: test con shell finta (rumore prima del marcatore, `PATH` solo con `-i`; script che non
    termina → `-lc`); test `available` con CLI inesistente tra i mancanti; a mano
    `env -i HOME=$HOME USER=$USER SHELL=/bin/zsh <build>/work` → ✦ elenca Claude Code.
  - File: `src-tauri/src/app.rs`, `src-tauri/src/agents.rs`
  - Dipende da: D1 · Scope: S
- [x] **D3: log di git in `git_with`**
  - Accettazione: `DEBUG` per ogni chiamata (argomenti, cartella, exit, ms); `INFO` inizio/fine di
    `fetch`/`pull`/`push`; `WARN` su errore o oltre 10 s con le ultime 500 battute di stderr.
  - Verifica: test in `git.rs`, una chiamata fallita scrive `WARN` con exit e stderr; a mano un pull
    senza upstream lascia inizio e fine nel log.
  - File: `src-tauri/src/git.rs`
  - Dipende da: D1 · Scope: S
- [x] **D4: log degli agenti**
  - Accettazione: `INFO` all'avvio del watcher con `projects_dir`/`sessions_dir` ed errore di `notify`
    (non più scartato da `fsw.ok()`); `Msg::Fs(Err)` → `WARN`; scansione `INFO` la prima volta poi
    `DEBUG`; `has_history` `DEBUG` con cartella, nome codificato e numero di sessioni.
  - Verifica: `cargo test … agents` verde; `WORK_DEBUG=1 npm run dev`, aprire un progetto con e senza
    storia: righe `has_history` coerenti con il pulsante "Continua".
  - File: `src-tauri/src/agents.rs`
  - Dipende da: D1 · Scope: S
- [x] **D5: finestra congelata (watchdog, comandi lenti, stallo JS)**
  - Accettazione: thread watchdog con `run_on_main_thread`, una riga `main fermo` e una
    `main ripartito dopo N ms` per episodio, `diag:stalled` oltre 5 s; in `bridge.js` `call` misura le
    `invoke` (>2 s `WARN`, tranne `app_pick_folder`/`app_export_log`) e registra i rifiuti; intervallo
    da 1 s che segnala stalli >3 s solo con pagina visibile.
  - Verifica: comando di debug temporaneo che dorme 3 s sul main → esattamente le due righe; 6 s →
    anche l'evento. Il comando si toglie prima del commit.
  - File: `src-tauri/src/diag.rs`, `src-tauri/src/main.rs`, `src/renderer/bridge.js`
  - Dipende da: D1 · Scope: M
- [ ] **Checkpoint A**: build release installata e avviata da Dock; `work.log` ha la riga di avvio con
  `-lic ok`; ✦ pieno; nessun contenuto utente nel log (`grep` su output di terminale, commit,
  transcript). Revisione con l'utente.
- [x] **D6: esportazione + menu Aiuto (macOS)**
  - Accettazione: `app_export_log` (finestra nativa, nome `Work-log-AAAA-MM-GG-HHMM.txt`, intestazione,
    `work.log.1`, `work.log`, `null` se annullato, riga `INFO` prima); `app_reveal_export` senza
    argomenti; menu **Aiuto › Esporta log…** che esporta in Rust ed emette `log:exported`; toast
    "Log esportato" con "Mostra nel Finder"; errore → toast di errore.
  - Verifica: test di export (ordine intestazione / `.1` / file); a mano su macOS con JS bloccato da un
    `while(true)` in console: il menu esporta comunque.
  - File: `src-tauri/src/diag.rs`, `src-tauri/src/main.rs`, `src-tauri/src/app.rs`,
    `src/renderer/bridge.js`, `src/renderer/app.js`
  - Dipende da: D1 · Scope: M
- [x] **D7: ⋯ su Linux + "Esporta log" nei toast**
  - Accettazione: pulsante ⋯ (solo Linux) con `contextMenu`, una voce "Esporta log…", ancorato al
    bordo destro, tastiera come da spec; toast di `diag:stalled` con l'azione; i toast di errore di
    fetch/pull/push ricevono l'azione se non ne hanno una.
  - Verifica: `node --test` (menu con una sola voce, toast di `diag:stalled` con azione, toast di
    errore git con azione); a mano su Linux con `tasks/linux-check.sh`.
  - File: `src/renderer/index.html`, `src/renderer/app.js`, `src/renderer/gitpanel.js`, `test/*.test.mjs`
  - Dipende da: D5, D6 · Scope: M
- [x] **D8: README "Diagnostica"**
  - Accettazione: runbook in 4 punti della spec; cosa contiene il log e cosa no.
  - File: `README.md` · Dipende da: D6 · Scope: XS
- [ ] **D9: firma macOS stabile (`fix-mac-signing`)**
  - Accettazione: `hardenedRuntime: false`; `src-tauri/Info.plist` con i 5 testi; `release.yml` passa
    i 4 secret a `tauri-action`; senza `APPLE_SIGNING_IDENTITY` la build locale resta ad-hoc.
  - **Azione dell'utente**: esportare il .p12 e caricare i secret. Nessun certificato nel repo.
  - Verifica: build locale senza identità invariata; dopo la release del CI `codesign -dv` mostra
    `TeamIdentifier=DB54FSADPT` e `Identifier=it.overzoom.work`; un permesso resta alla release
    successiva.
  - File: `src-tauri/tauri.conf.json`, `src-tauri/Info.plist` (nuovo), `.github/workflows/release.yml`
  - Scope: S
- [ ] **Checkpoint B**: criteri di successo di `SPEC-diagnostics.md` verdi (tranne TCC tra due release,
  che si chiude dopo la seconda release firmata). Revisione, push di `diagnostics` e PR.

## Branch `files`

- [ ] **F1: `fs_files`**
  - Accettazione: con git, tracciati + nuovi + ignorati (solo file, cartelle ignorate escluse) meno i
    cancellati; senza git, visita senza symlink che salta la lista di cartelle; massimo 50 000 con
    `truncated`; passa da `guard`.
  - Verifica: `cargo test … fs_files` (repo con `.env` ignorato e `node_modules/`; cartella senza git;
    percorso fuori radice rifiutato).
  - File: `src-tauri/src/fsops.rs`, `src-tauri/src/main.rs`
  - Scope: S
- [ ] **F2: `fs_grep`**
  - Accettazione: letterale, smart case, `git grep -z -n --column -I --untracked -F`; ignorati e
    progetti senza git cercati in Rust (≤1 MB, binari saltati come `read`); 2000 risultati con
    `truncated`, righe a 300 caratteri, timeout 10 s; ignorati in fondo.
  - Verifica: `cargo test … fs_grep` (testo nel codice e nel `.env`, smart case, limite, binario,
    fuori radice).
  - File: `src-tauri/src/fsops.rs`, `src-tauri/src/main.rs`
  - Scope: M
- [ ] **F3: palette, modo File**
  - Accettazione: `⌘P` / `Ctrl/⌘+Shift+P` e il campo "Cerca in <progetto>" aprono la palette (non senza
    progetto); `fuzzy()` in ordine con punteggio e posizioni; primi 200; cache dell'elenco per
    progetto; `↑↓ ↵ esc`, combobox/listbox; materiale `.menu`. `↵` apre l'anteprima esistente.
  - Verifica: `test/search.test.mjs` (`envlo` → `.env.local` prima di `environment.loader.ts`, fuori
    ordine → niente, posizioni giuste); a mano su un progetto con `node_modules` pieno: apertura sotto
    100 ms, nessun ritardo ai tasti.
  - File: `src/renderer/search.js` (nuovo), `src/renderer/bridge.js`, `src/renderer/index.html`,
    `src/renderer/app.js`, `src/renderer/style.css`, `test/search.test.mjs`
  - Dipende da: F1 · Scope: M
- [ ] **F4: palette, modo Testo**
  - Accettazione: `Ctrl/⌘+Shift+F` e `⇥`; richieste dopo 120 ms con numero progressivo (vecchie
    scartate); gruppi per file; piè di pagina "Cerco…" / "N risultati in M file" / troncato; `↵` apre
    alla riga con `flash`; vuoto ed errori nella palette.
  - Verifica: test sulle risposte fuori ordine scartate; a mano `DATABASE_URL` trovato nel codice e nel
    `.env`.
  - File: `src/renderer/search.js`, `src/renderer/preview.js` (apertura alla riga), `test/search.test.mjs`
  - Dipende da: F2, F3 · Scope: S
- [ ] **F5: rifiniture della palette**
  - Accettazione: "Aperti di recente" (8, `localStorage` con `try/catch`); `⌘/Ctrl+↵` mostra nell'albero;
    selettore con indicatore che scorre; ingresso/uscita dal campo; movimento e trasparenza ridotti.
  - Verifica: a mano, anche con "Riduci movimento" attivo; `npm test` verde.
  - File: `src/renderer/search.js`, `src/renderer/style.css`
  - Dipende da: F4 · Scope: S
- [ ] **Checkpoint C**: criteri 1–4 di `SPEC-files.md`. Revisione con l'utente.
- [ ] **E1: `fs_read` con `mtime`/`utf8`, nuovo `fs_write`**
  - Accettazione: come da spec (`guard` con follow, solo file esistenti, ≤1 MB, `CHANGED` senza
    `force`, `fs::write` che tiene inode/permessi, commento `ponytail:` sulla non atomicità).
  - Verifica: `cargo test … fs_write` (scrive e dà `mtime`; `CHANGED`; `force`; resta `600`; fuori
    radice e cartella rifiutati).
  - File: `src-tauri/src/fsops.rs`, `src-tauri/src/main.rs`, `src/renderer/bridge.js`
  - Scope: S
- [ ] **E2: Modifica, Salva e guardia sulle modifiche non salvate**
  - Accettazione: "Modifica" solo per testo `utf8`; area monospace con numeri di riga; pallino nel
    titolo; Annulla / Salva ⌘S (disattivo senza modifiche); CRLF ripristinato; toast "salvato";
    `esc`/✕/clic fuori con modifiche → barra "Scarta / Continua a modificare". Niente `confirm()`.
  - Verifica: test su conversione CRLF e sulla guardia in `test/preview.test.mjs`; a mano modifica di
    un file, `⌘S`, albero e git aggiornati.
  - File: `src/renderer/preview.js`, `src/renderer/style.css`, `test/preview.test.mjs`
  - Dipende da: E1 · Scope: M
- [ ] **E3: conflitto su disco**
  - Accettazione: `CHANGED` → striscia con "Ricarica dal disco" e "Sovrascrivi"; modifiche tenute fino
    alla scelta; altri errori → toast, modifiche tenute.
  - Verifica: a mano, file cambiato da un terminale durante la modifica.
  - File: `src/renderer/preview.js`, `src/renderer/style.css`
  - Dipende da: E2 · Scope: S
- [ ] **E4: vista `.env` e piè dell'anteprima**
  - Accettazione: righe `NOME=valore` (anche `export`) colorate, commenti attenuati; valori visibili,
    occhio per riga, "Nascondi/Mostra valori" (non ricordato); piè con righe, byte, UTF-8, scorciatoia.
  - Verifica: test sul parsing (`export`, valori vuoti, commenti); a mano su un `.env` con permessi
    `600`: dopo il salvataggio ancora `600`.
  - File: `src/renderer/preview.js`, `src/renderer/style.css`, `test/preview.test.mjs`
  - Dipende da: E2 · Scope: S
- [ ] **E5: README "Cosa fa": Ricerca e Modifica** · File: `README.md` · Scope: XS
- [ ] **Checkpoint D**: tutti i criteri di `SPEC-files.md` verdi. Revisione, push di `files` e PR.

## Rischi
| Rischio | Impatto | Mitigazione |
|---|---|---|
| `-lic` blocca l'avvio con rc particolari (`exec tmux`, prompt di input) | Alto | Timeout 3 s già presente + ripiego `-lc`, coperti dal test con shell che non termina (D2) |
| Il watchdog stesso pesa sul main o produce rumore | Medio | Un no-op al secondo, una riga per episodio; criterio "<100 righe/ora" al Checkpoint A |
| Dati utente finiti nel log | Alto | Lista "Mai registrati" applicata in D3/D4/D5; `grep` al Checkpoint A |
| `git ls-files --ignored --directory` lento o enorme su repo grandi | Medio | Misura in F1 su un progetto con `node_modules`; limite 50 000 e `truncated` |
| `fs_write` non atomica | Basso | Accettato dalla spec, marcato `ponytail:` |
| Secret di firma non caricati | Blocca D9 | D9 per ultima e separata; il resto della PR non ne dipende |

## Domande aperte
- Base dei branch: `install-linux` (proposto) o `main` dopo il merge della PR #2?
- D9 può entrare nella stessa PR di `diagnostics` o preferisci una PR a parte, da unire quando i
  secret sono pronti?

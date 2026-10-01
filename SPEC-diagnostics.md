# Spec: diagnostica di Work e prime correzioni

## Obiettivo
Quando Work si comporta male nell'uso quotidiano, deve lasciare una traccia che dica **cosa** è successo,
**dove** e **quanto è durato**, e deve essere possibile esportarla dall'app. Le due cause già
confermate dall'analisi si correggono subito; i log servono anche a verificare che le correzioni
funzionino e a trovare le cause che restano.

Oggi l'app installata non registra niente: `debug_log` scrive su stderr, che in release finisce in
`/dev/null` (`detach_from_terminal`) o, se Work parte da Dock o dal menu, non arriva da nessuna parte.

Utente: chi sviluppa Work e lo usa ogni giorno: su macOS con il .dmg del CI avviato da Dock/Finder, e
su Linux.

Sintomi segnalati:
1. **Finestra congelata** (beachball), a volte, senza causa nota.
2. **Pull da interfaccia che non avviene**, senza errore visibile.
3. **Pannello Agenti vuoto** e **popover ✦ Agente vuoto**.
4. **"Continua" mostrato quando `claude --continue` non trova niente.**
5. **macOS: richieste di permesso (TCC) continue e non pertinenti; i permessi concessi non restano.**

## Mappa dei moduli
| Id | Responsabilità | Dipende da |
|---|---|---|
| `diag-log` | File di log, watchdog, log di git/agenti/renderer | — |
| `fix-login-shell` | Il `PATH` e i CLI si leggono anche dalla configurazione interattiva della shell | `diag-log` (per registrare l'esito) |
| `diag-export` | Esportazione del log: menu Aiuto (macOS), ⋯ (Linux), azione nei toast | `diag-log` |
| `fix-mac-signing` | Firma stabile dei .dmg del CI, testi dei permessi in Info.plist | — |

Ordine: `diag-log` → `fix-login-shell` → `diag-export` → `fix-mac-signing`.
`diag-log` va per primo, così il log registra lo stato prima e dopo ogni correzione. `fix-mac-signing`
va per ultimo perché richiede che l'utente carichi i secret su GitHub.

## Cause già confermate
- **✦ Agente vuoto da Dock.** `agents::available` e `app::adopt_login_path` usano `$SHELL -lc`, che non
  legge `~/.zshrc`. È lì che la configurazione aggiunge `nvm` e `~/.local/bin`. Prova, simulando
  l'avvio da Dock: `env -i HOME=$HOME USER=$USER SHELL=/bin/zsh /bin/zsh -lc 'command -v claude'` non
  trova niente; con `-lic` trova `~/.local/bin/claude`, in 0,4 s.
- **Permessi macOS che non restano.** `codesign -dv /Applications/Work.app` dà `Signature=adhoc`,
  `flags=adhoc,linker-signed`, `Identifier=work-68fa9bb8e92676f9`, `Info.plist=not bound`. TCC lega il
  permesso a questa identità, che cambia a ogni build: ogni aggiornamento ricomincia da zero. Le
  richieste nascono quando Work tocca Documenti, Scrivania, Download o altri volumi, oppure quando lo
  fa una shell o un `git` figlio, che TCC attribuisce a Work. Quali percorsi siano, lo dicono i log e
  il runbook TCC.

## Tech stack
Quello esistente (vedi `SPEC.md`): Tauri 2, Rust stable, renderer JS senza bundler.
**Nessuna dipendenza nuova.** L'ora locale si formatta con `libc::localtime_r` (`libc` è già presente).
La finestra di salvataggio usa `tauri-plugin-dialog`, "Mostra nel Finder" usa `tauri-plugin-opener`
(`reveal_item_in_dir`): entrambi sono già presenti.

## Comandi
```
Test:        npm test
Solo Rust:   cargo test --manifest-path src-tauri/Cargo.toml
Lint:        cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
Formato:     cargo fmt --manifest-path src-tauri/Cargo.toml
Dev verboso: WORK_DEBUG=1 npm run dev
Leggere log: tail -f ~/Library/Logs/it.overzoom.work/work.log          # macOS
             tail -f ~/.local/share/it.overzoom.work/logs/work.log     # Linux
Firma:       codesign -dv --verbose=2 /Applications/Work.app           # dopo fix-mac-signing
```

---

## Modulo `diag-log`

### Il file
- Percorso: `app.path().app_log_dir()/work.log`. Con `WORK_USER_DATA` impostato il file va in
  `$WORK_USER_DATA/work.log`, così i test non sporcano il profilo reale.
- All'avvio, se il file supera 5 MB, viene rinominato in `work.log.1` (una sola generazione).
- Livelli: `ERROR`, `WARN`, `INFO` sempre; `DEBUG` solo con `WORK_DEBUG=1`.
- Una riga per evento. Le righe successive di uno stack o di uno stderr sono indentate:
  ```
  2026-09-30 14:03:12.345 WARN  git      pull --ff-only in /Users/x/repo: exit 1 dopo 12034 ms: fatal: Not possible to fast-forward
  ```
- Ogni riga va anche su stderr, così `npm run dev` continua a mostrarla nel terminale.
- **Mai registrati**: output dei terminali, contenuto dei transcript di Claude, contenuto dei file,
  messaggi di commit, testo degli appunti, variabili d'ambiente diverse da `PATH`, `SHELL` e `TERM`.
  Di `SSH_AUTH_SOCK` si registra solo se è presente, non il valore.

### Avvio (area `app`)
Una riga `INFO` con versione, OS/arch, modo di avvio (terminale o no), `$SHELL`, esito della shell di
login (`ok` / `timeout` / `errore`, con i flag usati e i ms) e se `SSH_AUTH_SOCK` c'è. Una riga `DEBUG`
con il `PATH` finale. `adopt_login_path` gira prima del logger, quindi salva il suo esito in un
`OnceLock`; il logger lo scrive in `setup`.

### Finestra congelata (aree `main`, `ui`)
- **Watchdog del main thread (Rust).** Un thread, ogni secondo, esegue un no-op con `run_on_main_thread`.
  Se il no-op non gira entro 2 s scrive `WARN main fermo da 2 s`; alla ripresa,
  `WARN main ripartito dopo N ms`. Una riga per episodio, non una al secondo. Se l'episodio supera 5 s,
  alla ripresa emette anche l'evento `diag:stalled` con i ms (lo usa `diag-export`).
- **Comandi lenti e falliti (renderer, `bridge.js`).** Tutte le `invoke` passano da `call`, ed è lì che
  si misura la durata. Sopra 2 s scrive `WARN ui lento: <comando> N ms`, tranne `app_pick_folder` e
  `app_export_log`, che aspettano l'utente. Una `invoke` rifiutata scrive
  `WARN ui <comando> fallito: <messaggio>`. I comandi sincroni (`agents_list`, `agents_events`,
  `agents_has_history`, `app_stats`, `app_paste`, `projects_save`, `pty_*`, `git_watch`) girano sul main
  thread: se uno è lento, il watchdog e questa riga lo nominano insieme.
- **Stallo del JS.** Un `setInterval` da 1 s: se tra due giri passano più di 3 s con la pagina visibile,
  scrive `WARN ui renderer fermo N ms`. Con la pagina nascosta non registra niente, perché WebKit
  rallenta apposta i timer delle pagine nascoste.

### Git (area `git`), in `git_with`, unico punto da cui passano tutte le chiamate
- `DEBUG` per ogni chiamata: argomenti, cartella, exit, ms.
- `INFO` all'inizio e alla fine di `fetch`, `pull` e `push`. Un inizio senza fine vuol dire che il
  comando è appeso (es. `ssh` in attesa di una passphrase senza agent).
- `WARN` per ogni uscita con errore o durata oltre 10 s: argomenti, exit, ms, ultime 500 battute di
  stderr.

### Agenti (area `agents`)
- **Watcher, all'avvio**: `INFO` con `projects_dir` e `sessions_dir` (esistono? si leggono?) e con
  l'esito del watcher di file, compreso il testo dell'errore se fallisce (oggi `fsw.ok()` lo scarta).
- **Errori del watcher**: `Msg::Fs(Err(e))` scrive `WARN` invece di sparire.
- **Scansione completa**: `INFO` la prima volta, poi `DEBUG`: numero di cartelle progetto, di sessioni
  trovate, di file illeggibili o non analizzabili.
- **`available`** (popover ✦): `INFO` con shell, flag, ms, se è scattato il timeout di 8 s, CLI trovati e
  mancanti. `DEBUG` con il `PATH` visto da quella shell (riga con marcatore, vedi `fix-login-shell`).
- **`has_history`** ("Continua"): `DEBUG` con la cartella, il nome codificato e il numero di file di
  sessione trovati, da confrontare con quello che cerca `claude --continue`.

---

## Modulo `fix-login-shell`
- `login_path` e `available` lanciano la shell con `-lic` al posto di `-lc`, così leggono anche la
  configurazione interattiva (`~/.zshrc`, `~/.bashrc`). Il resto non cambia: stdin e stderr su
  `/dev/null`, e il timeout di 3 s (avvio) e di 8 s (`available`).
- Una shell interattiva può stampare testo suo (banner, prompt istantanei). Per questo `login_path`
  stampa `\n__WORK_PATH__$PATH` e prende solo quello che segue il marcatore. `available` filtra già
  le righe per nome esatto del CLI.
- Se `-lic` fallisce o scade (per esempio un rc che fa `exec tmux`), `login_path` riprova con `-lc`.
  Il log di avvio dice quale dei due ha funzionato.
- Vale per tutte le shell che accettano `-l -i -c` (zsh, bash, fish). Il comportamento da terminale
  non cambia: con `TERM` impostato `adopt_login_path` continua a non fare niente.

---

## Modulo `diag-export`

### Cosa produce
- Comando Rust `app_export_log`. Apre la finestra di salvataggio nativa con titolo "Esporta log di
  Work" e nome proposto `Work-log-AAAA-MM-GG-HHMM.txt`. Poi scrive una riga di intestazione (versione,
  OS, data di esportazione), `work.log.1` se esiste e `work.log`. Restituisce il percorso, oppure
  `null` se l'utente annulla.
- Prima di esportare scrive una riga `INFO app esportazione del log`, così nel file esportato c'è lo
  stato fino a quel momento.
- Comando `app_reveal_export`: mostra nel Finder o nel file manager **l'ultimo file esportato**, il cui
  percorso è tenuto nel backend. Il renderer non gli passa percorsi.
- La finestra di salvataggio è quella nativa: è l'utente a scegliere dove scrivere, quindi niente
  richieste TCC per Scrivania o Download.

### Dove si trova (familiarità: ogni piattaforma al suo posto)
- **macOS**: nuovo menu **Aiuto › Esporta log…**. Il gestore del menu chiama l'esportazione in Rust
  senza passare dal renderer, quindi funziona anche se il JS è bloccato. A fine esportazione emette
  `log:exported` per il toast.
- **Linux**: pulsante **⋯** nella barra in alto, a destra di `＋ Terminale` e prima di `toggle-panel`,
  con `title="Altro"`, `aria-haspopup="menu"` e `aria-expanded`. Apre un menu con una sola voce,
  **Esporta log…**, costruito con `contextMenu` di `ui.js`: lo stesso materiale, la stessa animazione
  `menu-in`/`menu-out` e lo stesso comportamento da tastiera dei menu contestuali. Il menu si apre sotto
  il pulsante, allineato al suo bordo destro, e cresce da quell'angolo (`transform-origin` sul
  pulsante). Su macOS il pulsante non c'è.
- **Nel momento giusto, su entrambe le piattaforme**, il toast che segnala il problema porta l'azione
  **Esporta log**:
  - dopo `diag:stalled`: toast "Work è rimasto bloccato per N s", con azione Esporta log;
  - quando `fetch`, `pull` o `push` falliscono: il toast di errore esistente riceve l'azione, se non ne
    ha già una.

### Comportamento (principi apple-design)
- **Risposta immediata**: il pulsante ⋯ si evidenzia su `pointerdown` e il menu si apre subito, come i
  menu di macOS. Niente attese artificiali.
- **Ellissi**: "Esporta log…" apre una finestra, quindi termina con "…" (convenzione HIG).
- **Feedback di completamento**: dopo il salvataggio, toast "Log esportato" con azione "Mostra nel
  Finder" (macOS) o "Mostra nella cartella" (Linux). Se l'utente annulla, niente toast. Se fallisce,
  toast di errore con il messaggio.
- **Responsabilità**: il log contiene percorsi di progetti e nomi di comandi, mai contenuti (vedi "Mai
  registrati"). Il README lo dice, così chi lo condivide sa cosa sta condividendo.
- **Tastiera**: Invio o Spazio aprono il menu, ↑↓ si muovono tra le voci, Esc chiude e riporta il focus
  sul pulsante.
- **Movimento ridotto e trasparenza ridotta**: valgono le regole già in `style.css` per `.menu` e
  `.toast`, senza stili nuovi.

---

## Modulo `fix-mac-signing`
- **Identità**: il certificato "Apple Development: Carmine Verde (2672R68522)" di Stasbranger srl, team
  `DB54FSADPT`, scade l'11/08/2027. La firma con un team rende stabile il requisito designato (team +
  `it.overzoom.work`), quindi TCC ricorda i permessi tra una release e l'altra.
- **CI** (`release.yml`, job macOS): `tauri-action` riceve dai secret `APPLE_CERTIFICATE` (.p12 in
  base64), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` e `KEYCHAIN_PASSWORD`. **L'utente
  esporta il .p12 e carica i secret**: il flusso non lo fa.
- **Build locale**: con `APPLE_SIGNING_IDENTITY` nell'ambiente firma con lo stesso certificato; senza,
  resta ad-hoc come oggi.
- `tauri.conf.json` → `bundle.macOS.hardenedRuntime: false`. Con un certificato Development non si può
  notarizzare, quindi il runtime rinforzato non serve e toglie rischi su shell e processi figli.
- `src-tauri/Info.plist` (Tauri 2 lo unisce al proprio) con i testi delle richieste:
  `NSDocumentsFolderUsageDescription`, `NSDesktopFolderUsageDescription`,
  `NSDownloadsFolderUsageDescription`, `NSRemovableVolumesUsageDescription` e
  `NSNetworkVolumesUsageDescription`. Il testo è uno solo: "Work apre i progetti, i terminali e git
  nelle cartelle che scegli."
- **Da sapere**: al primo avvio con la nuova firma macOS chiede i permessi un'ultima volta, perché
  l'identità è cambiata. Un .dmg scaricato resta non notarizzato: Gatekeeper lo tratta come oggi.

---

## Runbook (sezione "Diagnostica" nel README)
1. Riproduci il problema, poi **Aiuto › Esporta log…** (macOS) o **⋯ › Esporta log…** (Linux). Per il
   dettaglio, riavvia con `WORK_DEBUG=1`: da terminale `WORK_DEBUG=1 work .`, da Dock su macOS
   `launchctl setenv WORK_DEBUG 1` e poi riavvio.
2. **Finestra congelata e ancora bloccata**: `sample $(pgrep -x work) 5 -file ~/Desktop/work-sample.txt`
   (macOS) oppure `gdb -p $(pgrep -x work) -batch -ex 'thread apply all bt'` (Linux).
3. **Richieste di permesso su macOS**: mentre compaiono, in un altro terminale
   `log stream --info --predicate 'subsystem == "com.apple.TCC"' | grep -i -E 'work|AUTHREQ'`.
   Mostra il servizio (Documenti, Scrivania, Rete locale…) e il processo che lo chiede.
   `codesign -dv /Applications/Work.app` mostra l'identità con cui la richiesta è registrata.
4. **Simulare l'avvio da Dock**: `env -i HOME=$HOME USER=$USER SHELL=$SHELL $SHELL -lic 'command -v claude'`.

## Struttura
```
src-tauri/src/diag.rs       nuovo: init del file, log(level, area, msg), rotazione, watchdog, export
src-tauri/src/main.rs       mod diag; init e watchdog in setup; nuovi comandi
src-tauri/src/app.rs        debug_log verso diag; login_path con -lic e marcatore; menu Aiuto
src-tauri/src/git.rs        log in git_with; inizio e fine delle azioni di rete
src-tauri/src/agents.rs     log di watcher, scansione, available (-lic), has_history
src-tauri/Info.plist        nuovo: testi dei permessi macOS
src-tauri/tauri.conf.json   hardenedRuntime false
.github/workflows/release.yml   secret di firma per il job macOS
src/renderer/bridge.js      durata e fallimenti delle invoke; stallo del JS; work.app.exportLog/revealExport
src/renderer/index.html     pulsante ⋯ (nascosto su macOS)
src/renderer/app.js         menu ⋯, toast di diag:stalled e log:exported
src/renderer/gitpanel.js    azione Esporta log nei toast di errore di fetch/pull/push
README.md                   sezione "Diagnostica"
```

## Code style
Come il resto del backend: funzioni libere, commenti brevi sul *perché*, niente trait o builder.
```rust
// One line per event, to work.log and to stderr. DEBUG only with WORK_DEBUG=1.
pub fn log(level: Level, area: &str, msg: impl std::fmt::Display) {
    if level == Level::Debug && !debug_enabled() {
        return;
    }
    let line = format!("{} {:<5} {:<8} {}\n", now_local(), level, area, indent(&msg.to_string()));
    eprint!("{line}");
    if let Some(f) = FILE.get() {
        let _ = f.lock().unwrap().write_all(line.as_bytes());
    }
}
```
Un errore di scrittura sul log non deve mai far fallire il comando che sta registrando.

## Strategia di test
- `diag.rs`, unit test con `tempfile`: formato della riga (data, livello, area, indentazione);
  rotazione oltre 5 MB; `DEBUG` scartato senza `WORK_DEBUG`; il file esportato contiene intestazione,
  `work.log.1` e `work.log`, in quest'ordine.
- `app.rs`: `login_path` con una "shell" finta (script in una cartella temporanea) che imposta il `PATH`
  solo quando riceve `-i` e stampa rumore prima del marcatore: il risultato è il `PATH` interattivo,
  senza rumore. Con uno script che non termina mai, `login_path` ripiega su `-lc`.
- `git.rs`: una chiamata fallita scrive una riga `WARN` con exit e stderr.
- `agents.rs`: `available` con un CLI inesistente lo elenca tra i mancanti nel log.
- Renderer (`node --test`): il menu ⋯ ha una sola voce, "Esporta log…"; il toast di `diag:stalled`
  porta l'azione Esporta log.
- **Verifica manuale**:
  - watchdog: un comando temporaneo di debug che dorme 3 s sul main thread produce `main fermo` e
    `main ripartito`; dopo 6 s compare anche il toast. Il comando si toglie prima del commit;
  - ⋯ su Linux (con `tasks/linux-check.sh`) e menu Aiuto su macOS;
  - firma: dopo la release del CI, `codesign -dv` mostra `TeamIdentifier=DB54FSADPT` e
    `Identifier=it.overzoom.work`; un permesso concesso resta dopo aver installato la release
    successiva.
- `npm test`, clippy e fmt verdi prima di ogni commit.

## Boundaries
- **Sempre**: log su file e stderr insieme; nessun dato dell'utente nei log (vedi "Mai registrati");
  un errore del logger non interrompe mai il flusso che registra; commit con `/conventional-commits`.
- **Chiedere prima**: aggiungere dipendenze; altre voci nel menu ⋯ o nel menu Aiuto; cambiare timeout
  o soglie; qualunque passo che tocca certificati, portachiavi o secret di GitHub (li gestisce
  l'utente).
- **Mai**: registrare output dei terminali, transcript o credenziali; inviare log in rete; mettere
  certificati o password nel repository; togliere o indebolire test esistenti.

## Criteri di successo
- [ ] Con l'app installata e avviata da Dock o dal menu, `work.log` esiste e contiene la riga di avvio
      con l'esito della shell di login (`-lic ok`).
- [ ] Da Dock su macOS il popover ✦ elenca Claude Code, e il log di `available` lo mostra tra i
      trovati.
- [ ] Un blocco artificiale di 3 s sul main thread produce esattamente una riga `main fermo` e una
      `main ripartito dopo ~3000 ms`; uno di 6 s produce anche il toast con "Esporta log".
- [ ] Un `pull` fallito lascia nel log l'inizio e la fine, con exit e stderr; il toast di errore ha
      "Esporta log". Un `pull` appeso lascia solo l'inizio.
- [ ] Aiuto › Esporta log… (macOS) e ⋯ › Esporta log… (Linux) salvano un .txt dove sceglie l'utente;
      "Mostra nel Finder" o "Mostra nella cartella" lo evidenzia.
- [ ] Senza `WORK_DEBUG`, un'ora di uso normale produce meno di 100 righe; con `WORK_DEBUG=1`
      compaiono le chiamate git e i dettagli degli agenti.
- [ ] `grep` sul log dopo una sessione d'uso: nessun output di terminale, messaggio di commit o testo
      di transcript.
- [ ] La release del CI è firmata dal team `DB54FSADPT` e i permessi TCC restano tra due release.
- [ ] README con la sezione "Diagnostica".

## Domande aperte
- Nessuna sul comportamento. Per `fix-mac-signing` serve l'azione dell'utente: esportare il .p12 dal
  portachiavi e caricare i quattro secret su GitHub.

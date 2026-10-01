# Work

Terminali, git e agenti AI in un'unica dashboard desktop (Linux e macOS).

## Avvio

```bash
npm install
npm run dev                                  # apre nella cartella corrente
WORK_CWD=~/progetti/mio-repo npm run dev     # apre direttamente su un repository
npm run build                                # installer in src-tauri/target/release/bundle/
npm run install:linux                        # Linux: compila e installa in ~/.local (rilanciare dopo ogni aggiornamento)
```

Requisiti per compilare: Node 22+, Rust stable ([rustup](https://rustup.rs)), `git`. Su Linux servono anche
webkit2gtk-4.1 e le librerie di sviluppo di Tauri (Ubuntu 22.04 o più recente):
`sudo apt install libwebkit2gtk-4.1-dev build-essential libssl-dev libayatana-appindicator3-dev librsvg2-dev`.
L'app installata ha bisogno solo di `git`.

### Da terminale: `work .`

`work <cartella>` apre Work su quella cartella come progetto attivo (in una finestra già aperta, se c'è) e
restituisce subito il prompt; `work` senza argomenti riapre i progetti salvati. Con i pacchetti deb e rpm il
comando è già installato in `/usr/bin/work`, con `npm run install:linux` in `~/.local/bin/work`. Su macOS si aggiunge al PATH una volta sola:

```bash
sudo mkdir -p /usr/local/bin
printf '#!/bin/sh\nexec /Applications/Work.app/Contents/MacOS/work "$@"\n' | sudo tee /usr/local/bin/work >/dev/null
sudo chmod +x /usr/local/bin/work
```

Un wrapper e non un symlink: lanciato dal suo percorso reale, il binario trova il bundle (icona e nome nel Dock).

## Cosa fa

- **Multi-progetto**: ogni progetto è un tab in alto (`＋ Nuovo` per aprirne un altro) con i propri
  terminali, il proprio albero e il proprio stato git. I progetti aperti vengono ricordati.
- **Terminali multipli** in griglia automatica, ingrandibili, con la cartella corrente sempre visibile.
- **Project**: albero delle cartelle con colori git stile WebStorm (modificato, nuovo, non tracciato,
  ignorato). Tasto destro per creare, rinominare, spostare nel cestino, aprire un terminale;
  trascina per spostare (con "Annulla"). Anteprima dei file con doppio clic: **Markdown e HTML
  renderizzati** (Anteprima / Sorgente; l'HTML senza i suoi script, a meno di attivare "Esegui script" per quel file), gli altri con numeri di riga.
- **Ricerca** (`⌘P` su macOS, `Ctrl+Shift+P`, o il campo "Cerca in <progetto>" in alto): una palette sul
  progetto attivo con due modi, `⇥` passa dall'uno all'altro. **File** cerca per nome con un fuzzy match (a
  campo vuoto gli ultimi file aperti); **Testo** (`Ctrl+Shift+F`) cerca il testo letterale nei file, con le
  maiuscole che contano solo se la query ne ha, e apre l'anteprima alla riga trovata. I file ignorati come
  `.env` ci sono (segnati "ignorato"), le cartelle ignorate come `node_modules/` no. `↵` apre l'anteprima,
  `⌘/Ctrl+↵` mostra il file nell'albero.
- **Modifica** dall'anteprima, per i file di testo UTF-8: "Modifica", poi "Salva" (`⌘/Ctrl+S`). Il file resta
  com'è su disco (permessi, fine riga `\r\n`); se nel frattempo è cambiato, Work chiede se ricaricarlo o
  sovrascriverlo, e chiudere con modifiche non salvate chiede prima di scartarle. Nei `.env` i valori sono
  visibili; l'occhio su una riga o "Nascondi valori" li coprono.
- **Git**: stage/unstage, scarta, commit (anche amend), branch, checkout, fetch/pull/push, stash.
  **Graph** di tutti i branch; il dettaglio di un commit mostra messaggio, autore, branch che lo
  contengono, l'albero dei file cambiati con +/− e il **diff affiancato** (o unificato) con le
  parole modificate evidenziate. Lo stesso viewer si apre dai file in "Modifiche".
- **Agenti**: legge in tempo reale le sessioni di Claude Code (`~/.claude/projects/*/*.jsonl`) e mostra
  cosa sta facendo ogni agente (prima quelli del progetto attivo), con "Riprendi sessione". Da
  `~/.claude/sessions/<pid>.json` sa quali sessioni hanno ancora il processo aperto: quelle chiuse risultano
  "Chiusa", quelle aperte hanno "Chiudi sessione" (dettaglio e tasto destro), che dopo una conferma termina
  il processo di Claude Code (SIGTERM, poi SIGKILL dopo 3 s). La conversazione resta riprendibile.
- **Run** (in alto a destra, come in WebStorm): rileva da solo i comandi del progetto (script npm/pnpm/yarn,
  target Make, Cargo, Django, Go, Docker Compose) e permette di aggiungerne di propri. ▶ avvia, ↻ riavvia,
  ■ ferma (con Ctrl+C, poi forzato dopo 3 s). Il processo gira in background, senza aprire terminali: il suo
  output è nel tab **Run** del pannello destro ("Mostra output"); se stampa un indirizzo locale compare un chip
  per aprirlo nel browser. Il tab del progetto mostra ▶ mentre qualcosa gira.
- **✦ Agente**: popover con gli agenti CLI installati (Claude Code, Codex, Gemini CLI, Copilot CLI, OpenCode,
  Aider, Cursor Agent, Amp, Qwen Code, Goose); tastiera ↑↓ / Invio / 1–9. Accanto al nome, un flag
  **bypass** (clic o tasto B) fa partire l'agente senza richieste di conferma, con l'opzione di quel CLI
  (`--dangerously-skip-permissions` per Claude Code, `--yolo` per Gemini/Qwen, ecc.; etichetta "bypass
  permessi" sul pannello). È ricordato per agente: acceso di default solo per Claude Code. Claude Code ha
  anche "Continua"; "Riprendi sessione" segue lo stesso flag. Gli agenti mancanti hanno "Installa", che
  scrive il comando in un terminale senza eseguirlo.
- **Aspetto del terminale** (pulsante "Aa" su ogni terminale): profili nello stile di Terminal.app (Basic
  chiaro/scuro, Pro, Homebrew, Ocean, Grass, Red Sands, Silver Aerogel, Clear Dark) oltre a Work; passando
  sopra un tema lo si prova dal vivo. Dimensione del testo (anche Ctrl + / − / 0), forma e lampeggio del cursore.
- **Spostare e ridimensionare**: trascina l'intestazione di un terminale per riordinarlo nella griglia (o
  rilascialo sul tab di un altro progetto per spostarlo lì, con "Annulla"); doppio clic sull'intestazione per
  ingrandirlo. Trascina i tab dei progetti per riordinarli. Trascina i bordi delle colonne laterali per
  ridimensionarle (doppio clic per la larghezza predefinita).
- **Tasto destro** dove serve: terminali (copia/incolla, rinomina, nuovo nella stessa cartella, sposta in un
  progetto…), tab dei progetti, sessioni agenti, file in Modifiche (stage, anteprima, mostra nell'albero,
  scarta), commit del graph (checkout, branch, cherry-pick, revert, copia hash), albero dei file, area vuota.
- **Pannelli nascondibili**: il pulsante nell'intestazione di "Terminali" chiude la colonna sinistra, quello a
  destra dei tab chiude il pannello destro. Da chiusi, i pulsanti per riaprirli compaiono in alto con lo stato
  degli agenti (sinistra) o un pallino se ci sono modifiche git (destra).
- **↻ Aggiorna** (F5) ricarica albero, git e comandi rilevati.

## Rilascio e aggiornamenti

Work si aggiorna da solo: controlla `latest.json` nell'ultima release di GitHub e, se c'è una versione più
nuova, lo dice e la installa con un clic. I pacchetti devono essere firmati con una chiave nostra; la chiave
pubblica sta in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`), quella privata non entra mai nel repository.

Una volta sola, per attivare gli aggiornamenti:

```bash
npx tauri signer generate -w ~/.tauri/work-updater.key     # crea la chiave (e chiede una password)
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/work-updater.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD           # la password scelta; vuota se non ne hai messa una
```

I due secret si possono caricare anche dal tab GitHub di Work (Secrets › Nuovo secret; per la chiave, incolla il
contenuto del file). Con una nuova chiave, la pubkey in `tauri.conf.json` va aggiornata e le versioni già
installate non si aggiornano più da sole: vanno reinstallate a mano.

Senza i secret il workflow di rilascio funziona lo stesso, ma non produce `latest.json`: nessun aggiornamento
viene proposto. Per provare i pacchetti di aggiornamento in locale:

```bash
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/work-updater.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD=... \
  npm run build -- --config src-tauri/updater.conf.json
```

Su Linux l'installazione automatica funziona solo dall'AppImage; con `.deb` e `.rpm` Work avvisa e apre la pagina
della release. Le build di sviluppo (`npm run dev`) non controllano gli aggiornamenti.

## Test

```bash
npm test
```

Due parti: il test runner integrato di Node per l'interfaccia (diff e allineamento delle righe, layout del
graph, albero, pannelli) e `cargo test` per il backend in Rust: letture e azioni git (su repository temporanei
reali), protezione dei percorsi del Project tree (symlink compresi), watcher delle sessioni agenti, PTY e
rilevamento dei comandi Run. I test marcati "regressione" falliscono sul codice precedente alle
rispettive correzioni. L'interfaccia (DOM, drag, menu) si verifica avviando l'app.

## Scorciatoie

| Tasti | Azione |
|---|---|
| Shift+F10 | Avvia la configurazione selezionata |
| Ctrl+F5 | Riavvia |
| Ctrl+F2 | Ferma |
| F5 | Aggiorna albero e git |
| ⌘P (macOS) / Ctrl+Shift+P | Cerca un file nel progetto |
| Ctrl+Shift+F | Cerca un testo nel progetto |
| ⌘S / Ctrl+S | Salva il file in modifica |
| Ctrl+Shift+O | Apri un altro progetto |
| Ctrl+Shift+B | Mostra/nascondi la colonna terminali e sessioni |
| Ctrl+Alt+B | Mostra/nascondi il pannello Project / Modifiche / Graph / Agente |
| Ctrl+Shift+T | Nuovo terminale |
| Ctrl+Shift+A | Avvia l'ultimo agente usato (il pulsante ✦ Agente apre la lista) |
| Ctrl+Shift+W | Chiudi terminale |
| Ctrl+Shift+M | Ingrandisci/riduci terminale |
| Ctrl+= / Ctrl+− / Ctrl+0 | Testo del terminale più grande / più piccolo / predefinito |
| Ctrl+Shift+C / Ctrl+Shift+V | Copia / incolla nel terminale |
| Ctrl+Invio | Commit |
| F7 / Shift+F7 | Modifica successiva/precedente nel diff |
| ↑ / ↓ | File precedente/successivo nel diff |
| F2 / Canc / Invio | Rinomina / cestino / apri (albero) |

## Struttura

```
src-tauri/        backend in Rust (Tauri 2)
  src/main.rs    avvio e collegamento dei comandi
  src/diag.rs    file di log, watchdog del main thread, esportazione del log
  src/app.rs     finestra, menu, comandi di sistema (appunti, cartelle, link)
  src/pty.rs     sessioni terminale (portable-pty), con controllo di flusso
  src/git.rs     operazioni git tramite la CLI
  src/gitwatch.rs  watcher della cartella .git
  src/agents.rs  watcher delle sessioni Claude Code (claudeprocs.rs: processi aperti)
  src/fsops.rs   operazioni sui file, limitate alle cartelle dei progetti aperti
  src/store.rs   progetti salvati tra un avvio e l'altro
  src/runconfigs.rs  rilevamento dei comandi avviabili
src/renderer/    interfaccia (HTML/CSS/JS, xterm.js)
  bridge.js      window.work sopra l'IPC di Tauri
  app.js         progetti e collegamento tra i moduli
  terminals.js   pannelli terminale per progetto
  tree.js        albero Project
  gitpanel.js    modifiche, branch, graph
  review.js      dettaglio commit / modifiche (stile WebStorm)
  diff.js        diff affiancato e unificato
  preview.js     anteprima file, Markdown e HTML, modifica
  search.js      palette di ricerca (file e testo)
  run.js         configurazioni Run (avvia / riavvia / ferma)
  launcher.js    menu ✦ Agente
  themes.js      profili colore del terminale
  appearance.js  popover "Aa" (tema, dimensione, cursore)
```

## Debug

- `WORK_DEVTOOLS=1 npm run dev` apre i DevTools.
- `WORK_EVAL='…'` esegue uno snippet nella pagina dopo l'avvio e scrive il risultato nel log, area `ui` (utile
  per test automatici). Errori e warning della pagina finiscono nel log e sul terminale che ha avviato Work.
- `WORK_USER_DATA=/tmp/work-test` usa un profilo separato (i progetti salvati non vengono toccati).
- `performance.getEntriesByName('work:ready')` dà il momento in cui l'avvio è completo.

## Diagnostica

Work scrive un log, una riga per evento, in `~/Library/Logs/it.overzoom.work/work.log` (macOS) o
`~/.local/share/it.overzoom.work/logs/work.log` (Linux); con `WORK_USER_DATA` impostato, in
`$WORK_USER_DATA/work.log`. Oltre 5 MB, all'avvio diventa `work.log.1`. Le stesse righe vanno su stderr.

**Cosa contiene**: la riga di avvio (versione, sistema, `SHELL`, esito della shell di login, se
`SSH_AUTH_SOCK` c'è), i blocchi del main thread e del JS, i comandi lenti o falliti, i comandi git (con
`WORK_DEBUG=1` tutti, altrimenti inizio e fine di fetch/pull/push e gli errori, con la coda di stderr), lo
stato del watcher degli agenti e quali CLI degli agenti sono installati. Contiene percorsi di progetti e
nomi di comandi. **Non contiene mai** l'output dei terminali, i transcript di Claude, il contenuto dei file,
i messaggi di commit, il testo degli appunti né variabili d'ambiente diverse da `PATH`, `SHELL` e `TERM`.
Chi lo condivide sa quindi cosa sta condividendo: cartelle e comandi, non contenuti.

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

## Prestazioni

Tutto il lavoro in background è guidato da eventi, non da polling:
- sessioni degli agenti: watcher (FSEvents / inotify) sui file `.jsonl` (più un controllo completo ogni 60 s);
- stato git: watcher sulla cartella `.git` più un aggiornamento dopo l'output dei terminali (al massimo ogni 2,5 s
  per progetto, uno alla volta); uno stage aggiorna solo lo stato, commit/checkout/fetch anche rami e graph;
  la scansione dei file ignorati e il graph (solo con il suo tab aperto) girano solo negli aggiornamenti completi;
  un controllo di sicurezza ogni 20 s (progetto attivo) / 60 s (altri progetti);
- cartella corrente dei terminali: letta solo per le shell, dopo che hanno prodotto output, senza bloccare il processo principale.

L'output dei terminali viaggia in blocchi (ogni 8 ms o 16 KB) con controllo di flusso: se xterm resta indietro
di oltre 1 MB la shell viene messa in pausa. La lista degli agenti viene inviata senza eventi (la timeline si
chiede solo per la sessione selezionata). Diff e anteprime di file grandi vengono inseriti a blocchi, e i blocchi
fuori schermo non vengono impaginati.

Nell'interfaccia non ci sono animazioni in loop, e la sfocatura (`backdrop-filter`) è usata solo per menu e
popover temporanei; le liste vengono ridisegnate solo quando il contenuto cambia.

Misure della versione Electron su Ubuntu 20.04 (Intel UHD 630), un progetto e un terminale aperti:

| | CPU a riposo | Memoria reale (PSS) |
|---|---|---|
| Prima delle ottimizzazioni | ~33% (processo GPU 26%) | ~314 MB |
| Dopo | ~0,5% | ~205–280 MB |


Dopo l'audit delle prestazioni (stessa macchina):

| Scenario | Prima | Dopo |
|---|---|---|
| 3 terminali che stampano per 12 s: `git status` / `ls-files --ignored` / `pgrep` | 28 / 28 / 25 | 12 / 2 / 3 |
| Trascinamento splitter / apri-chiudi pannello con 4 terminali: `fit()` | 156 / 140 | 4 / 8 |
| `seq 1 1000000` (7,9 MB): messaggi IPC | ~6.000 | ~400 |
| Aggiornamento lista agenti (22 sessioni) | 98 KB | 5,5 KB |
| Diff di un file nuovo da 20.000 righe: primo disegno / task più lungo | 1.335 / 1.305 ms | 167 / <50 ms |
| Anteprima sorgente da 38.000 righe: task più lungo | 897 ms | <50 ms |

### Tauri al posto di Electron

MacBook Air M4 (16 GB, macOS 26.6), stessa macchina e stesso codice dell'interfaccia; profilo nuovo, un progetto e un
terminale aperti, 25 s dopo l'avvio. Memoria: `footprint` di tutti i processi dell'app (per Tauri: Work e i processi
WebKit che avvia); mediana di 3 avvii. CPU: `top`, somma dei processi, media di 4 campioni da 2 s.

| | Electron 44 | Tauri 2 |
|---|---|---|
| Memoria (footprint) | ~295 MB (201–299) | ~175 MB (111–203) |
| CPU a riposo | 0,25–5,75% | 0–3,5% |
| App installata | 288 MB (Electron.app) | 7,4 MB (Work.app), .dmg da 3,5 MB |
| `seq 1 1000000`: frame più lungo | 33 ms | 32–36 ms |
| Dipendenze a runtime | Node, `python3`, `git` | `git` |

La CPU a riposo oscilla con il resto della macchina (misure fatte con altre app aperte). Su Linux WebKitGTK
va misurato a parte.

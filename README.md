# Work

Terminali, git e agenti AI in un'unica dashboard desktop (Linux e macOS).

## Avvio

```bash
npm install
npm start                                  # apre nella cartella corrente
WORK_CWD=~/progetti/mio-repo npm start     # apre direttamente su un repository
```

Requisiti: Node 20+, `git`, `python3` (usato per la PTY, presente di serie su Linux e macOS).

## Cosa fa

- **Multi-progetto**: ogni progetto è un tab in alto (`＋ Nuovo` per aprirne un altro) con i propri
  terminali, il proprio albero e il proprio stato git. I progetti aperti vengono ricordati.
- **Terminali multipli** in griglia automatica, ingrandibili, con la cartella corrente sempre visibile.
- **Project**: albero delle cartelle con colori git stile WebStorm (modificato, nuovo, non tracciato,
  ignorato). Tasto destro per creare, rinominare, spostare nel cestino, aprire un terminale;
  trascina per spostare (con "Annulla"). Anteprima dei file con doppio clic: **Markdown e HTML
  renderizzati** (Anteprima / Sorgente), gli altri con numeri di riga.
- **Git**: stage/unstage, scarta, commit (anche amend), branch, checkout, fetch/pull/push, stash.
  **Graph** di tutti i branch; il dettaglio di un commit mostra messaggio, autore, branch che lo
  contengono, l'albero dei file cambiati con +/− e il **diff affiancato** (o unificato) con le
  parole modificate evidenziate. Lo stesso viewer si apre dai file in "Modifiche".
- **Agenti**: legge in tempo reale le sessioni di Claude Code (`~/.claude/projects/*/*.jsonl`) e mostra
  cosa sta facendo ogni agente (prima quelli del progetto attivo), con "Riprendi sessione".
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

## Test

```bash
npm test
```

Usa il test runner integrato di Node (nessuna dipendenza). Copre la logica senza interfaccia:
diff e allineamento delle righe, layout del graph, letture git (su repository temporanei reali),
protezione dei percorsi del Project tree (symlink compresi), watcher delle sessioni agenti, PTY e
rilevamento dei comandi Run. I test marcati "regressione" falliscono sul codice precedente alle
rispettive correzioni. L'interfaccia (DOM, drag, menu) si verifica avviando l'app.

## Scorciatoie

| Tasti | Azione |
|---|---|
| Shift+F10 | Avvia la configurazione selezionata |
| Ctrl+F5 | Riavvia |
| Ctrl+F2 | Ferma |
| F5 | Aggiorna albero e git |
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
src/main/        processo principale (Electron)
  pty-helper.py  ponte PTY in Python (niente moduli nativi da compilare)
  pty.js         gestione delle sessioni terminale
  git.js         operazioni git tramite la CLI
  agents.js      watcher delle sessioni Claude Code
  fsops.js       operazioni sui file, limitate alle cartelle dei progetti aperti
  store.js       progetti salvati tra un avvio e l'altro
  runconfigs.js  rilevamento dei comandi avviabili
src/renderer/    interfaccia (HTML/CSS/JS, xterm.js)
  app.js         progetti e collegamento tra i moduli
  terminals.js   pannelli terminale per progetto
  tree.js        albero Project
  gitpanel.js    modifiche, branch, graph
  review.js      dettaglio commit / modifiche (stile WebStorm)
  diff.js        diff affiancato e unificato
  preview.js     anteprima file, Markdown e HTML
  run.js         configurazioni Run (avvia / riavvia / ferma)
  launcher.js    menu ✦ Agente
  themes.js      profili colore del terminale
  appearance.js  popover "Aa" (tema, dimensione, cursore)
```

## Debug

- `WORK_DEVTOOLS=1` apre i DevTools.
- `WORK_SCREENSHOT=/tmp/x.png` salva uno screenshot pochi secondi dopo l'avvio.
- `WORK_EVAL='…'` esegue uno snippet nella pagina dopo l'avvio (utile per test automatici).
- `WORK_USER_DATA=/tmp/work-test` usa un profilo separato (i progetti salvati non vengono toccati).
- `performance.getEntriesByName('work:ready')` dà il momento in cui l'avvio è completo.

## Prestazioni

Tutto il lavoro in background è guidato da eventi, non da polling:
- sessioni degli agenti: `fs.watch` sui file `.jsonl` (più un controllo completo ogni 60 s);
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

Misure su Ubuntu 20.04 (Intel UHD 630), un progetto e un terminale aperti:

| | CPU a riposo | Memoria reale (PSS) |
|---|---|---|
| Prima delle ottimizzazioni | ~33% (processo GPU 26%) | ~314 MB |
| Dopo | ~0,5% | ~205–280 MB |

La memoria di base è quella di Electron; per scendere molto sotto servirebbe passare a Tauri.

Dopo l'audit delle prestazioni (stessa macchina):

| Scenario | Prima | Dopo |
|---|---|---|
| 3 terminali che stampano per 12 s: `git status` / `ls-files --ignored` / `pgrep` | 28 / 28 / 25 | 12 / 2 / 3 |
| Trascinamento splitter / apri-chiudi pannello con 4 terminali: `fit()` | 156 / 140 | 4 / 8 |
| `seq 1 1000000` (7,9 MB): messaggi IPC | ~6.000 | ~400 |
| Aggiornamento lista agenti (22 sessioni) | 98 KB | 5,5 KB |
| Diff di un file nuovo da 20.000 righe: primo disegno / task più lungo | 1.335 / 1.305 ms | 167 / <50 ms |
| Anteprima sorgente da 38.000 righe: task più lungo | 897 ms | <50 ms |

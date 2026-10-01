# Piano: agenti a sinistra, pannello GitHub, aggiornamenti dell'app

Spec: `SPEC-github-update.md` (approvata). Prototipo: variante C. Lista delle task: `tasks/todo.md`.
Il piano precedente (migrazione Tauri) era chiuso; resta nella storia di git.

## Obiettivo
Il tab Agente del pannello destro sparisce e le sue azioni passano sulla riga della sessione. Al suo posto
arriva il tab GitHub (Actions, Secrets, Artifacts, tramite `gh`). Work si aggiorna da solo con avviso e
installazione al clic.

## Cosa ho trovato nel codice
- `agentsview.js` (165 righe): la riga è un `<li>` con `onpointerdown`; `selected` esiste già, quindi
  l'espansione sopravvive a `setAgents` senza altro.
- `agents_events` è usato solo da `renderAgentDetail`. In Rust `AgentWatcher::events` serve anche ai test
  (`agents.rs` ~1024, ~1068), e `Session.events` alimenta stato e filtro delle sessioni. Si tolgono comando,
  ponte e metodo pubblico; i dati interni restano. `eventSeq` resta nel JSON (un test ne fissa le chiavi).
- `git_with` (`git.rs:68`) è il modello per `gh`: log di comando, durata, esito; `input` via stdin senza log
  dell'errore. `fsops::Roots` è il controllo "solo progetti aperti".
- `adopt_login_path` (`app.rs:81`) dà già a `gh` il `PATH` della shell di login.
- `#more` e `moreMenu` esistono già su tutte le piattaforme. Il menu macOS è `mac_menu` in `app.rs`
  (aggiungere "Controlla aggiornamenti…" nel menu Work).
- Le preferenze di pannello stanno in `localStorage` (`work.panel`, `work.*`), **non** in `state.json`.
  La spec dice `state.json`: vedi domande aperte.
- `release.yml` ha due step `tauri-action` (con e senza firma macOS): le variabili di firma
  dell'updater vanno in entrambi.

## Grafo delle dipendenze
```
T1 righe espandibili ─ T2 via tab Agente ─┐
                                          ├─ T3 gh + tab GitHub (stati) ─ T4 Actions lista ─ T5 Actions azioni
                                          │                              └─ T6 Secrets (+ controllo segmentato)
                                          │                              └─ T7 Artifacts
T8 rilascio firmato ─ T9 avviso + popover ─ T10 installa + riavvia      (indipendente da T1-T7)
```
T6 e T7 dipendono solo da T3 (T6 introduce il controllo segmentato, T7 lo riusa). T8-T10 si possono fare in
parallelo a tutto il resto, in una sessione o un worktree a parte.

## Decisioni di piano
- Fette verticali: ogni task lascia l'app funzionante e portabile in un commit (o pochi).
- Rust: logica pura (parsing, validazione, riga di log) in funzioni testabili, separata dall'esecuzione.
- Una sola funzione esegue `gh`; nessun comando passa dagli argomenti per il valore di un secret.
- Prima la parte a rischio: T3 (esecuzione di `gh`, stati vuoti) e T8 (chiave e plugin updater).
- Commit con `/conventional-commits`, micro commit per task.

## Fasi

### Fase 1: agenti a sinistra (T1-T2)
Fette: T1 comportamento nuovo, T2 rimozione del vecchio. Dopo la fase il pannello destro non ha il tab Agente.

### Checkpoint A
`npm test`, clippy e fmt verdi; clic e tastiera sulle righe verificati con `npm run dev`; revisione con l'utente.

### Fase 2: pannello GitHub (T3-T7)
T3 porta `gh` e il tab con gli stati vuoti. T4-T5 Actions, T6 Secrets, T7 Artifacts.

### Checkpoint B
Su `work-stack` reale: run, riesecuzione, secret di prova, artifact. Senza `gh` e dopo `gh auth logout`.

### Fase 3: aggiornamenti (T8-T10)
T8 rilascio firmato, T9 avviso, T10 installazione e riavvio.

### Checkpoint finale
Tutti i criteri di successo della spec, README aggiornato, aggiornamento 1.1.x → release di prova su
macOS e AppImage.

## Rischi
| Rischio | Impatto | Mitigazione |
|---|---|---|
| Forma del JSON di `gh` diversa tra versioni | Media | Parsing tollerante (campi mancanti = default), fixture da `gh` ≥ 2.40, controllo versione in `gh_status` |
| `gh run download -n` con cartella di destinazione già piena | Bassa | Scaricare in `<dir>/<name>`; errore chiaro se esiste |
| Secret su più righe (certificato) via stdin | Media | Test di `gh_with_stdin` con valore multi-riga, nessuna interpolazione in shell |
| Valore del secret in un log o errore | Alta | Riga di log composta da una funzione testata; stderr di `secret set` non loggato (come i commit in `git_with`) |
| Plugin updater senza chiave pubblica non parte | Alta | T8 si ferma finché l'utente non genera la chiave; la pubkey va in `tauri.conf.json` |
| Aggiornamento verificabile solo con una release firmata | Alta | Release di prova (prerelease) con una versione maggiore; build di sviluppo non controlla |
| `.deb`/`.rpm`: `$APPIMAGE` assente | Media | `canInstall` falso, solo avviso e "Scarica" |
| Togliere `agents_events` rompe test o il watcher | Bassa | Grep prima di cancellare; i dati interni restano |

## Domande aperte
1. **Preferenza del segmento GitHub per progetto:** la spec dice `state.json`, ma le preferenze di pannello
   oggi sono in `localStorage`. Proposta: `localStorage` con chiave per percorso del progetto, come il resto.
   Passare a `state.json` richiede di estendere `store::merge`.
2. **Chiave dell'updater:** la genera l'utente (`npx tauri signer generate -w ~/.tauri/work-updater.key`)
   prima di T8; serve la chiave pubblica nel repo e i due secret nel repository.
3. **Verifica dell'aggiornamento:** una prerelease di prova firmata (es. `v1.1.1-test`) va bene, o serve un
   endpoint locale?
4. Le cinque domande aperte della spec restano rinviate: solo tre sezioni, niente log dei job, workflow con i
   default, solo secret del repository, `.deb`/`.rpm` solo avviso.

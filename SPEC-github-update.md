# Spec: agenti a sinistra, pannello GitHub, aggiornamenti dell'app

## Obiettivo
Tre cambiamenti all'interfaccia di Work, tutti nello stile della skill `apple-design`:

1. **Il tab Agente del pannello destro sparisce.** Mostra solo il dettaglio di una sessione, già
   elencata a sinistra, e serve a poco. Le sue azioni si spostano sulla riga della sessione, nella
   colonna sinistra.
2. **Al suo posto arriva il tab GitHub.** Dall'app si governano Actions, Secrets e Artifacts del
   repository del progetto attivo, senza aprire il browser.
3. **Work si aggiorna da solo.** Quando esce una nuova versione, l'app lo dice e la installa con un
   clic.

Utente: chi usa Work ogni giorno su macOS (arm64) e Linux, con repository su GitHub e `gh` già
autenticato nel terminale.

Prototipo approvato (dati di esempio): https://claude.ai/artifact/CWUxPRWQYHS2sbekXRtag5, variante
**C** ("Riga che si espande"). La spec descrive il prototipo; dove i due non coincidono, vale la spec.

## Mappa dei moduli
| Id | Responsabilità | Dipende da |
|---|---|---|
| `agents-sidebar` | Azioni delle sessioni nella colonna sinistra; via il tab Agente | — |
| `github-panel` | Tab GitHub: Actions, Secrets, Artifacts del repository attivo | `agents-sidebar` (libera il posto) |
| `app-update` | Controllo della nuova versione, avviso, installazione e riavvio | — |

Ordine: `agents-sidebar` → `github-panel`. `app-update` è indipendente e può andare prima, dopo o in
parallelo.

## Decisioni prese
- **Agenti = variante C senza attività.** Clic sulla riga: la riga si espande e mostra solo i pulsanti.
  La timeline degli eventi sparisce dall'interfaccia.
- **GitHub tramite il CLI `gh`**, già autenticato dall'utente, come oggi `git`. Work non chiede e non
  salva token.
- **Sezioni GitHub: Actions, Secrets, Artifacts.** Le altre (Pull Request, Releases, Variables,
  Issues) restano nelle domande aperte.
- **Aggiornamento = avviso + installa al clic**, con `tauri-plugin-updater`. Mai senza un'azione
  dell'utente.

## Tech stack
Quello esistente (vedi `SPEC.md`): Tauri 2, Rust stable, renderer JS senza bundler.
- **Dipendenza nuova approvata:** `tauri-plugin-updater` 2.x (solo `app-update`).
- **Esterno a runtime, facoltativo:** `gh` ≥ 2.40. Senza `gh` funziona tutto tranne il tab GitHub,
  che spiega come installarlo.
- Già presenti e riusati: `tauri-plugin-dialog` (cartella di destinazione degli artifact),
  `tauri-plugin-opener` (link e "Mostra nel Finder"), `marked` + `DOMPurify` (note di rilascio).

## Comandi
```
Test:        npm test
Solo Rust:   cargo test --manifest-path src-tauri/Cargo.toml
Lint:        cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
Formato:     cargo fmt --manifest-path src-tauri/Cargo.toml
Dev:         npm run dev
Chiave di firma degli aggiornamenti (una volta, dall'utente):
             npx tauri signer generate -w ~/.tauri/work-updater.key
```

---

## Modulo `agents-sidebar`

### Comportamento
- La riga di una sessione diventa un `<button>` con `aria-expanded` e una freccia `›` a destra.
- **Clic, `Invio` o `Spazio`** espande la riga; di nuovo, la chiude. Una sola riga aperta alla volta;
  aprirne un'altra chiude la precedente.
- Sotto la riga aperta, allineati al titolo, compaiono i pulsanti a capsula:
  **Riprendi** · **Terminale** · **Apri progetto** · **Chiudi** (solo se la sessione è viva, in rosso).
  Fanno quello che fanno oggi (`hooks.resume`, `hooks.shellAt`, `hooks.openRepo`, `closeSession`).
- L'espansione sopravvive agli aggiornamenti della lista (`agents:update`): lo stato resta in
  `selected`. Se la sessione aperta sparisce, non resta aperto niente.
- Il menu contestuale resta com'è, tranne "Mostra attività", che si toglie.

### Cosa si rimuove
- `index.html`: il pulsante `data-tab="agent"` e il suo `.tab-body`.
- `agentsview.js`: `renderAgentDetail`, `seen`, ogni `hooks.showTab('agent')`.
- `style.css`: `.agent-detail`, `.agent-head`, `.agent-state`, `.agent-buttons`, `.timeline`.
- `bridge.js` `work.agents.events`, il comando `agents::agents_events` e il codice Rust che serve solo a
  lui, se nessun altro lo usa (da verificare con grep prima di cancellare).
- Il titolo di `#toggle-panel`: "Mostra Project, Modifiche, Graph, Run e GitHub".

### Aspetto e movimento (apple-design)
- Feedback alla pressione: `:active` con `scale(.985)` sulla riga e `scale(.96)` sulle capsule, in
  100 ms.
- Apertura: i pulsanti entrano con opacità e `translateY(-4px → 0)`, 240 ms, `--ease-out`
  (smorzamento critico, niente rimbalzo); la freccia ruota di 90° con la stessa curva. La chiusura
  segue lo stesso percorso al contrario.
- Riga aperta: sfondo `--bg-3-hover`, come la selezione di oggi.
- `prefers-reduced-motion`: niente traslazione né rotazione animata, solo il cambio di stato.

---

## Modulo `github-panel`

### Backend (`src-tauri/src/github.rs`, nuovo)
- Una sola funzione esegue `gh` (`tokio::process`, come `git_with`): `cwd` = radice del progetto
  attivo, timeout 30 s, `GH_PROMPT_DISABLED=1`, `NO_COLOR=1`, output JSON (`--json` o `gh api`).
  Registra comando, durata ed esito nel log, **mai** argomenti o stdin dei secret.
- `gh` si trova con il `PATH` della shell di login, già adottato all'avvio (`fix-login-shell`).
- Il `cwd` passa dallo stesso controllo dei comandi `fs_*`: solo progetti aperti.
- Comandi (nome Tauri → cosa esegue):

| Comando | Esegue |
|---|---|
| `gh_status(cwd)` | `gh --version`, `gh auth status`, `gh repo view --json nameWithOwner,url,defaultBranchRef` → `{installed, authed, repo, url}` |
| `gh_runs(cwd)` | `gh run list -L 30 --json databaseId,workflowName,displayTitle,headBranch,event,status,conclusion,createdAt,updatedAt,url` |
| `gh_run_jobs(cwd, id)` | `gh run view <id> --json jobs` (nome, stato, durata di ogni job) |
| `gh_run_action(cwd, id, action)` | `rerun` → `gh run rerun <id>`; `rerunFailed` → `--failed`; `cancel` → `gh run cancel <id>` |
| `gh_workflows(cwd)` | `gh workflow list --json id,name,path,state` |
| `gh_workflow_run(cwd, workflow, ref)` | `gh workflow run <workflow> --ref <ref>` (input con i loro default) |
| `gh_secrets(cwd)` | `gh secret list --json name,updatedAt` |
| `gh_secret_set(cwd, name, value)` | `gh secret set <name>` con il valore su **stdin**, mai in argv |
| `gh_secret_delete(cwd, name)` | `gh secret delete <name>` |
| `gh_artifacts(cwd)` | `gh api repos/{owner}/{repo}/actions/artifacts?per_page=50` |
| `gh_artifact_download(cwd, run, name, dir)` | `gh run download <run> -n <name> -D <dir>/<name>` |
| `gh_artifact_delete(cwd, id)` | `gh api -X DELETE repos/{owner}/{repo}/actions/artifacts/<id>` |

- Validazione in Rust (confine di fiducia): nome del secret `^[A-Za-z_][A-Za-z0-9_]*$`, non inizia con
  `GITHUB_`; `action` solo dai tre valori; `id` numerico; `dir` scelto dal dialog e non vuoto.
- Errori in italiano, con il motivo di `gh` quando serve ("Servono i permessi di amministratore del
  repository per vedere i secret.").

### Renderer (`src/renderer/github.js`, nuovo; tab in `index.html`)
- Tab **GitHub** al posto di Agente, con un pallino sul tab: rosso se l'ultima run del branch attuale
  è fallita, blu se è in corso, nessun pallino altrimenti.
- In cima, un **controllo segmentato**: Actions · Secrets · Artifacts. Il segmento scelto si ricorda
  per progetto (in `state.json`, come le altre preferenze di pannello).
- **Stati vuoti**, ognuno con un'azione:
  - `gh` assente → "Serve GitHub CLI" + link a https://cli.github.com;
  - non autenticato → "Accedi a GitHub" apre un terminale di Work con `gh auth login`;
  - nessun remote GitHub → "Questo progetto non ha un repository su GitHub";
  - permessi insufficienti → messaggio nella sezione, le altre funzionano.
- **Actions**
  - Lista delle run: pallino di stato (in coda, in corso, riuscita, fallita, annullata), titolo,
    workflow · branch · evento, tempo trascorso e durata.
  - Clic sulla riga: si espande come le righe degli agenti e mostra i job con stato e durata, più le
    capsule **Riesegui** · **Riesegui falliti** (solo se fallita) · **Annulla** (solo se in corso) ·
    **Apri su GitHub**.
  - In alto, **Esegui workflow ⌄**: menu dei workflow attivi; parte sul branch attuale con gli input
    di default; un toast conferma e la lista si aggiorna.
  - Aggiornamento: ogni 10 s mentre il tab è visibile e c'è una run in corso, altrimenti ogni 60 s; al
    ritorno del focus sulla finestra; subito dopo un push fatto da Work. Fermo quando il tab o il
    pannello sono nascosti (il pallino del tab si aggiorna comunque ogni 60 s).
- **Secrets**
  - Lista: nome in monospazio, "aggiornato 3 g fa". I valori non si leggono mai (GitHub non li dà).
  - **＋ Nuovo secret** e **Aggiorna valore** aprono un foglio ancorato al pannello: campo nome
    (validato mentre si scrive), area di testo per il valore (va bene anche un certificato su più
    righe), mascherata, con l'occhio per mostrarla. Il valore resta in memoria solo finché il foglio è
    aperto.
  - **Elimina**: conferma distruttiva con il nome del secret.
- **Artifacts**
  - Lista: nome, run di origine, dimensione, "scade tra 12 g"; gli scaduti in grigio e non
    scaricabili.
  - **Scarica**: dialog per la cartella, poi toast "Scaricato" con l'azione "Mostra nel Finder" (su
    Linux "Mostra nella cartella").
  - **Elimina**: conferma distruttiva.

### Aspetto e movimento (apple-design)
- Controllo segmentato: capsula di sfondo che scorre sotto il segmento scelto, 240 ms `--ease-out`;
  con `prefers-reduced-motion` cambia senza scorrere.
- Righe, capsule e pallini identici a quelli degli agenti (stessa grammatica in tutta l'app).
- Fogli: materiale traslucido (`--blur`), senza velo scuro perché non blocca il resto. Entrano dal
  bordo del pannello ed escono dallo stesso lato.
- Una run in corso: pallino blu fisso con un anello di avanzamento indeterminato. Niente pulsazioni
  lente.
- Ogni azione dà un riscontro immediato: il pulsante passa a "…" alla pressione; un toast conferma o
  riporta l'errore.

---

## Modulo `app-update`

### Rilascio (`.github/workflows/release.yml`, `tauri.conf.json`)
- `bundle.createUpdaterArtifacts: true`; `plugins.updater.pubkey` = chiave pubblica;
  `plugins.updater.endpoints` =
  `["https://github.com/overzoomit/work-stack/releases/latest/download/latest.json"]`.
- Il CI firma con i secret `TAURI_SIGNING_PRIVATE_KEY` e `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`;
  `tauri-action` carica `latest.json` e i pacchetti firmati (`.app.tar.gz` macOS, `.AppImage` Linux)
  nella release.
- Senza quei secret il CI continua a funzionare (come la firma macOS di oggi): niente `latest.json`,
  quindi nessun aggiornamento proposto.
- L'utente genera la chiave e carica i due secret: si può fare dal tab GitHub stesso.

### Backend (`src-tauri/src/app.rs`)
- `app_update_check()` → `null` oppure `{version, notes, date, canInstall}`. `canInstall` è falso su
  Linux se Work non gira da AppImage (`$APPIMAGE` assente): `.deb` e `.rpm` ricevono solo l'avviso.
- `app_update_install()`: scarica e installa; emette `app:update-progress` con `[scaricati, totali]`.
  Non riavvia.
- `app_update_restart()`: riavvia (`app.restart()`), solo dopo i controlli del renderer.
- Nessun controllo nelle build di sviluppo (`debug_assertions`).

### Renderer (`src/renderer/update.js`, nuovo)
- Controllo 10 s dopo l'avvio (fuori dal percorso di avvio), poi ogni 6 ore. Un errore di rete non
  disturba: va nel log.
- Nuova versione trovata:
  - la versione nella barra di stato (`#status-version`) diventa una capsula blu "Aggiorna a 1.2.0";
  - un solo toast per versione e per avvio: "Work 1.2.0 è disponibile" con l'azione "Dettagli".
- Clic sulla capsula o su "Dettagli": popover ancorato alla capsula, con versione, data, note di
  rilascio (markdown sanificato) e i pulsanti **Installa** / **Più tardi**.
- **Installa**: barra di avanzamento nel popover; a fine installazione, "Riavvia ora" / "Al prossimo
  avvio".
- **Riavvia ora**: prima le stesse domande della chiusura (modifiche non salvate, `may_quit`); se ci
  sono terminali o agenti vivi, una conferma che li nomina ("2 terminali e 1 agente verranno chiusi").
- `canInstall` falso: il popover mostra "Scarica" che apre la pagina della release.
- "Controlla aggiornamenti…" anche a mano: menu Work su macOS, `⋯` su Linux. Se non c'è niente:
  "Work è aggiornato (1.1.0)".

### Aspetto e movimento (apple-design)
- Popover che nasce dalla capsula (`transform-origin` sulla capsula) ed esce dallo stesso punto.
- Barra di avanzamento continua, mai a scatti; il testo dice i MB.
- Mai un dialog modale non richiesto: l'utente decide quando.

---

## Struttura
```
src-tauri/src/github.rs        nuovo: esecuzione di gh, parsing, comandi gh_*
src-tauri/src/app.rs           app_update_check / install / restart; voce di menu macOS
src-tauri/src/agents.rs        via agents_events (se non usato altrove)
src-tauri/src/main.rs          registrazione dei comandi e del plugin updater
src-tauri/Cargo.toml           tauri-plugin-updater
src-tauri/tauri.conf.json      createUpdaterArtifacts, plugins.updater
src-tauri/capabilities/        permesso updater, se il plugin lo richiede
.github/workflows/release.yml  secret di firma dell'updater
src/renderer/agentsview.js     righe espandibili, via il dettaglio
src/renderer/github.js         nuovo: tab GitHub
src/renderer/update.js         nuovo: avviso e installazione
src/renderer/bridge.js         work.github.*, work.app.update*
src/renderer/index.html        tab GitHub al posto di Agente
src/renderer/app.js            init dei nuovi moduli, menu ⋯ su Linux
src/renderer/style.css         righe espandibili, segmentato, fogli, capsula di aggiornamento
test/agentsview.test.mjs       righe espandibili
test/github.test.mjs           nuovo
test/update.test.mjs           nuovo
README.md                      "Cosa fa": GitHub e aggiornamenti; come caricare la chiave
```

## Code style
Come il codice intorno. Rust: logica pura (parsing del JSON di `gh`, validazione) separata
dall'esecuzione, errori `String` in italiano. JS: moduli ES, `$`/`esc`/`setHtml` di `ui.js`, niente
framework. Commenti in inglese, pochi, sul perché.
```rust
// The value goes through stdin: an argument would show up in `ps` and in the log.
pub async fn gh_secret_set(cwd: String, name: String, value: String) -> Result<(), String> {
    check_secret_name(&name)?;
    gh_with_stdin(&cwd, &["secret", "set", &name], value.as_bytes()).await.map(|_| ())
}
```

## Strategia di test
- **Rust** (`#[cfg(test)]` nel modulo, nessuna chiamata di rete):
  - parsing di `gh run list`, `gh run view --json jobs`, `gh secret list`, artifacts da JSON di
    esempio; mappatura `status`/`conclusion` → stato del pallino;
  - `gh_status`: `gh` assente, non autenticato, remote non GitHub (output di esempio);
  - `check_secret_name`: valido, vuoto, con spazi, che inizia con una cifra, `GITHUB_TOKEN`;
  - `action` sconosciuta e `id` non numerico rifiutati;
  - il valore di un secret non compare mai nella riga di log (test sulla funzione che la compone);
  - `canInstall` con e senza `APPIMAGE`.
- **Renderer** (`node --test`):
  - `agentsview`: una sola riga aperta; l'apertura sopravvive a un aggiornamento; "Chiudi" solo con
    `live`; sessione sparita = niente aperto;
  - `github`: pallino del tab dall'ultima run del branch; stati vuoti; validazione del nome mentre si
    scrive; intervallo di aggiornamento (10 s / 60 s / fermo);
  - `update`: un solo toast per versione; "Riavvia ora" chiede conferma con terminali vivi.
- **Verifica manuale** (`npm run dev` e build di release):
  - su `work-stack`: lista run reale, riesecuzione di una run fallita, download di un artifact,
    creazione ed eliminazione di un secret di prova;
  - senza `gh` nel `PATH` e dopo `gh auth logout`: stati vuoti corretti;
  - aggiornamento da 1.1.x a una release di prova firmata, su macOS e su AppImage.

## Boundaries
- **Sempre**: valori dei secret solo su stdin, mai in argv, log, `state.json` o errori; ogni azione
  distruttiva (elimina secret o artifact, annulla run, riavvia con terminali vivi) chiede conferma;
  `npm test`, clippy e fmt verdi; commit con `/conventional-commits`.
- **Chiedere prima**: altre dipendenze oltre a `tauri-plugin-updater`; sezioni GitHub oltre alle tre;
  secret di ambiente o di organizzazione; leggere i log dei job dentro l'app; input dei workflow
  diversi dai default; installare aggiornamenti senza clic.
- **Mai**: salvare token o credenziali GitHub; mostrare o registrare il valore di un secret dopo il
  salvataggio; riavviare l'app senza conferma; scaricare aggiornamenti non firmati.

## Criteri di successo
- [ ] Il pannello destro non ha più il tab Agente; ha il tab GitHub.
- [ ] Clic su una sessione a sinistra: la riga si espande con Riprendi · Terminale · Apri progetto ·
      (Chiudi), e funzionano come prima; da tastiera con `Invio`.
- [ ] Tab GitHub su `work-stack`: le run compaiono in meno di 2 s; una run in corso passa a riuscita
      senza ricaricare a mano.
- [ ] "Riesegui falliti" su una run fallita la rimette in coda e la riga lo mostra.
- [ ] Un secret creato dall'app compare in `gh secret list`; il suo valore non è in nessun file di
      log di Work.
- [ ] Un artifact scaricato si trova nella cartella scelta e "Mostra nel Finder" la apre.
- [ ] Senza `gh`, o senza login, il tab spiega cosa fare e il resto dell'app funziona.
- [ ] Con una release più nuova firmata: capsula nella barra di stato, toast, Installa, Riavvia ora →
      Work riparte alla nuova versione (macOS e AppImage).
- [ ] Su `.deb`/`.rpm` l'avviso compare e "Scarica" apre la release.
- [ ] `prefers-reduced-motion` attivo: nessuna animazione di movimento nelle tre parti.
- [ ] `npm test`, clippy e fmt verdi.

## Domande aperte
1. **Altre sezioni GitHub?** Pull Request, Releases, Variables/Environments, Issues: quali, in un
   secondo giro?
2. **Log dei job falliti dentro Work** (es. nell'anteprima) o basta "Apri su GitHub"?
3. **Workflow con input** (come `release.yml`, `os` e `tag`): bastano i default o serve un foglio
   con i campi?
4. **Secret di ambiente e di organizzazione**: servono o bastano quelli del repository?
5. **`.deb`/`.rpm`**: va bene solo l'avviso, o vale la pena l'installazione automatica (richiede
   `pkexec` e va verificata sul plugin)?

# Todo — agenti a sinistra, GitHub, aggiornamenti

Contesto, rischi e dipendenze in `tasks/plan.md`. Spec: `SPEC-github-update.md`.
Verifica standard di ogni task: `npm test`, `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`,
`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`. Commit con `/conventional-commits`.

## Fase 1: agenti a sinistra

### T1: Le righe delle sessioni si espandono (S)
Riga = `<button aria-expanded>` con freccia `›`; clic/Invio/Spazio apre, una sola aperta; sotto compaiono
Riprendi · Terminale · Apri progetto · Chiudi (solo `live`, rosso). "Mostra attività" esce dal menu contestuale.
- [x] Una sola riga aperta; riaprirla la chiude
- [x] L'apertura sopravvive a `agents:update`; sessione sparita = niente aperto
- [x] "Chiudi" solo con `live`; le capsule chiamano `hooks.resume/shellAt/openRepo` e `closeSession`
- [x] Movimento della spec (240 ms `--ease-out`, `:active`, `prefers-reduced-motion`)
- Verifica: `node --test test/agentsview.test.mjs`; a mano in `npm run dev` con mouse e tastiera
- Fatto insieme a T2 nello stesso intervento; `cargo fmt --check` fallisce già su HEAD (codice non formattato), non per queste modifiche.
- Dipende da: nessuna
- File: `src/renderer/agentsview.js`, `src/renderer/style.css`, `test/agentsview.test.mjs`

### T2: Via il tab Agente e il codice morto (S)
- [x] Spariti `data-tab="agent"` e il suo `.tab-body`, `renderAgentDetail`, `seen`, ogni `showTab('agent')`
- [x] Spariti `.agent-detail`, `.agent-head`, `.agent-state`, `.agent-buttons`, `.timeline`
- [x] Spariti `work.agents.events`, `agents_events` e `AgentWatcher::events` (grep: nessun altro uso, test compresi)
- [x] Titolo di `#toggle-panel`: "Mostra Project, Modifiche, Graph, Run e GitHub"
- Verifica: `npm test`, clippy, fmt; grep di `agent-detail|timeline|agents_events` senza risultati
- Dipende da: T1
- File: `index.html`, `agentsview.js`, `style.css`, `bridge.js`, `agents.rs`, `main.rs`, `app.js`, `test/agentsview.test.mjs`

### Checkpoint A: agenti
- [x] `npm test` (151 JS, 180 Rust) e clippy verdi; fmt: vedi nota in T1
- [ ] `npm run dev`: clic e Invio espandono; il pannello destro non ha più il tab Agente
- [ ] Revisione con l'utente

## Fase 2: pannello GitHub

### T3: `gh` e tab GitHub con gli stati vuoti (M)
`github.rs`: funzione unica che esegue `gh` (cwd = progetto aperto, timeout 30 s, `GH_PROMPT_DISABLED=1`,
`NO_COLOR=1`, log senza argomenti dei secret) e `gh_status`. Tab GitHub al posto di Agente con i quattro stati vuoti.
- [x] `gh_status` → `{installed, authed, repo, url}`; `cwd` controllato con `Roots`
- [x] Stati: `gh` assente (link cli.github.com), non autenticato ("Accedi a GitHub" apre un terminale con `gh auth login`), nessun remote GitHub, repo trovato
- [x] Test Rust su output di esempio: assente, non autenticato, remote non GitHub, ok
- [x] Il resto dell'app funziona senza `gh`
- Verifica: `cargo test`, `node --test test/github.test.mjs`; a mano con `gh` fuori dal `PATH` e dopo `gh auth logout`
- Il test Rust di `exec` usa un `gh` finto: verifica stdin multi-riga, ambiente ed exit code. Manca la prova a mano senza `gh` e dopo `auth logout` (Checkpoint B).
- Dipende da: T2
- File: `src-tauri/src/github.rs`, `main.rs`, `bridge.js`, `github.js`, `index.html`, `app.js`, `style.css`, `test/github.test.mjs`

### T4: Actions, lista delle run con pallino e aggiornamento (M)
- [x] `gh_runs`; parsing e mappa `status`/`conclusion` → stato (in coda, in corso, riuscita, fallita, annullata)
- [x] Riga: pallino, titolo, workflow · branch · evento, tempo e durata; run in corso con anello indeterminato
- [x] Pallino sul tab: rosso se l'ultima run del branch attuale è fallita, blu se in corso, altrimenti niente
- [x] Aggiornamento: 10 s con run in corso, altrimenti 60 s; al focus; fermo con tab o pannello nascosti (il pallino ogni 60 s)
- [x] Le run compaiono in meno di 2 s su `work-stack`
- Verifica: test Rust del parsing; test JS di pallino e intervalli; a mano su `work-stack`
- Misurato a mano: `gh run list -L 30` su `work-stack` 0,03 s; stato + run in meno di 0,3 s.
- Dipende da: T3
- File: `github.rs`, `main.rs`, `bridge.js`, `github.js`, `style.css`, `test/github.test.mjs`

### T5: Actions, azioni sulle run e "Esegui workflow" (M)
- [x] Riga espandibile (come gli agenti) con i job (`gh_run_jobs`: nome, stato, durata)
- [x] Capsule Riesegui · Riesegui falliti (solo fallita) · Annulla (solo in corso, con conferma) · Apri su GitHub
- [x] `gh_run_action` rifiuta azioni sconosciute e id non numerici
- [x] "Esegui workflow ⌄": workflow attivi, branch attuale, default; toast e lista aggiornata
- [x] Un push fatto da Work aggiorna subito la lista
- Verifica: test Rust (validazione, jobs); a mano: riesecuzione di una run fallita la rimette in coda
- Non ho rieseguito né annullato run sul repository vero (azione con effetti all'esterno): `rerun`/`cancel` sono verificati con test su argomenti e su un `gh` finto. Prova a mano dell'utente al Checkpoint B.
- Dipende da: T4
- File: `github.rs`, `main.rs`, `bridge.js`, `github.js`, `style.css`, `test/github.test.mjs`

### T6: Secrets e controllo segmentato (M)
- [x] Controllo segmentato Actions · Secrets, capsula che scorre (240 ms, senza scorrere con reduced-motion); scelta ricordata per progetto (vedi domanda aperta 1)
- [x] Lista: nome in monospazio, "aggiornato 3 g fa"; permessi insufficienti = messaggio nella sezione
- [x] Foglio traslucido: nome validato mentre si scrive, area di testo mascherata con occhio, multi-riga ok
- [x] `gh_secret_set` col valore su stdin, mai in argv, log o errori; `check_secret_name` (`^[A-Za-z_][A-Za-z0-9_]*$`, non `GITHUB_`)
- [x] Elimina con conferma che nomina il secret
- Verifica: test Rust (nome valido/vuoto/spazi/cifra/`GITHUB_TOKEN`, riga di log senza valore, stdin multi-riga); a mano: secret di prova creato, visto in `gh secret list`, eliminato; valore assente dal log di Work
- Verifica reale: un test `#[ignore]` (`real_secret_roundtrip`) ha creato su `work-stack` un secret multi-riga, l'ha visto in `gh secret list` e l'ha eliminato; il valore non è in nessun output. Segmento ricordato in `localStorage` (decisione 2).
- Dipende da: T3
- File: `github.rs`, `main.rs`, `bridge.js`, `github.js`, `index.html`, `style.css`, `test/github.test.mjs`

### T7: Artifacts (M)
- [x] `gh_artifacts`: nome, run di origine, dimensione, "scade tra 12 g"; scaduti in grigio e non scaricabili
- [x] Scarica: dialog per la cartella, `gh run download -n` in `<dir>/<name>`, toast con "Mostra nel Finder" (Linux: "Mostra nella cartella")
- [x] Elimina con conferma; `dir` vuoto e `id` non numerico rifiutati
- [x] Terzo segmento nel controllo
- Verifica: test Rust (parsing, validazione); a mano: artifact scaricato nella cartella scelta, "Mostra nel Finder" la apre
- Verifica reale: `real_artifact_download` (`#[ignore]`) ha scaricato un artifact vero di `work-stack` in una cartella temporanea. Non ho eliminato artifact veri (distruttivo): `gh api -X DELETE` è verificato su un `gh` finto.
- Dipende da: T6 (controllo segmentato)
- File: `github.rs`, `main.rs`, `bridge.js`, `github.js`, `style.css`, `test/github.test.mjs`

### Checkpoint B: GitHub
- [x] `npm test`, clippy verdi (fmt: vedi T1)
- [x] Su `work-stack`: stato, elenco run, secret creato e cancellato, artifact scaricato (test `#[ignore]` contro GitHub vero). Non rieseguite né annullate run, non eliminati artifact veri.
- [x] Senza `gh` (PATH senza gh), senza login (`GH_CONFIG_DIR` vuoto), remote non GitHub, cartella senza git: stati giusti (`real_status`). Questa prova ha trovato un bug: una cartella senza git dava un errore invece dello stato vuoto, corretto.
- [x] `npm run dev` parte e gira senza errori né panic nel log; non ho potuto guardare la finestra (nessuno screenshot)
- [ ] `prefers-reduced-motion` e aspetto: da guardare a occhio
- [ ] Revisione con l'utente

## Fase 3: aggiornamenti (indipendente, parallelizzabile)

### T8: Rilascio firmato (S, serve la chiave dell'utente)
Prima: l'utente genera la chiave (`npx tauri signer generate -w ~/.tauri/work-updater.key`) e dà la chiave pubblica.
- [x] `tauri-plugin-updater` in `Cargo.toml`, registrato in `main.rs`; permesso in `capabilities/default.json` se serve
- [x] `tauri.conf.json`: `plugins.updater.pubkey` e `endpoints`. `createUpdaterArtifacts` NON è nel file: con la chiave pubblica e senza privata `tauri build` fallisce (provato), quindi sta in `src-tauri/updater.conf.json`, passato con `--config` solo se la chiave c'è (`TAURI_CONFIG` come variabile d'ambiente non viene letta dal CLI)
- [x] `release.yml`: `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)` in entrambi gli step `tauri-action`; senza i secret il CI passa e non produce `latest.json`
- [x] README: come caricare la chiave e i due secret
- Verifica: `cargo build`, `npm test`, `npm run dev` parte; run manuale del workflow su una prerelease: `latest.json` e pacchetti firmati nella release
- Provato in locale: `tauri build --debug --bundles app` con `--config` e una chiave di prova produce `Work.app.tar.gz` + `.sig` e avvisa se la chiave non corrisponde alla pubkey; senza chiave, con `--config`, fallisce; senza `--config` funziona. `npm run dev` parte col plugin.
- Da fare dall'utente: caricare i due secret (vedi README) e lanciare il workflow su una prerelease (`v1.1.1-test`): non l'ho fatto, pubblicherebbe una release.
- Dipende da: la chiave pubblica dell'utente
- File: `Cargo.toml`, `main.rs`, `tauri.conf.json`, `capabilities/default.json`, `release.yml`, `README.md`

### T9: Avviso di nuova versione (M)
- [x] `app_update_check()` → `null` o `{version, notes, date, canInstall}`; `canInstall` falso su Linux senza `$APPIMAGE`; nessun controllo con `debug_assertions`
- [x] `update.js`: controllo dopo 10 s e ogni 6 ore, errori solo nel log
- [x] Capsula blu "Aggiorna a X" in `#status-version`; un solo toast per versione e per avvio
- [x] Popover dalla capsula: versione, data, note (markdown sanificato), Installa / Più tardi; `canInstall` falso = "Scarica" apre la release
- [x] "Controlla aggiornamenti…" (menu Work su macOS, `⋯`); se niente: "Work è aggiornato (1.1.0)"
- Verifica: test Rust (`canInstall` con e senza `APPIMAGE`); test JS (un toast per versione); a mano con una release di prova più nuova
- Non verificato con una release vera: serve una release firmata più nuova (le build di sviluppo non controllano). Il popover ha «Scarica» (apre la release) sia con `canInstall` vero sia falso fino a T10, che aggiunge «Installa». `cargo check --release` compila.
- Dipende da: T8
- File: `app.rs`, `main.rs`, `bridge.js`, `update.js`, `app.js`, `index.html`, `style.css`, `test/update.test.mjs`

### T10: Installa e riavvia (M)
- [x] `app_update_install()` scarica, verifica la firma, emette `app:update-progress` `[scaricati, totali]`, non riavvia
- [x] Barra continua nel popover con i MB; poi "Riavvia ora" / "Al prossimo avvio"
- [x] `app_update_restart()` solo dopo `may_quit`/modifiche non salvate; con terminali o agenti vivi, conferma che li nomina
- [x] Mai installare senza clic; mai riavviare senza conferma
- Verifica: test JS ("Riavvia ora" chiede conferma con terminali vivi); a mano: 1.1.x → release di prova, macOS e AppImage; su `.deb`/`.rpm` solo avviso
- Non provato end-to-end: serve una release firmata più nuova e un clic su Installa / Riavvia ora (su macOS e AppImage). `app.restart()` su macOS lancia il nuovo binario e chiude il vecchio: con il plugin single-instance (solo in release) c'è una piccola corsa, da guardare nella prova reale.
- Dipende da: T9
- File: `app.rs`, `main.rs`, `bridge.js`, `update.js`, `style.css`, `test/update.test.mjs`

### Checkpoint finale: pronto per la release
- [x] Criteri della spec verificati con test e prove reali, tranne quelli che chiedono una release firmata, i clic nell'interfaccia o azioni distruttive sul repository vero (vedi sotto)
- [x] `npm test` (206 JS, 211 Rust) e clippy verdi; README aggiornato (GitHub, aggiornamenti, chiave)
- [ ] `cargo fmt --check`: fallisce già su `HEAD` (codice non formattato prima di questo lavoro); i file nuovi (`github.rs`) sono formattati
- [ ] Aggiornamento verificato su macOS e AppImage: dopo aver caricato i due secret, lanciare il workflow su una prerelease (`v1.1.1-test`) e aggiornare da 1.1.0
- [ ] Da guardare a occhio in `npm run dev`: righe espandibili, tab GitHub, foglio dei secret, capsula e popover, `prefers-reduced-motion`
- [ ] Revisione con l'utente

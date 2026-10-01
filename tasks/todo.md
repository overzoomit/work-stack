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
- [ ] `gh_runs`; parsing e mappa `status`/`conclusion` → stato (in coda, in corso, riuscita, fallita, annullata)
- [ ] Riga: pallino, titolo, workflow · branch · evento, tempo e durata; run in corso con anello indeterminato
- [ ] Pallino sul tab: rosso se l'ultima run del branch attuale è fallita, blu se in corso, altrimenti niente
- [ ] Aggiornamento: 10 s con run in corso, altrimenti 60 s; al focus; fermo con tab o pannello nascosti (il pallino ogni 60 s)
- [ ] Le run compaiono in meno di 2 s su `work-stack`
- Verifica: test Rust del parsing; test JS di pallino e intervalli; a mano su `work-stack`
- Dipende da: T3
- File: `github.rs`, `main.rs`, `bridge.js`, `github.js`, `style.css`, `test/github.test.mjs`

### T5: Actions, azioni sulle run e "Esegui workflow" (M)
- [ ] Riga espandibile (come gli agenti) con i job (`gh_run_jobs`: nome, stato, durata)
- [ ] Capsule Riesegui · Riesegui falliti (solo fallita) · Annulla (solo in corso, con conferma) · Apri su GitHub
- [ ] `gh_run_action` rifiuta azioni sconosciute e id non numerici
- [ ] "Esegui workflow ⌄": workflow attivi, branch attuale, default; toast e lista aggiornata
- [ ] Un push fatto da Work aggiorna subito la lista
- Verifica: test Rust (validazione, jobs); a mano: riesecuzione di una run fallita la rimette in coda
- Dipende da: T4
- File: `github.rs`, `main.rs`, `bridge.js`, `github.js`, `style.css`, `test/github.test.mjs`

### T6: Secrets e controllo segmentato (M)
- [ ] Controllo segmentato Actions · Secrets, capsula che scorre (240 ms, senza scorrere con reduced-motion); scelta ricordata per progetto (vedi domanda aperta 1)
- [ ] Lista: nome in monospazio, "aggiornato 3 g fa"; permessi insufficienti = messaggio nella sezione
- [ ] Foglio traslucido: nome validato mentre si scrive, area di testo mascherata con occhio, multi-riga ok
- [ ] `gh_secret_set` col valore su stdin, mai in argv, log o errori; `check_secret_name` (`^[A-Za-z_][A-Za-z0-9_]*$`, non `GITHUB_`)
- [ ] Elimina con conferma che nomina il secret
- Verifica: test Rust (nome valido/vuoto/spazi/cifra/`GITHUB_TOKEN`, riga di log senza valore, stdin multi-riga); a mano: secret di prova creato, visto in `gh secret list`, eliminato; valore assente dal log di Work
- Dipende da: T3
- File: `github.rs`, `main.rs`, `bridge.js`, `github.js`, `index.html`, `style.css`, `test/github.test.mjs`

### T7: Artifacts (M)
- [ ] `gh_artifacts`: nome, run di origine, dimensione, "scade tra 12 g"; scaduti in grigio e non scaricabili
- [ ] Scarica: dialog per la cartella, `gh run download -n` in `<dir>/<name>`, toast con "Mostra nel Finder" (Linux: "Mostra nella cartella")
- [ ] Elimina con conferma; `dir` vuoto e `id` non numerico rifiutati
- [ ] Terzo segmento nel controllo
- Verifica: test Rust (parsing, validazione); a mano: artifact scaricato nella cartella scelta, "Mostra nel Finder" la apre
- Dipende da: T6 (controllo segmentato)
- File: `github.rs`, `main.rs`, `bridge.js`, `github.js`, `style.css`, `test/github.test.mjs`

### Checkpoint B: GitHub
- [ ] `npm test`, clippy, fmt verdi
- [ ] Su `work-stack`: run reale, riesecuzione, secret di prova, artifact scaricato
- [ ] Senza `gh` e senza login: il tab spiega cosa fare, il resto funziona
- [ ] `prefers-reduced-motion`: nessun movimento
- [ ] Revisione con l'utente

## Fase 3: aggiornamenti (indipendente, parallelizzabile)

### T8: Rilascio firmato (S, serve la chiave dell'utente)
Prima: l'utente genera la chiave (`npx tauri signer generate -w ~/.tauri/work-updater.key`) e dà la chiave pubblica.
- [ ] `tauri-plugin-updater` in `Cargo.toml`, registrato in `main.rs`; permesso in `capabilities/default.json` se serve
- [ ] `tauri.conf.json`: `createUpdaterArtifacts`, `plugins.updater.pubkey` e `endpoints`
- [ ] `release.yml`: `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)` in entrambi gli step `tauri-action`; senza i secret il CI passa e non produce `latest.json`
- [ ] README: come caricare la chiave e i due secret
- Verifica: `cargo build`, `npm test`, `npm run dev` parte; run manuale del workflow su una prerelease: `latest.json` e pacchetti firmati nella release
- Dipende da: la chiave pubblica dell'utente
- File: `Cargo.toml`, `main.rs`, `tauri.conf.json`, `capabilities/default.json`, `release.yml`, `README.md`

### T9: Avviso di nuova versione (M)
- [ ] `app_update_check()` → `null` o `{version, notes, date, canInstall}`; `canInstall` falso su Linux senza `$APPIMAGE`; nessun controllo con `debug_assertions`
- [ ] `update.js`: controllo dopo 10 s e ogni 6 ore, errori solo nel log
- [ ] Capsula blu "Aggiorna a X" in `#status-version`; un solo toast per versione e per avvio
- [ ] Popover dalla capsula: versione, data, note (markdown sanificato), Installa / Più tardi; `canInstall` falso = "Scarica" apre la release
- [ ] "Controlla aggiornamenti…" (menu Work su macOS, `⋯`); se niente: "Work è aggiornato (1.1.0)"
- Verifica: test Rust (`canInstall` con e senza `APPIMAGE`); test JS (un toast per versione); a mano con una release di prova più nuova
- Dipende da: T8
- File: `app.rs`, `main.rs`, `bridge.js`, `update.js`, `app.js`, `index.html`, `style.css`, `test/update.test.mjs`

### T10: Installa e riavvia (M)
- [ ] `app_update_install()` scarica, verifica la firma, emette `app:update-progress` `[scaricati, totali]`, non riavvia
- [ ] Barra continua nel popover con i MB; poi "Riavvia ora" / "Al prossimo avvio"
- [ ] `app_update_restart()` solo dopo `may_quit`/modifiche non salvate; con terminali o agenti vivi, conferma che li nomina
- [ ] Mai installare senza clic; mai riavviare senza conferma
- Verifica: test JS ("Riavvia ora" chiede conferma con terminali vivi); a mano: 1.1.x → release di prova, macOS e AppImage; su `.deb`/`.rpm` solo avviso
- Dipende da: T9
- File: `app.rs`, `main.rs`, `bridge.js`, `update.js`, `style.css`, `test/update.test.mjs`

### Checkpoint finale: pronto per la release
- [ ] Tutti i criteri di successo di `SPEC-github-update.md`
- [ ] `npm test`, clippy, fmt verdi; README aggiornato (GitHub, aggiornamenti, chiave)
- [ ] Aggiornamento verificato su macOS e AppImage
- [ ] Revisione con l'utente

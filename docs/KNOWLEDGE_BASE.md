# Work Stack — Knowledge Base & Documentazione Architetturale

Questo documento costituisce la base di conoscenza ufficiale di **Work Stack**, consolidando tutti i requisiti, le decisioni tecniche, l'architettura dei moduli e lo storico dei ticket implementati dal team multi-agente.

---

## 1. Visione di Progetto & Stack Tecnologico

Work Stack è una dashboard desktop moderna pensata per sviluppatori (Linux e macOS) che unifica:
- Gestione multi-progetto con navigazione a schede e persistenza dello stato.
- Terminali PTY multipli orchestrati tramite **tmux** con supporto per sessioni raggruppate.
- Squadra Agenti AI interattiva (PM, Dev1, Dev2, QA, Agenti Generici) con monitoraggio live.
- Albero file con anteprima, editing e sandboxing di sicurezza basato su perimetri (`Roots`).
- Strumenti Git completi (diff inline, staging atomico, grafo commit, rami) e integrazione GitHub CLI (`gh`).
- Sentinella di ascolto **Dogwatch** per intercettare prompt e blocchi degli agenti con delega decisionale al PM.

### Componenti Tecnologici
- **Backend Desktop:** Rust stable (2021) su **Tauri 2** (`src-tauri/`).
  - `main.rs`: Inizializzazione Tauri, registrazione plugin IPC e binding comandi.
  - `tmux.rs`: Orchestrazione sessioni tmux di progetto (`work_<name>_<hash>`) e gestione finestre.
  - `pty.rs`: Sessioni PTY virtuali con `portable-pty` collegate a tmux per terminali reattivi.
  - `agents.rs` & `claudeprocs.rs`: Watcher reattivo sulle sessioni transcript (`.jsonl`) e tracciamento processi.
  - `fsops.rs`: Operazioni sicure su filesystem vincolate ai perimetri di progetto (`Roots`).
  - `git.rs` & `gitwatch.rs`: Wrapper CLI Git con monitoraggio reattivo su `.git`.
  - `github.rs`: Wrapper CLI `gh` per Actions, Secrets e Artifacts.
  - `runconfigs.rs`: Autodiscovery configurazioni di esecuzione comandi (`npm`, `cargo`, ecc.).
  - `store.rs`: Persistenza atomica dello stato tra sessioni.
  - `diag.rs` & `app.rs`: Logging diagnostico, menu applicativi e lifecycle.
- **Frontend Web:** Vanilla HTML/CSS/JavaScript (ES Modules puri in `src/renderer/`, senza bundler né framework di terze parti).
  - `app.js`: Inizializzazione applicazione, layout a due colonne e gestione progetti.
  - `accordion.js`: Gestione delle sezioni collapsible VS Code-style nella sidebar sinistra.
  - `team.js`: Popover e logica orchestratore Squadra Agenti (PM, Dev, QA, Generici).
  - `terminals.js`: Gestione riquadri terminali, griglia CSS e auto-reattach tmux.
  - `bridge.js`: API `window.work` che astrae le chiamate IPC di Tauri.
  - `launcher.js`: Registry degli agenti CLI supportati (`AGENTS`).
  - `tree.js`, `changes.js`, `graph.js`, `github.js`, `run.js`: Moduli delle sezioni informative.
- **Tooling & Ops:**
  - `scripts/tmux-dogwatch.py`: Sentinella per il rilevamento di prompt e l'escalation al PM.
  - `scripts/telegram-pm.py`: CLI PM-only per inviare notifiche o risposte alla chat Telegram autorizzata. Work salva la connessione in `telegram.json` (0600) e la ripristina all'avvio.
  - `scripts/vendor.mjs`: Download e aggiornamento librerie vendor (xterm 6, marked, DOMPurify).

---

## 2. Storico dei Ticket & Funzionalità Implementate (Sprint 1)

Tutti i ticket sono stati gestiti sull'istanza Plane del progetto (`https://plane.overzoom.it/overzoom/`, ID: `3b32410c-16cb-4315-a60e-84c0ce72f0fb`).

| Ticket | Modulo | Descrizione Sintetica | Commit / Ref |
|---|---|---|---|
| **[1]** | BE | Modulo Rust `tmux.rs` e gestione sessioni/finestre tmux per progetto | `313d4fe` |
| **[2]** | BE | Integrazione `pty.rs` con tmux attach e gestione lifecycle terminali | `89874a7` |
| **[3]** | BE/FE | Riconoscimento sessioni esistenti e re-attach automatico all'avvio | `4dc1766` |
| **[4]** | FE | UI Squadra Agenti con avvio rapido PM, Dev1, Dev2, QA ed estensione dinamica | `a65a2d1` |
| **[5]** | QA | Validazione end-to-end, test suite completa e verifica runtime | Validated |
| **[6]** | FE | Selezione interattiva agente per PM unico, Dev incrementali e QA multipli | `34e06d9` |
| **[7]** | Fix | Sessioni raggruppate tmux, apertura selettiva terminali e attivazione interattiva PM | `265aa1b` |
| **[8]** | FE | Filtro sessioni agenti nella barra laterale per il solo progetto attivo | `7aa10d8` |
| **[9]** | BE/FE | Storico completo delle sessioni Claude per il progetto attivo (rimozione cutoff 24h) | `948af50` |
| **[10]** | Fix | Correzione ordine parametri `tmux.newWindow` per avvio comandi agenti | `1ef626b` |
| **[11]** | BE/FE | Re-attach automatico di tutte le finestre tmux per progetto e detach pulito | `ffe779c` |
| **[12]** | FE | Riorganizzazione layout a colonna singola sinistra con accordion stile VS Code | `51e06f5`, `32da598` |
| **[13]** | FE | Rimozione pulsante Agente dalla barra superiore e aggiunta sezione Generico sotto QA | `f35ea94` |
| **[14]** | FE | Traduzione completa dell'interfaccia utente (UI) in lingua inglese | `ee46b88` |
| **[15]** | Tooling | Tooling `tmux-dogwatch` per monitoraggio sessioni e protocollo escalation al PM | `57a691a` |

---

## 3. Protocolli Operativi & Multi-Agente

### 3.1 Flusso dei Ticket e Ruoli
1. **Senior PM (Gemini / Antigravity - `pm`)**:
   - Definisce i requisiti e redige i ticket su Plane con criteri di accettazione rigorosamente in lingua italiana.
   - È l'unico punto di contatto verso l'utente Flavio.
   - Valida le release e approva il passaggio a `Done`.
2. **Senior Developer (Claude Code / OpenCode - `dev1`, `dev2`)**:
   - Prende in carico i ticket in `Re-open` (priorità assoluta) o `Todo`.
   - Sposta il ticket in `In Progress` **prima** di toccare il codice.
   - Sviluppa, scrive test unitari ed esegue `npm test` + `cargo clippy`.
   - Sposta in `Test` allegando commento tecnico in italiano con file modificati e verifiche.
3. **QA Engineer (OpenAI Codex - `qa`)**:
   - Prende esclusivamente ticket in stato `Test`.
   - Esegue test end-to-end, prove runtime nel browser/tmux e controlla regressioni.
   - Se conforme: promuove a `Done` con report in italiano.
   - Se anomalo: riapre a `Re-open` con elenco dettagliato dei difetti.

### 3.2 Protocollo di Escalation e Sentinella Dogwatch
- **Principio fondamentale:** Nessun dev o QA deve richiedere input diretto all'utente.
- Lo script `scripts/tmux-dogwatch.py` scansiona continuamente le finestre tmux.
- Quando un agente si ferma su un prompt interattivo o domanda:
  - Genera un record in `.claude/escalation_to_pm.json`.
  - Il PM analizza la situazione:
    - **Risoluzione Autonoma:** Se la domanda riguarda dettagli tecnici o autorizzazioni coperte dalle specifiche, il PM risponde direttamente sul riquadro (`tmux-dogwatch.py answer <target> <testo>`).
    - **Escalation all'Utente:** Se la decisione riguarda aspetti di business o prodotto non determinabili a priori, il PM interpella l'utente. L'utente risponde **esclusivamente al PM**.
  - Il PM recapita notifiche e risposte dirette alla chat Telegram autorizzata con `scripts/telegram-pm.py send "<testo>"`, che usa il solo `chat_id` configurato.

### 3.3 Politica di Versionamento Release
Per ogni task completato e promosso allo stato **`Done`**:
- **Nuove Funzionalità / Task Ordinari:** incrementare la versione di **minor** (es. `v2.1.0` → `v2.2.0`, `v2.3.0`, …).
- **Bug Fix:** dal `Done` del task relativo alla risoluzione di un bug, incrementare la **patch** (es. `v2.1.0` → `v2.1.1`).
- L'aggiornamento di versione include `package.json`, `src-tauri/Cargo.toml`, rigenerazione di `src-tauri/Cargo.lock`, commit di rilascio (`chore(release): bump version to vX.Y.Z`) e creazione del relativo tag Git.

---

## 4. Convenzioni di Codice e Sicurezza

- **Lingua:**
  - Codice, commenti, funzioni, classi e variabili: **inglese**.
  - Interfaccia grafica (UI), tooltip, placeholder, menu e toast: **inglese**.
  - Issue tracker Plane (titoli, descrizioni, criteri e commenti): **italiano**.
- **Gestione Errori:**
  - I comandi backend Rust ritornano sempre `Result<T, String>` con messaggi significativi.
- **Sicurezza Filesystem (`Roots`):**
  - Ogni operazione di lettura/scrittura/eliminazione file deve validare il path rispetto ai progetti aperti (`fsops.rs::Roots`), bloccando tentativi di path traversal o symlink malevoli fuori cartella.
- **Git Commit Standard:**
  - Aderenza rigorosa a Conventional Commits (`feat(...)`, `fix(...)`, `test(...)`, `chore(...)`, `docs(...)`) citando sempre `Refs: WORKSTACK-<N>`.

---

## 5. Comandi di Verifica e Compilazione

```bash
# Esecuzione completa suite di test (Frontend node:test + Backend cargo test)
npm test

# Controllo linting e warning Rust
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings

# Controllo formattazione Rust
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check

# Avvio applicazione in modalità sviluppo
npm run dev

# Avvio con DevTools web abilitati
WORK_DEVTOOLS=1 npm run dev

# Compilazione binario di produzione (Release build)
npm run build
```

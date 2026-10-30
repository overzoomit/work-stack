# Work Stack — Istruzioni di Progetto & Linee Guida per Agenti

Dashboard desktop per sviluppatori (Linux e macOS) che unifica gestione multi-progetto, terminali PTY multipli, albero file con anteprima ed editing, Git/GitHub e monitoraggio degli agenti AI CLI.

---

## 1. Flusso Multi-Agente & Integrazione Plane

Il progetto è integrato con l'istanza Plane self-hosted (`https://plane.overzoom.it/overzoom/`).
Il project ID è memorizzato in `.plane.json` (`3b32410c-16cb-4315-a60e-84c0ce72f0fb`).

### CLI Plane Globale
Posizione script: `/home/flavio/.claude/scripts/plane_cli.py`
- Lista ticket attivi: `python3 /home/flavio/.claude/scripts/plane_cli.py list` (aggiungi `--all` per includere i chiusi)
- Ispeziona ticket: `python3 /home/flavio/.claude/scripts/plane_cli.py show <issue_uuid>`
- Mostra tutti i dettagli: `python3 /home/flavio/.claude/scripts/plane_cli.py show-all`
- Aggiorna stato e commento: `python3 /home/flavio/.claude/scripts/plane_cli.py update <issue_uuid> "<Stato>" "<Commento tecnico in italiano>"`
- Importa backlog: `python3 /home/flavio/.claude/scripts/plane_cli.py import <backlog.json>`

### Ruoli e Ciclo di Vita dei Ticket
1. **Senior PM (Gemini / Antigravity):**
   - Definisce i requisiti, scrive le specifiche e crea i ticket con criteri di accettazione rigorosamente in italiano.
   - Valida le release e approva le transizioni di milestone.
2. **Senior Developer (Claude Code / OpenCode dev1, dev2):**
   - Prende i ticket in `"Re-open"` (massima priorità!) o `"Todo"`.
   - Sposta il ticket in `"In Progress"` **prima** di toccare il codice.
   - Sviluppa, scrive test unitari/integrazione ed esegue l'intera suite (`npm test`).
   - Al completamento sposta il ticket in **`"Test"`** (MAI direttamente in `"Done"`!) allegando un commento in italiano che elenca file modificati e test eseguiti.
3. **QA Engineer (OpenAI Codex):**
   - Testa **solo** i ticket nello stato `"Test"` (test end-to-end, controlli runtime, regressioni).
   - Se i criteri sono superati: sposta in **`"Done"`** con report di QA in italiano.
   - In caso di anomalie/bug: sposta in **`"Re-open"`** con dettagliata descrizione del problema.

> **Regola Fondamentale:** Titoli, descrizioni, criteri di accettazione e tutti i commenti tecnici/QA su Plane devono essere scritti tassativamente in **lingua italiana**.

---

## 2. Architettura & Stack Tecnologico

- **Backend:** Rust stable (edition 2021) su **Tauri 2** (`src-tauri/`).
  - `src/main.rs`: builder Tauri e binding comandi IPC.
  - `src/pty.rs`: gestione sessioni terminale tramite `portable-pty` con controllo di flusso.
  - `src/git.rs` & `src/gitwatch.rs`: interazione con CLI `git` e watcher reattivo su `.git`.
  - `src/github.rs`: integrazione con `gh` CLI per workflow Actions, Secrets e Artifacts.
  - `src/agents.rs` & `src/claudeprocs.rs`: rilevamento e controllo dei processi e sessioni degli agenti AI CLI.
  - `src/fsops.rs`: operazioni sicure sui file (protezione sandbox con `Roots` / canonicalize).
  - `src/runconfigs.rs`: autodiscovery dei comandi di avvio del progetto.
  - `src/store.rs`: persistenza atomica dello stato tra sessioni.
  - `src/diag.rs`: logging diagnostico ed esportazione log.
  - `src/app.rs`: ciclo di vita finestra, menu di sistema e aggiornamenti.
- **Frontend:** Vanilla HTML/CSS/JavaScript (ES Modules puri in `src/renderer/`, senza bundler né framework).
  - `bridge.js`: espone l'API `window.work` sopra i comandi ed eventi IPC di Tauri.
  - Librerie vendor in `src/renderer/vendor/` (xterm.js 6, marked, DOMPurify) gestite da `scripts/vendor.mjs`.

---

## 3. Comandi di Sviluppo e Verifica

Prima di considerare conclusa qualsiasi modifica, verificare sempre:

```bash
# Esecuzione di tutti i test (Frontend node --test + Backend cargo test)
npm test

# Linting e controllo avvisi Rust
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings

# Verifica formattazione Rust
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check

# Avvio app in sviluppo
npm run dev

# Avvio con DevTools abilitati
WORK_DEVTOOLS=1 npm run dev
```

---

## 4. Convenzioni di Codice & Sicurezza

- **Lingua:**
  - Codice, nomi di funzioni, variabili e commenti nel sorgente: **inglese**. Commenti essenziali, focalizzati sul *perché*.
  - Interfaccia utente (UI), messaggi di errore creati nel frontend e notifiche toast: **inglese**. I messaggi di errore restituiti dal backend Rust sono ancora in italiano (da tradurre con un ticket dedicato).
  - Ticket e commenti Plane: **italiano**.
- **Gestione Errori:**
  - I comandi Tauri ritornano `Result<T, String>` con descrizioni chiare e comprensibili per l'utente.
- **Sicurezza Filesystem:**
  - Ogni operazione su file deve validare i percorsi rispetto ai progetti aperti (`Roots`), prevenendo traversal e puntatori fuori perimetro (symlink inclusi).
- **Git & Commit:**
  - Seguire rigorosamente lo standard Conventional Commits (`feat(...)`, `fix(...)`, `test(...)`, `chore(...)`, `docs(...)`).
- **Integrità dei Test:**
  - Non indebolire né saltare mai i test preesistenti. Nuove funzionalità o correzioni devono essere sempre accompagnate da opportuni test di unità o regressione.

## Agent skills

### Issue tracker

Plane, progetto WORKSTACK. Vedi `docs/agents/issue-tracker.md`.

### Domain docs

Single-context. Vedi `docs/agents/domain.md`.

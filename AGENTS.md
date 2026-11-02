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
> **Dettaglio Ticket per Agenti AI:** Poiché Plane è il portale operativo degli agenti AI, il **titolo** deve essere chiaro e comprensibile per gli umani (`Ambito: Descrizione sintetica`), mentre la **descrizione** deve essere **estremamente dettagliata per gli agenti AI**: percorsi esatti dei file coinvolti, contratti IPC completi (firme comandi, payload eventi, tipi Rust/TS), gestione esplicita delle race condition e dei casi limite, vincoli di sicurezza e test di regressione richiesti.

### Protocollo di Escalation e Sentinella tmux-dogwatch
Nessun dev o QA deve attendere una risposta diretta dall'utente. Tutte le domande e le richieste di conferma sono catturate da `scripts/tmux-dogwatch.py` e inoltrate al PM.

- La sentinella scansiona con `tmux capture-pane` le finestre `dev*`, `qa*` e `agent*` della sessione di progetto, riconoscendo conferme/autorizzazioni (es. `[y/N]`, `Do you want to proceed?`, `Enter to confirm`) e domande aperte.
- Quando una finestra si blocca, la sentinella crea o aggiorna `.claude/escalation_to_pm.json` con `target`, `question`, `prompt_type`, `options` e `timestamp`.
- Dentro Work la stessa funzione è nativa: `src-tauri/src/dogwatch.rs` interroga ogni 3 s la sessione dei progetti aperti, aggiorna `.claude/escalation_to_pm.json`, emette l'evento `dogwatch:update` (bridge: `window.work.dogwatch.onUpdate`) ed espone `dogwatch_inspect` / `dogwatch_answer` (`window.work.dogwatch.inspect/answer`). Un prompt è pendente solo finché nessun altro output lo segue. Lo stato appare nella Squadra Agenti.
- Se il PM può rispondere in autonomia (requisiti tecnici, permessi noti, architettura), risponde direttamente con `tmux-dogwatch.py answer` oppure `tmux send-keys`.
- Se serve una decisione di prodotto/business, il PM interpella l'utente. L'utente risponde **esclusivamente al PM**, che a sua volta risponde all'agente bloccato.
- **Canale Telegram ed Esterno:** **SOLO il PM interagisce con il Bot Telegram** e con l'utente da remoto. Nessun dev o QA invia, riceve o legge notifiche o messaggi diretti dal bot: tutte le interazioni con l'utente esterno avvengono esclusivamente mediate dal PM.
- Il PM invia notifiche o risposte dirette alla chat autorizzata con `python3 scripts/telegram-pm.py send "<testo>"`. Lo script legge token e `chat_id` salvati da Work alla connessione del bot (o da `WORK_TELEGRAM_TOKEN` / `WORK_TELEGRAM_CHAT_ID`) e non accetta destinatari alternativi. Work conserva la configurazione in `telegram.json` (permessi 0600) e la ripristina automaticamente al riavvio; il file viene rimosso solo con `Disconnect`.

```bash
# Controllo immediato (JSON su stdout + file di escalation)
python3 scripts/tmux-dogwatch.py --once --session <sessione>
python3 scripts/tmux-dogwatch.py --check --session <sessione>

# Sentinella continua
python3 scripts/tmux-dogwatch.py --daemon --interval 5

# Risposta del PM a una finestra bloccata
python3 scripts/tmux-dogwatch.py answer dev1 "sì, procedi"
```

### Sentinella plane-dogwatch (delega automatica dei ticket)
`scripts/plane-dogwatch.py` legge i ticket del progetto su Plane (`.plane.json`, chiave da `PLANE_API_KEY` o dal `plane_cli.py` globale) e li delega alle finestre della sessione tmux del progetto:
- `Re-open` (priorità massima): al dev che aveva il ticket, se libero, altrimenti al primo dev libero; il ticket passa a `In Progress` e il prompt include l'ultimo commento del QA.
- `Todo`: al primo dev libero (`--devs`, default `dev1,dev2`); il ticket passa a `In Progress` con commento automatico.
- `Test`: all'agente QA (`--qa`, default `dev2`), con l'ordine di spostare in `Done` o `Re-open`.
- `Done`: registrato; se il ticket era stato visto in un altro stato, notifica al PM via `scripts/telegram-pm.py`.

Un agente riceve un prompt solo se la sua finestra è inattiva e non ha già un ticket delegato in lavorazione. `.claude/plane_dogwatch_state.json` conserva stato, hash e timestamp di ogni ticket: un ticket invariato non viene mai delegato due volte.

Dentro Work la stessa funzione è nativa: `src-tauri/src/plane_dogwatch.rs` esegue un ciclo ogni 5 s per ogni progetto aperto con `.plane.json` e sessione tmux (QA: finestra `qa`, altrimenti `dev2`), emette l'evento `plane_dogwatch:update` ed espone `plane_dogwatch_status` / `plane_dogwatch_sync_now` (`window.work.planeDogwatch`). La Squadra Agenti mostra sotto ogni agente il ticket assegnato. Script e modulo nativo condividono il file di stato e tengono `.claude/plane_dogwatch.lock` per tutto il ciclo: possono girare insieme senza deleghe doppie.

```bash
python3 scripts/plane-dogwatch.py --once --session <sessione>    # un ciclo, JSON su stdout (--check è un alias)
python3 scripts/plane-dogwatch.py --daemon --interval 5          # polling continuo, termina pulito con SIGINT/SIGTERM
```

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

### Domain docs & Knowledge Base

- Glossario di dominio: [`GLOSSARY.md`](file:///home/flavio/workspace/work-stack/GLOSSARY.md)
- Knowledge Base architetturale consolidata: [`docs/KNOWLEDGE_BASE.md`](file:///home/flavio/workspace/work-stack/docs/KNOWLEDGE_BASE.md)
- Architecture Decision Records (ADR): [`docs/adr/`](file:///home/flavio/workspace/work-stack/docs/adr/)
- Dettaglio domain docs: [`docs/agents/domain.md`](file:///home/flavio/workspace/work-stack/docs/agents/domain.md)


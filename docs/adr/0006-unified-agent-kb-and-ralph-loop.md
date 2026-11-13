# ADR 0006: Knowledge Base Unificata tramite Link Simbolici e Pattern Ralph Loop per il Riallineamento SDD Post-Clear

## Stato
Accettato (Ticket Plane [71])

## Contesto
Work Stack orchestra una squadra multi-agente eterogenea (Claude Code, Antigravity/Gemini CLI, OpenCode/Ollama, Codex) che collabora sullo stesso repository:
1. **Dispersione e disallineamento della Knowledge Base:** ciascuna CLI ricerca le proprie istruzioni di contesto in file specifici (`CLAUDE.md`, `GEMINI.md`, `AGENTS.md`, `.claude/skills`, `.opencode/skills`), con il rischio di duplicazioni, divergenze di regole o perdita di coerenza della Software Design Description (SDD).
2. **Perdita di contesto dopo il reset (`/clear`):** quando un agente completa un task o viene ripulito via `/clear` (al passaggio del ticket a `Done`), la working memory volatile della sessione viene azzerata. Se il nuovo task delegato non include un protocollo rigoroso di re-ingestion, l'agente rischia di operare senza considerare la visione architetturale complessiva e i vincoli di sistema già definiti.

## Decisione

### 1. Architettura Single Source of Truth + Symlink Hub
- Centralizzare tutta la documentazione canonica di architettura, SDD, glossario e linee guida di sviluppo in `docs/`:
  - `docs/KNOWLEDGE_BASE.md`: specifica architetturale consolidata del progetto e contratti IPC/API.
  - `docs/agents/domain.md`: mappa della documentazione e glossario.
  - `docs/agents/rules.md`: regole operative comuni per la squadra (ruoli, flusso Plane, convenzioni commit, comandi test).
- Utilizzare link simbolici deterministici nella root del repository per collegare tutti i formati proprietari degli agenti a un unico punto di ingresso:
  - `AGENTS.md` -> `docs/agents/rules.md`
  - `CLAUDE.md` -> `AGENTS.md`
  - `GEMINI.md` -> `AGENTS.md`
- Mappare le cartelle delle skills condivise tra i diversi agenti tramite symlink (`.claude/skills` e `.opencode/skills` verso `docs/agents/skills`).
- Inserire in cima al file delle regole comuni un vincolo di sistema perentorio: ogni agente DEVE considerare `docs/KNOWLEDGE_BASE.md` come riferimento primario e obbligatorio prima di toccare qualsiasi riga di codice.

### 2. Protocollo "Ralph Loop" per il ciclo di sviluppo e re-ancoraggio SDD
Definire il pattern **Ralph Loop (R-A-L-P-H)** come ciclo di esecuzione canonico a convergenza per tutti gli agenti operativi (Dev e QA):

```
       [Done] ──> /clear (Reset sessione pulita)
                     │
                     ▼
           [R] Read SDD & KB (docs/KNOWLEDGE_BASE.md + Ticket Criteria)
                     │
                     ▼
           [A] Align & Plan (Verifica contratti IPC / DB / Architettura)
                     │
                     ▼
           [L] Lock & Implement (Sviluppo mirato + Test unitari)
                     │
                     ▼
           [P] Prove & Verify (npm test + cargo clippy) ──[Fallimento]──┐
                     │                                                  │
                 [Successo] ◄───────────────────────────────────────────┘
                     │
                     ▼
           [H] Hand-off (Transizione di stato su Plane con commento tecnico)
```

1. **`[R]` Read SDD & KB:** all'avvio di ogni task (specialmente dopo un `/clear`), l'agente legge i requisiti del ticket e richiama la SDD da `docs/KNOWLEDGE_BASE.md`.
2. **`[A]` Align & Plan:** pianifica il delta di modifica verificando che rispetti le decisioni architetturali (ADR) e i contratti IPC/DB esistenti.
3. **`[L]` Lock & Implement:** sviluppa il codice accompagnato dai relativi test di unità/integrazione.
4. **`[P]` Prove & Verify:** esegue `npm test` e `cargo clippy`. Se i test falliscono o emergono regressioni, il ciclo itera internamente su `L ↔ P` fino al completamento con successo.
5. **`[H]` Hand-off:** aggiorna lo stato su Plane (`In Progress` -> `Test` per il Dev, `Test` -> `Done` o `Re-open` per il QA) corredato da report tecnico in italiano.

### 3. Integrazione nel Dogwatch
- `scripts/plane-dogwatch.py` e `src-tauri/src/plane_dogwatch.rs` includono la struttura del Ralph Loop nei template dei prompt di delega a Dev e QA.

## Conseguenze
- **Vantaggi:** Nessuna duplicazione di istruzioni tra agenti; single source of truth garantita per la documentazione; gli agenti mantengono la bussola architetturale anche dopo reset continui del context window; eliminazione di allucinazioni e divergenze su contratti IPC e formati dati.
- **Limiti / Requisiti:** I link simbolici devono essere preservati su sistemi che supportano i symlink (Linux/macOS) e tracciati correttamente in Git.

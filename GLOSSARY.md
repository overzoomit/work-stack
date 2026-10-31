# Work Stack — Glossario & Concetti di Dominio

Questo documento raccoglie la terminologia ufficiale e i concetti fondamentali di **Work Stack** ad uso del team multi-agente (PM, Dev, QA) e dei manutentori del progetto.

---

### 1. Dominio & Architettura Desktop
- **Work Stack**: Dashboard desktop moderna per sviluppatori (Linux e macOS) costruita con **Tauri 2** (backend Rust stable) e **Vanilla ES Modules** (frontend web senza bundler).
- **Progetto (Project)**: Unità logica di lavoro rappresentata da un percorso locale su disco (`project.path`). Ogni progetto ha la sua tab attiva, stato Git, sessione tmux dedicata, terminali aperti e cronologia sessioni agenti.
- **PTY (Pseudoterminal)**: Gestore dei processi terminale basato sulla libreria Rust `portable-pty`. Ogni terminale in Work Stack è collegato a un PTY virtuale con controllo di flusso per visualizzare output VT100/xterm.js.
- **Roots**: Sistema di sandboxing e controllo accessi del filesystem implementato in `src-tauri/src/fsops.rs`. Qualsiasi operazione I/O deve verificare che il percorso ricada all'interno dei progetti attualmente aperti, prevenendo attacchi di path traversal e symlink traversal.

---

### 2. tmux & Terminal Orchestration
- **Sessione di Progetto (`work_<nome>_<hash>`)**: Sessione tmux nativa deterministica legata al path del progetto (`tmux.session_name_for_path`). Persiste in background indipendentemente dalla chiusura dell'interfaccia grafica.
- **Sessione Raggruppata (Grouped Session - `_pty_<id>`)**: Per ogni terminale aperto nella GUI di Work Stack viene creata una sessione temporanea raggruppata agganciata alla sessione del progetto. Questo consente a finestre e riquadri diversi di visualizzare contemporaneamente finestre tmux differenti senza vincolare la vista globale.
- **Auto Re-Attach**: Al caricamento o apertura di un progetto (`terminals.js::ensureInitialTerminal`), Work Stack interroga le finestre esistenti nella sessione tmux (`listWindows`) e riaggancia automaticamente tutti i terminali preesistenti (`pm`, `dev*`, `qa*`, `agent*`, `shell`).
- **Clean Detach**: Alla chiusura di un singolo riquadro o dell'intera applicazione, Work Stack invia il comando di detach/kill unicamente sulla sessione temporanea `_pty_<id>`, preservando intatte la sessione del progetto e i processi agenti in background.

---

### 3. Squadra Agenti (Multi-Agent Team Orchestration)
- **Senior PM (Project Manager)**: Unico per progetto (`pm`). Responsabile dell'architettura, definizione requisiti, apertura ticket Plane in lingua italiana e approvazione milestone. Interfaccia unica verso l'utente Flavio.
- **Senior Developer (`dev1`, `dev2`, ...)**: Sviluppatori con conteggio progressivo. Prendono in carico ticket in stato `Re-open` o `Todo`, sviluppano codice e test, e avanzano in stato `Test`.
- **QA Engineer (`qa`, `qa1`, ...)**: Verificatore della qualità. Testa esclusivamente i ticket in stato `Test` con verifiche automatizzate e runtime. Promuove a `Done` o rimanda a `Re-open`.
- **Agente Generico (`agent1`, `agent2`, ...)**: Istanze di agenti CLI svincolate dai ruoli rigidi di squadra, utilizzabili per esplorazioni o compiti liberi.
- **Agent Picker (`AGENTS`)**: Registro degli agenti CLI supportati: Claude Code, Antigravity (AGY), OpenAI Codex, Google Gemini CLI, OpenCode (Ollama DeepSeek), Sourcegraph Amp, Qwen Code, Goose.

---

### 4. Protocollo di Escalation & Dogwatch
- **Dogwatch (`scripts/tmux-dogwatch.py` & backend Rust `dogwatch`)**: Sentinella reattiva in ascolto continuo sulle finestre tmux degli agenti. Rileva prompt bloccanti, conferme (`Do you want to proceed?`, `[y/N]`) e richieste di chiarimento.
- **Canale di Escalation (`.claude/escalation_to_pm.json`)**: File strutturato in cui la sentinella registra i blocchi degli agenti con target, domanda, opzioni e timestamp.
- **Risoluzione Autonoma**: Capacità del PM di rispondere direttamente a un agente bloccato senza disturbare l'utente quando la risposta è desumibile da requisiti e architettura.
- **Interazione Utente Esclusiva**: Regola ferrea per cui l'utente parla unicamente con il PM. Nessun developer o QA può richiedere risposte dirette all'utente.

---

### 5. Layout & Interfaccia Utente
- **2-Column Layout**: Struttura a due colonne composta da Sidebar Sinistra Unificata e Area Terminali centrale/destra estesa a tutto schermo.
- **Accordion Sections**: Sezioni a fisarmonica nella sidebar sinistra (`src/renderer/accordion.js`) conformi allo stile VS Code:
  - `Agents`: Sempre aperta di default.
  - `Project`: Albero file e navigazione, chiusa di default.
  - `Changes`: Interfaccia Git (diff, branch, staging, commit), chiusa di default.
  - `Graph`: Grafo commit Git con rendering on-demand, chiusa di default.
  - `GitHub`: Workflow actions, secret sheet e artifacts, chiusa di default.
  - `Run`: Autodiscovery configurazioni di esecuzione comandi e console output, chiusa di default.
- **Language Policy**: Interfaccia grafica (UI, tooltip, etichette, dialoghi e notifiche toast) interamente in **lingua inglese**. Ticket, descrizioni e report su Plane rigorosamente in **lingua italiana**.

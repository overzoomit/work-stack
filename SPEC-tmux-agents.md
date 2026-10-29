# Spec: Orchestrazione Tmux e Squadre di Agenti AI in Work Stack

## 1. Visione e Obiettivo
Work Stack evolve il proprio sottosistema di terminali sostituendo le singole shell PTY isolate con sessioni native gestite da **tmux**.
In questo modo:
1. **Tutti i terminali** di un progetto diventano finestre o pane di una sessione tmux dedicata a quel progetto.
2. I processi degli agenti e delle shell diventano **persistenti**: la chiusura dell'app o un riavvio non interrompe i task in esecuzione; all'avvio Work Stack si riallaccia automaticamente (**re-attach**) a tutte le finestre esistenti.
3. Nasce la funzionalità **"Squadra Agenti" (Agent Team)**: con un solo clic è possibile avviare e orchestrare la squadra completa di sviluppo multi-agente (1 PM Antigravity, 2 Dev OpenCode via Ollama DeepSeek, 1 QA OpenAI Codex), visualizzata in griglia su Work Stack con ruoli e badge distinti, con la possibilità di aggiungere dinamicamente nuovi agenti al volo.

---

## 2. Architettura Tecnica

### 2.1 Backend Rust (`src-tauri/`)
- **Modulo dedicato `src-tauri/src/tmux.rs`**:
  - Verifica disponibilità binario `tmux` nel PATH di sistema. Se assente, notifica all'utente con guida all'installazione.
  - Generazione nome univoco e deterministico della sessione tmux per ciascun progetto aperto (es. `work_<sanitized_name>_<hash>`).
  - Funzioni di controllo CLI di tmux:
    - `has_session(session: &str) -> bool`
    - `ensure_session(session: &str, cwd: &Path) -> Result<(), String>`
    - `list_windows(session: &str) -> Result<Vec<TmuxWindow>, String>`
    - `new_window(session: &str, name: &str, cwd: &Path, command: Option<&str>) -> Result<String, String>` (restituisce `window_id`)
    - `kill_window(session: &str, window_id: &str) -> Result<(), String>`
    - `send_keys(session: &str, target: &str, keys: &str) -> Result<(), String>`
    - `capture_pane(session: &str, target: &str) -> Result<String, String>`
- **Modifica a `src-tauri/src/pty.rs`**:
  - `PtyManager::spawn`: quando tmux è disponibile, il processo slave eseguito nel PTY aperto da `portable-pty` non è una shell generica, bensì `tmux attach-session -t <session>:<window_id>`.
  - Dimensionamento del terminale (righe e colonne) inoltrato via PTY e sincronizzato con la finestra tmux tramite segnali standard SIGWINCH.
  - Chiusura di una scheda terminale nella UI: distacca il client o chiude la finestra tmux a seconda della scelta dell'utente.

### 2.2 Re-attach Automatico all'Avvio
- Quando Work Stack si apre o l'utente cambia progetto attivo:
  - Invoca `tmux_sync_project(project_path)`: interroga la sessione tmux associata.
  - Se la sessione esiste ed ha finestre attive, Work Stack crea i riquadri dell'interfaccia collegandosi a ciascuna finestra esistente, preservando l'output e il contesto.
  - Se la sessione non esiste ancora, viene creata con una prima finestra shell standard.

### 2.3 Frontend & Interfaccia Utente (`src/renderer/`)
- **Nuovo pulsante "👥 Squadra Agenti" nella barra dei terminali**:
  - Popover rapido con azione principale: **"Inizializza Squadra (PM + 2 Dev + QA)"**.
  - Comandi standard di avvio squadra:
    - **Finestra `pm`:** `agy --dangerously-skip-permissions` (Senior PM & Architect)
    - **Finestre `dev1` e `dev2`:** `ollama launch opencode --model deepseek-v4.1-flash:cloud` (Senior Developers)
    - **Finestra `qa`:** `codex --dangerously-bypass-approvals-and-sandbox` (QA Engineer)
  - Badge identificativi sul riquadro di ciascun terminale: pillola colorata con il ruolo (`[PM]`, `[DEV1]`, `[DEV2]`, `[QA]`, o `[SHELL]`).
  - Azione **"＋ Aggiungi Agente"**: apre il selettore per aggiungere una nuova finestra tmux con uno qualsiasi degli agenti configurati in `launcher.js` (Claude Code, Gemini, Copilot, OpenCode, Aider, ecc.).

---

## 3. Strategia di Test & Validazione
- Test unitari in Rust (`tmux.rs`) con parsing dell'output di `tmux list-windows`, formattazione nomi sessione e gestione errori quando tmux non è presente.
- Test di integrazione frontend (`test/terminals.test.mjs` e nuovi test dedicati) per la gestione della griglia, badge dei ruoli e re-attaching.
- Verifica manuale dell'avvio della sessione `work-stack` con la squadra al completo in contemporanea.

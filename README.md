# Work Stack

Desktop dashboard per sviluppatori (Linux e macOS) che unifica gestione multi-progetto, orchestrazione di terminali tmux, Squadra Agenti AI, albero file con editing e anteprima, Git/GitHub, sentinella Dogwatch e ponte remoto Telegram per il PM.

---

## Avvio Rapido

```bash
npm install
npm run dev                                  # Avvia nella cartella corrente
WORK_CWD=~/progetti/mio-repo npm run dev     # Avvia direttamente su un repository specifico
npm run build                                # Genera i pacchetti in src-tauri/target/release/bundle/
npm run install:linux                        # Linux: compila e installa in ~/.local/bin e icone desktop
```

### Prerequisiti
- **Node.js** 22+ e **Rust** stable ([rustup.rs](https://rustup.rs)).
- **Git** e **tmux** (consigliato per la gestione avanzata delle sessioni).
- **Linux (Ubuntu/Debian/Arch)**: librerie Tauri (`libwebkit2gtk-4.1-dev`, `build-essential`, `libssl-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`).

### Comando da Terminale: `work .`
`work <cartella>` apre la cartella indicata come progetto attivo (riutilizzando una finestra aperta, se presente). `work` senza argomenti ripristina la sessione e i progetti salvati.

---

## Funzionalità Principali

### 1. Squadra Agenti AI (Agent Team)
- **Ruoli strutturati**:
  - **PM unico** (`0:pm`): coordinamento del progetto, requisiti, convalida delle release e canale unico con l'esterno.
  - **Developers incrementali** (`dev1`, `dev2`, ...): sviluppo, test unitari e avanzamento task.
  - **QA Engineers multipli** (`qa1`, `qa2`, ...): validazione end-to-end, test runtime e controlli di regressione.
  - **Agenti Generici** (`agent1`, `agent2`, ...): task ad-hoc e supporto operativo.
- **Supporto multi-CLI**: avvio nativo di Claude Code, Antigravity CLI, OpenCode, Codex, Gemini CLI, Copilot CLI, Aider, Qwen Code, Goose. Flag **bypass permessi** configurabile per singolo agente.

### 2. Orchestrazione tmux Nativa
- **Adozione automatica delle sessioni**: all'apertura del progetto, work adotta automaticamente la sessione tmux denominata come la cartella (es. `work-stack`) o genera una sessione deterministica `work_<nome>_<hash>`.
- **Re-attach intelligente**: riaggancia istantaneamente tutte le finestre tmux esistenti al riavvio.
- **Riquadri terminale puliti**: disattivazione automatica della status bar tmux interna ai riquadri dell'interfaccia, mantenendola attiva nei client esterni. Detach pulito alla chiusura dell'app.

### 3. Sentinella Dogwatch & Diodo "Live"
- **Rilevamento intelligente dei prompt**: intercetta i blocchi interattivi degli agenti (`[y/N]`, `Do you want to proceed?`, conferme, menu e domande con `?`) filtrando automaticamente i log storici per prevenire falsi positivi.
- **Indicatore visivo LED nella barra superiore**:
  - 🟢 **Verde acceso ("Live")**: Dogwatch attivo e in ascolto sulla sessione tmux del progetto.
  - ⚫ **Grigio spento ("Off")**: nessuna sessione tmux attiva per il progetto.
  - 🟠 **Arancione pulsante**: uno o più agenti sono in attesa di risposta (escalation).
- **Protocollo di escalation**: nessun dev o QA attende l'utente. Tutte le richieste passano dal PM, che risponde in autonomia o le inoltra all'utente se richiedono scelte di business.

### 4. Canale Remoto Telegram (PM-Only)
- **Ponte bidirezionale**: controllo remoto del PM direttamente da smartphone via Telegram quando sei lontano dalla postazione.
- **Guida integrata `@BotFather`**: configurazione guidata con token e chat ID autorizzato.
- **Isolamento e sicurezza ferrei**: canale riservato **esclusivamente al PM**. Nessun dev o QA interagisce con il bot.

### 5. Layout a Colonna Singola con Accordion (Stile VS Code)
Sidebar sinistra riorganizzata in sezioni espandibili e richiudibili:
- **Agenti**: sessioni transcript, stato runtime dei processi e pulsanti rapidi (Riprendi, Chiudi, Terminale).
- **Project**: albero file con anteprima integrata (Markdown/HTML renderizzati), modifica del testo UTF-8 e sicurezza sandbox vincolata ai percorsi di progetto (`Roots`).
- **Changes**: staging/unstage atomico, scarto modifiche, commit e diff affiancato/unificato con evidenziazione parola per parola.
- **Graph**: albero visivo dei commit e dei branch con navigazione interattiva.
- **GitHub**: integrazione con `gh` CLI per monitorare workflow Actions, Secrets del repository e Artifacts.
- **Run**: autodiscovery ed esecuzione dei comandi di avvio del progetto (npm, Make, Cargo, Django, Go, Docker Compose).

### 6. Strumenti Browser & MCP (Model Context Protocol)
- Preservazione automatica dell'ambiente grafico (`DISPLAY`, `WAYLAND_DISPLAY`, `DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR`) nei processi PTY e tmux.
- Rilevamento dello stato e comandi di verifica rapida per Firefox DevTools, Chrome (remote debugging porta 9222) e Plane MCP.

### 7. Nuovo Logo "B · Flow" & Dimensionamento KDE Nativo
- Icona vettoriale scalabile a pieno riempimento canvas, perfettamente proporzionata per KDE Plasma (Breeze), GNOME e macOS Dock.
- Set completo di icone raster da 32x32 fino a 512x512 px.

---

## Scorciatoie da Tastiera

| Tasti | Azione |
|---|---|
| `Ctrl+Shift+P` / `⌘P` | Ricerca rapida file nel progetto (fuzzy match) |
| `Ctrl+Shift+F` | Ricerca testo nel progetto |
| `Ctrl+Shift+T` | Nuovo terminale |
| `Ctrl+Shift+W` | Chiudi terminale attivo |
| `Ctrl+Shift+M` | Ingrandisci / riduci terminale |
| `Ctrl+Shift+B` | Mostra / nascondi barra laterale |
| `Ctrl+Shift+O` | Apri un altro progetto |
| `⌘S` / `Ctrl+S` | Salva file in modifica |
| `Ctrl+Enter` | Esegui commit |
| `F5` | Ricarica albero file e stato Git |
| `Shift+F10` | Avvia configurazione Run selezionata |
| `Ctrl+F2` | Ferma processo Run attivo |
| `F7` / `Shift+F7` | Modifica successiva / precedente nel diff |

---

## Architettura del Progetto

```
work-stack/
├── src-tauri/               # Backend nativo in Rust (Tauri 2)
│   ├── src/main.rs          # Bootstrap, binding comandi IPC e lifecycle
│   ├── src/tmux.rs          # Gestione sessioni e finestre tmux
│   ├── src/dogwatch.rs      # Watcher nativo prompt agenti e Live LED
│   ├── src/telegram.rs      # Bridge Telegram Bot e polling PM-only
│   ├── src/mcp.rs           # Rilevamento server MCP e strumenti browser
│   ├── src/pty.rs           # Gestione terminali virtuali PTY (portable-pty)
│   ├── src/git.rs           # Operazioni Git tramite CLI
│   ├── src/gitwatch.rs      # Watcher reattivo sul filesystem .git
│   ├── src/github.rs        # Wrapper GitHub CLI (gh)
│   ├── src/agents.rs        # Rilevamento sessioni transcript agenti AI
│   ├── src/fsops.rs         # Operazioni filesystem sandboxate (Roots)
│   ├── src/runconfigs.rs    # Autodiscovery dei comandi di avvio
│   └── src/store.rs         # Persistenza atomica dello stato applicativo
├── src/renderer/            # Frontend Web (Vanilla ES Modules, senza bundler)
│   ├── bridge.js            # API window.work sopra i comandi ed eventi Tauri
│   ├── app.js               # Gestione progetti e layout principale
│   ├── accordion.js         # Sezioni collapsible stile VS Code
│   ├── team.js              # Interfaccia Squadra Agenti e controlli Telegram
│   ├── terminals.js         # Gestione griglia terminali e auto-attach
│   ├── tree.js              # Albero dei file e navigazione
│   ├── diff.js              # Viewer diff affiancato e unificato
│   ├── preview.js           # Anteprima e modifica file
│   └── style.css            # Design system scuro e responsivo
├── scripts/
│   ├── tmux-dogwatch.py     # Sentinella CLI per monitoraggio e sblocco tmux
│   ├── telegram-pm.py       # Helper CLI per invio notifiche dirette dal PM
│   └── install-linux.sh     # Script di installazione icone e binario Linux
└── test/                    # Suite di test Node.js e verifiche frontend
```

---

## Test & Qualità del Codice

Prima di ogni commit o passaggio di stato dei ticket, viene sempre verificata l'intera suite:

```bash
# Esecuzione di tutti i test (Frontend Node.js + Backend Rust)
npm test

# Linting e controllo avvisi Rust
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings

# Controllo formattazione Rust
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

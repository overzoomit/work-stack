<div align="center">

<img src="assets/readme-hero.svg" alt="Work Stack — The Agent-Native Developer Workspace" width="100%">

<h3>The Agent-Native Developer Workspace</h3>

<p>
A developer desktop workspace uniting multi-project management, persistent tmux terminals,<br>
an orchestrated AI agent squad, docked browser, Git/GitHub, Fleet Analytics, and remote control — in a single window.
</p>

<p>
  <a href="https://github.com/overzoomit/work-stack/releases"><img alt="Version" src="https://img.shields.io/badge/version-2.17.0-7c3aed?style=flat-square"></a>
  <img alt="Rust 2021" src="https://img.shields.io/badge/Rust-2021-dea584?style=flat-square&logo=rust&logoColor=white">
  <img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-24c8db?style=flat-square&logo=tauri&logoColor=white">
  <img alt="Linux and macOS" src="https://img.shields.io/badge/Linux%20%C2%B7%20macOS-supported-0ea5e9?style=flat-square&logo=linux&logoColor=white">
  <img alt="Tests passing" src="https://img.shields.io/badge/tests-passing-30d158?style=flat-square&logo=githubactions&logoColor=white">
  <img alt="tmux" src="https://img.shields.io/badge/tmux-required-1bb91f?style=flat-square&logo=tmux&logoColor=white">
  <img alt="License" src="https://img.shields.io/badge/license-private-64748b?style=flat-square">
</p>

<p>
  <a href="#-why-work-stack">Why Work Stack</a> ·
  <a href="#-agent-squad--mission-control">Agent Squad & Mission Control</a> ·
  <a href="#-omni-command-palette-ctrlk">Command Palette</a> ·
  <a href="#-docked-webview--live-browser">Docked Webview</a> ·
  <a href="#-smart-diff-lens">Smart Diff Lens</a> ·
  <a href="#-fleet-analytics-dashboard">Fleet Analytics</a> ·
  <a href="#-time-machine--session-scrubber">Time-Machine</a> ·
  <a href="#-cyberpunk-audio--voice-notes">Audio & Voice</a> ·
  <a href="#-dogwatch--plane-sentinel">Dogwatch & Plane</a> ·
  <a href="#-telegram-multi-pm-remote-bridge">Telegram Multi-PM</a> ·
  <a href="#-quick-start">Quick start</a>
</p>

</div>

---

## ✦ Why Work Stack

| Advantage | In Practice |
|---|---|
| **One Workspace for Everything** | Responsive project tabs, persistent tmux terminals with native split-pane, file tree, Smart Diff Lens, GitHub Actions, and live browser in a single native app. |
| **Agents Never Stop Working** | PM, Dev, QA, Doc, and Generic run in persistent tmux sessions per project. Restart or close the app: upon returning, processes are alive and scrollback history intact. |
| **High-Velocity Interface** | Omni-Command Palette (`Ctrl+K`), in-buffer search (`Ctrl+F`), interactive Mission Control canvas, and Time-Machine scrubber to inspect and fork past terminal history. |
| **Nobody Waits for Humans** | Dogwatch watchdog with TOML manifests, "Needs You" fast-action deck, automated Plane ticket delegation, and Telegram Multi-PM bridge with voice notes and oz-standard tags. |

```console
$ npm install && npm run dev
```

---

## 👥 Agent Squad & Mission Control

Five role families, progressively numbered tmux windows, and dedicated role badge tints. Launch every role with its default CLI or choose from an interactive catalog of 12 agentic CLIs with per-agent permission bypass switches.

| Role | Window | Default CLI | Badge | Description |
|---|---|---|---|---|
| **PM** | `pm` | Antigravity `agy` | ![](https://img.shields.io/badge/PM-Antigravity-a855f7?style=flat-square) | Requirements, specifications, governance, and releases |
| **DEV** | `dev1`, `dev2`, … | OpenCode on Ollama (DeepSeek) | ![](https://img.shields.io/badge/DEV-OpenCode-0ea5e9?style=flat-square) | Implementation, refactoring, and unit tests |
| **QA** | `qa`, `qa1`, … | OpenAI Codex | ![](https://img.shields.io/badge/QA-Codex-10b981?style=flat-square) | E2E validation, regression tests, and verification reports |
| **DOC** | `doc1`, `doc2`, … | Claude Code | ![](https://img.shields.io/badge/DOC-Documentation-3b82f6?style=flat-square) | Documentation, guides, ADRs, and knowledge base |
| **GENERIC** | `agent1`, `agent2`, … | Any catalog CLI | ![](https://img.shields.io/badge/AGENT-Generic-f59e0b?style=flat-square) | Ad-hoc tasks, migrations, and support scripts |

> Windows reside inside the project's tmux session, which adds its index (`0:pm`, `1:dev1`, `2:dev2`, `3:qa`, `4:doc1`, …).

Numbering is **incremental**: add `dev3`, `qa2`, `doc2`, or `agent2`, and the role inherits command, hints, and color. The role badge coexists with the **detected CLI badge** running inside the window.

<details>
<summary><b>Supported CLI Catalog</b> (12 agents, native launch, and permission bypass flags)</summary>

| Agent | Command | Bypass Flag |
|---|---|---|
| Claude Code | `claude` | `--dangerously-skip-permissions` |
| Antigravity | `agy` | `--dangerously-skip-permissions` |
| OpenAI Codex | `codex` | `--dangerously-bypass-approvals-and-sandbox` |
| Gemini CLI | `gemini` | `--yolo` |
| Copilot CLI | `copilot` | `--allow-all-tools` |
| OpenCode | `opencode` | — |
| Ollama OpenCode | `ollama launch opencode --model deepseek-v4.1-flash:cloud` | — |
| Aider | `aider` | `--yes-always` |
| Cursor Agent | `cursor-agent` | `--force` |
| Amp | `amp` | `--dangerously-allow-all` |
| Qwen Code | `qwen` | `--yolo` |
| Goose | `goose session` | — |

</details>

### 🛸 Mission Control Canvas
An interactive reactive SVG node canvas mapping the agent squad:
- Visualizes the full topology of the team and active terminal panes.
- Displays the assigned Plane ticket, role, and real-time state (`idle`, `working`, `blocked`).
- Emits animated particle streams between PM, Dev, and QA during task transitions.
- Click any node to instantly focus its respective terminal window.

### 🚨 "Needs You" Attention Center
When one or more agents encounter a confirmation prompt (`[y/N]`, numbered menu, or open question), the **Needs You** card appears prominently at the top of the Agent Squad. Resolve prompts with 1-click recommended options or custom input without hunting down individual terminals.

### Topbar Live LED Diode
| LED | Meaning |
|---|---|
| 🟢 **Live** | Dogwatch is active and monitoring the active project's tmux session. |
| 🟠 **Blocked** | One or more agents are awaiting input or confirmation: pending escalation. |
| ⚫ **Off** | No active tmux session for the current project. |

---

## ⌨️ Omni-Command Palette (Ctrl+K)

Universal modal command bar to govern your entire development workspace without taking your hands off the keyboard (`Ctrl+K`, `⌘K` on macOS):

- **Unified Fuzzy Search**: type to search instantly across:
  - Files in the open project (with relative path preview).
  - Local and remote Git branches (with instant checkout).
  - Squad agents (instant tmux window focus).
  - Plane backlog tickets (inspect and switch).
  - System quick commands (new terminal, split, agent with prompt, ngrok, settings).
- **Zero Interference**: robust concurrency management that cancels outdated queries and restores cursor focus on dismiss (`Esc`).

---

## 🌐 Docked Webview & Live Browser

A lightweight browser docked inside your terminal grid as a split pane with a **WEB** badge:

- **Contextual Launch**: splits open automatically when a dev server prints a local address (*"Web server detected"* toast → **Open in Preview**), from the **Preview** button in the Run bar, from the terminal context menu, or from the terminal header.
- **Address Autodiscovery**: recognizes `localhost`, `127.0.0.1`, `0.0.0.0`, or `[::1]` with any port (3000, 5173, 8080, custom ports).
- **Complete Navigation Bar**: URL input, back/forward, reload, and open in external default browser.
- **Responsive Viewport**: **Desktop** and **Mobile** presets for immediate layout validation.
- **1-Click QA Snapshot**: captures the screen using available system utilities (`grim`, `spectacle`, `gnome-screenshot`, ImageMagick) and saves PNGs directly to `snapshots/` with toast to reveal in file manager.

---

## 🔍 Smart Diff Lens

Inside the Git changes viewer, the Smart Diff Lens provides automatic, deterministic diff analysis without external API dependencies:

- **Contextual Change Explanations**: summarizes touched files, added/removed lines, introduced symbols, and affected architectural areas for both working tree and staged index.
- **Conventional Commit Generator**: proposes commit messages adhering strictly to the Conventional Commits specification (`feat(...)`, `fix(...)`, `test(...)`, `chore(...)`) based solely on staged modifications, fully editable before commit.
- **Intelligent Truncation**: gracefully handles large diffs to keep the interface fast while preserving relevant code context.

---

## 📊 Fleet Analytics Dashboard

Real-time telemetry and performance metrics for the agent squad:

- **Operational KPIs**: tokens consumed (with estimated cost per model), average Dev→QA→Done cycle times, first-pass QA pass-rate, and session counts.
- **Native SVG Visualizations**: sparklines for closed tickets and active sessions, plus horizontal usage bars by model (zero external charting libraries).
- **Per-Agent Breakdown**: sessions, tokens, estimated cost, and average duration for each CLI (Claude Code, Antigravity, OpenCode, Codex), parsed from native agent log files.

---

## ⏳ Time-Machine & Session Scrubber

Never lose terminal output or historical compiler diagnostics:

- **Interactive Scrollback Timeline**: records periodic snapshots of tmux terminal buffers, preserving meaningful output changes.
- **Visual Scrubber**: slide backward in time to inspect exactly what an agent was printing minutes or hours ago.
- **Fork Session**: spawns a new tmux window in the same directory, pre-loaded with the selected historical snapshot context.

---

## 🔊 Cyberpunk Audio & Voice Notes

A sensory experience tailored for autonomous development:

- **Procedural Audio Synthesizer**: crafted with native Web Audio API (zero bulky audio assets), producing pleasant contextual cues for squad launch, ticket completion, incoming messages, and critical Dogwatch blocks.
- **Telegram Voice Notes**: voice memos sent to the PM bot are cached and passed to the PM terminal with the audio file path ready for transcription.

---

## 🧵 tmux Orchestration & Terminals

<img src="assets/readme-orchestration.svg" alt="Work orchestration: PTY panes attached to one persistent tmux session, work-agent CLI and remote surfaces" width="100%">

- **One Persistent Session per Project**: Work adopts an existing tmux session matching the folder name (e.g., `work-stack`) or spawns a deterministic hashed session `work_<name>_<hash>`.
- **Native PTYs with Split-Pane**: each pane is an isolated `portable-pty` terminal (xterm.js 6) supporting native horizontal and vertical splits, resizing, flow control, and acknowledgments.
- **In-Buffer Search (`Ctrl+F`)**: integrated search bar with concurrent match highlighting and match counters.
- **Graceful Detach & Auto Re-attach**: cleanly detaches when closing the app; reattaches all surviving windows on launch.
- **Remote SSH Projects**: transparent management of remote tmux sessions over `ssh -t`.

---

## 👁 Dogwatch & Plane Sentinel

Dogwatch is the **reactive sentinel** of the squad: detects when an agent blocks, classifies the prompt, and delivers it to the PM.

<img src="assets/readme-dogwatch.svg" alt="Dogwatch state machine: TOML manifests, shared snapshot, escalation and project live LED" width="100%">

- **Declarative TOML Manifests**: `src-tauri/detect/manifests/*.toml` define regex rules, priority levels, and prompt types (`confirm`, `question`, `menu`).
- **Shared Snapshot & Atomic Lock**: app, scripts, and CLIs share `.claude/dogwatch_state.json`.
- **Autonomous PM Relay**: when a worker window (`dev1`, `qa1`, `doc1`) blocks on a prompt, Dogwatch automatically relays the question to the PM (`0:pm`) terminal as soon as it is idle. The PM can answer directly with `python3 scripts/tmux-dogwatch.py answer <target> "<answer>"` or escalate to the human user via Telegram.

### Automated Plane Ticket Delegation
`plane_dogwatch` (native Rust module and Python daemon) connects Plane backlog tickets to project tmux windows with oz-standard `[{project}]` notification tags:

```text
Re-open ──▶ to original dev (or first free dev) ──▶ In Progress
Todo    ──▶ to first free dev                   ──▶ In Progress
Test    ──▶ to qa1 / qa                         ──▶ Done or Re-open
Done    ──▶ notifies PM on Telegram with [project] tag
```

---

## ⌨️ Inter-Agent CLI `work-agent`

Deterministic CLI protocol for agent coordination across tmux windows:

```bash
# Check who is present, with which CLI, and in what state
$ python3 scripts/work-agent.py list
dev1	idle	opencode
qa1	idle	codex

# Assign a task to another window
$ python3 scripts/work-agent.py prompt dev1 "run the regression suite"

# Wait until target returns to idle
$ python3 scripts/work-agent.py wait dev1 --until idle --timeout 600

# Read the last lines stripped of ANSI and box borders
$ python3 scripts/work-agent.py read dev1 --lines 40 --clean
```

---

## 🌐 Telegram Multi-PM Remote Bridge

Remote control from your smartphone for multi-project workflows:

- **Multi-Project Routing**: a single Telegram bot manages all active Work Stack projects.
- **Integrated Commands**:
  - `/projects`: lists all open projects with active status and tmux sessions.
  - `/use <name or index>`: pins the target to a specific project.
  - `/use auto`: restores automatic routing following the currently active Work window.
  - `@<project> <message>`: sends a one-shot prompt directly to the PM of that project.
  - **Reply-to-Thread Routing**: replying to a notification (such as ticket completion) routes your message back to the PM of that specific repository.
- **oz-Compliant Tags**: completed tickets prepend the repository tag (`[work-stack] ✅ Ticket [63] completed...`), ensuring clear context and bidirectional message routing.

---

## 🧭 Layout & Feature Matrix

Single-column sidebar with collapsible **accordion** sections in VS Code style:

<img src="docs/screenshot.webp" alt="Work Stack window featuring accordion sidebar, tmux terminal grid for PM, Dev, and QA, and Live LED indicator in topbar" width="100%">

| Area | Features Included | Status |
|---|---|---|
| **Projects** | Responsive tabs with horizontal scroll, persistence, CLI launch (`work .`), SSH projects | ✅ |
| **Terminals** | PTY grid, horizontal/vertical splits, in-buffer search (`Ctrl+F`), persistent tmux | ✅ |
| **Agent Squad** | PM, DEV, QA, DOC, GENERIC, dynamic numbering, 12 CLIs, tint badges, real process detection | ✅ |
| **Mission Control** | Interactive SVG node canvas, animated particle streams, live task states | ✅ |
| **Needs You** | Prominent spotlight card for instant resolution of Dogwatch prompts | ✅ |
| **Command Palette** | Universal modal palette (`Ctrl+K`) with fuzzy search on files, branches, tickets, and actions | ✅ |
| **Docked Webview** | Browser docked alongside code (`Preview` from toast/Run/menu), local URL autodiscovery, QA snapshots | ✅ |
| **Smart Diff Lens** | Automatic deterministic diff explanations and Conventional Commits generation | ✅ |
| **Fleet Analytics** | Real-time telemetry: tokens, costs, cycle times, QA pass-rate, native SVG graphs | ✅ |
| **Time-Machine** | Terminal scrollback scrubber with timeline snapshots and session forking | ✅ |
| **Cyberpunk Audio** | Procedural Web Audio synthesizer, event notifications, Telegram voice memo relay | ✅ |
| **Telegram Multi-PM**| Multi-project control, `/projects` and `/use` commands, reply tracking, oz tags | ✅ |
| **Dogwatch & PM Relay** | TOML manifests, Live/Blocked/Off LED, automatic relay to idle PM (`0:pm`) with autonomous answers | ✅ |
| **Plane-Dogwatch** | Autonomous Plane ticket delegation, bidirectional sync, shared file lock | ✅ |
| **work-agent** | Inter-agent coordination CLI (`list`, `prompt`, `wait`, `read`) with OpenCode reset | ✅ |
| **File Tree** | Sanitized Markdown/HTML preview, UTF-8 editor, fuzzy search, and global grep | ✅ |
| **FS Security** | Sandboxed filesystem boundaries (`Roots`), traversal protection, safe symlink handling | ✅ |
| **Changes & Graph** | Atomic staging, commit (amend), word-level side-by-side/unified diff, commit graph | ✅ |
| **GitHub** | Actions (runs/jobs/logs), workflow dispatch, repository secrets, artifacts | ✅ |
| **Run & ngrok** | Autodiscovery of run configs, per-project ngrok tunnels (HTTP/TCP/TLS) | ✅ |
| **Settings Modal** | Centralized tabbed modal for Plane, Jev, Environment, Audio, and Portability, private credentials | ✅ |
| **Appearance** | 10 themes, custom font sizes, cursor styles, translucent glass materials, native icons | ✅ |

> ✅ = Stable in release **v2.17.0**.

### Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+K` / `⌘K` | **Omni-Command Palette** (search files, branches, tickets, agents, actions) |
| `Ctrl+,` / `⌘,` | **Settings** (Plane, Jev, environment, audio, portability) |
| `Ctrl+F` | **Find in terminal** (in-buffer search with concurrent highlight) |
| `Ctrl+Shift+P` / `⌘P` | Quick file open (fuzzy match) |
| `Ctrl+Shift+F` | Global project grep (inside terminal: search buffer) |
| `Ctrl+Shift+T` | New standard terminal |
| `Ctrl+Shift+A` | New agent from squad catalog |
| `Ctrl+Shift+O` | Open another project folder (outside terminal) / **Split Right** (inside terminal) |
| `Ctrl+Shift+E` | **Split Down** active terminal |
| `Ctrl+Shift+W` / `⌘W` | Close active terminal |
| `Ctrl+Shift+M` | Maximize / restore terminal pane |
| `Ctrl+Shift+B` | Toggle accordion sidebar |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | Copy / paste in terminal |
| `Ctrl+S` / `⌘S` | Save edited file |
| `Ctrl+Enter` | Commit staged changes |
| `F5` | Reload file tree and Git status |
| `Ctrl+F5` / `Shift+F10` | Run / re-run active Run configuration |
| `Ctrl+F2` | Stop active Run process |
| `F7` / `Shift+F7` | Next / previous modification in diff |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Adjust terminal font size / reset |
| `Esc` | Close modal, overlay, palette, or search bar |

---

## 🚀 Quick Start

```bash
git clone https://github.com/overzoomit/work-stack.git
cd work-stack
npm install          # also downloads vendor dependencies (xterm, marked, DOMPurify)
npm run dev
```

To launch Work directly targeting a specific repository:

```bash
WORK_CWD=~/projects/my-repo npm run dev
work ~/projects/my-repo          # after installing the binary
work                              # restores previously saved session and projects
```

### Prerequisites

- **Node.js** 22+ and **Rust** stable ([rustup.rs](https://rustup.rs)).
- **Git** and **tmux**.
- **Linux (Ubuntu/Debian/Arch/Fedora)**: `libwebkit2gtk-4.1-dev`, `build-essential`, `libssl-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`.
- **macOS**: Xcode Command Line Tools.
- **Optional**: `gh` for GitHub CLI, `ngrok` for tunnels, and your preferred AI agent CLIs.

### Build & Install

```bash
npm run build           # bundle in src-tauri/target/release/bundle/
npm run install:linux   # Linux: ~/.local/bin + desktop launcher & icon
npm run clean           # clean target folder to reclaim disk space
```

---

## 🏗 Architecture

```text
work-stack/
├── src-tauri/                    # Rust backend (Tauri 2, edition 2021)
│   ├── src/
│   │   ├── main.rs               # Bootstrap, IPC bindings, lifecycle, project resolver
│   │   ├── app.rs                # Window lifecycle, system menu, updates, CLI `work`
│   │   ├── tmux.rs               # Sessions, windows, split-pane, and Time Machine
│   │   ├── pty.rs                # portable-pty terminals and backpressure flow control
│   │   ├── remote.rs             # SSH projects and remote tmux sessions
│   │   ├── dogwatch.rs           # Prompt detection, manifests, escalation relay
│   │   ├── plane_dogwatch.rs     # Plane ticket delegation → agents with oz tags
│   │   ├── agents.rs             # Transcript sessions, agent processes, Smart Diff
│   │   ├── claudeprocs.rs        # CLI agent process detection
│   │   ├── analytics.rs          # Fleet Analytics telemetry aggregation
│   │   ├── telegram.rs           # Multi-Project & Multi-PM Telegram router
│   │   ├── webview.rs            # Docked Webview QA snapshot capture
│   │   ├── ngrok.rs              # Per-project ngrok tunnels
│   │   ├── settings.rs           # Global API keys and preferences
│   │   ├── plugins.rs            # Global Claude Code plugins
│   │   ├── mcp.rs                # MCP servers, Firefox DevTools, and Chrome 9222
│   │   ├── fsops.rs              # Sandboxed filesystem operations (Roots)
│   │   ├── git.rs / gitwatch.rs  # Git CLI, Smart Diff, and reactive watcher
│   │   ├── github.rs             # gh CLI: Actions, secrets, artifacts
│   │   ├── runconfigs.rs         # Autodiscovery of Run commands
│   │   ├── store.rs              # Atomic JSON persistence
│   │   ├── sysstats.rs           # System CPU / RAM monitoring
│   │   └── diag.rs               # Diagnostic logging and log bundle export
│   └── detect/manifests/         # Declarative TOML rules for agent CLIs (6 files)
├── src/renderer/                 # Vanilla ES Modules frontend (no bundler)
│   ├── index.html                # Main application shell
│   ├── bridge.js                 # window.work on top of Tauri IPC
│   ├── app.js / accordion.js     # Layout orchestration, project tabs
│   ├── tabstrip.js / ptabled.js  # Elastic project tabs and terminal grid
│   ├── team.js / teamroles.js    # Agent Squad, role management, Needs You deck
│   ├── agent_graph.js            # Mission Control SVG canvas & animated particles
│   ├── agentcatalog.js           # Catalog of 12 agentic CLIs
│   ├── agentsview.js             # Agents view, transcripts, and launcher
│   ├── palette.js                # Omni-Command Palette (Ctrl+K)
│   ├── webview_pane.js           # Docked Webview, viewports, and snapshots
│   ├── analytics.js              # Fleet Analytics and SVG sparklines
│   ├── sound.js                  # Procedural Web Audio synthesizer
│   ├── terminals.js              # Terminal grid, split-panes, Time Machine
│   ├── terminalsearch.js         # In-buffer search (Ctrl+F)
│   ├── tree.js / preview.js      # File tree, previews, and editor
│   ├── search.js                 # Fuzzy file finder and global grep
│   ├── diff.js / review.js       # Smart Diff Lens, review sheet, commit
│   ├── gitpanel.js / graph.js    # Git control panel and commit graph
│   ├── github.js                 # Actions, workflows, secrets, artifacts
│   ├── run.js / runurl.js        # Run panel, Preview, and local URL detection
│   ├── ngrok.js / plugins.js     # Tunnels and plugins management
│   ├── mcp.js / remotedialog.js  # MCP configuration and SSH modal
│   ├── remoteproject.js          # Badges and paths for SSH projects
│   ├── settings.js               # Tabbed Settings modal
│   ├── appearance.js / themes.js # Themes (10), typography, cursor styles
│   ├── onboarding.js / launcher.js# First-run onboarding wizard & agent launcher
│   ├── keys.js / ui.js / update.js# Shortcuts, toasts, update banners
│   ├── chunks.js / paths.js / escape.js # Shared utilities
│   └── style.css                 # Dark theme design system
├── scripts/
│   ├── work-agent.py             # Inter-agent CLI (list/prompt/wait/read)
│   ├── plane-dogwatch.py         # Plane ticket watchdog with oz prefixes
│   ├── tmux-dogwatch.py          # Watchdog and answer relay for tmux windows
│   ├── telegram-pm.py            # PM notifications and voice notes
│   ├── plane-cli.py              # Local CLI for Plane backlog operations
│   ├── install-linux.sh          # Binary installation and desktop entries
│   └── vendor.mjs                # Vendor libraries (xterm, marked, DOMPurify)
├── assets/                       # Hero artwork, architecture diagrams, and icons
├── docs/                         # Knowledge base, ADRs, agent docs, GitHub Pages landing page
└── test/                         # Node.js test suite (unit + regression) and test/e2e
```

---

## 🧪 Testing & Quality

Run the test suite before any commit or ticket state transition:

```bash
npm test                                                     # 492 Node tests + 413 Rust tests (3 live GitHub tests remain #[ignore])
npm run test:e2e                                             # Debug build with e2e feature + smoke test suite
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

The three Rust tests marked `#[ignore]` (`real_secret_roundtrip`, `real_artifact_download`, `real_status`) interact with live GitHub services and run manually via `--ignored`.

---

## 📚 Documentation

- [Architectural Knowledge Base](docs/KNOWLEDGE_BASE.md)
- [Domain Glossary](GLOSSARY.md)
- [Architecture Decision Records](docs/adr/)
- [Agent Guidelines](docs/agents/)
- [Official Website & Showcase](https://overzoomit.github.io/work-stack/)
- [GitHub Repository](https://github.com/overzoomit/work-stack)

---

<div align="center">

**Work Stack** — crafted with Rust, Tauri 2, and vanilla ES modules.<br>
No frameworks, no bundlers: only the developer workspace your team needs.

<sub>Private project · All rights reserved.</sub>

</div>

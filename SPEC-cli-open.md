# Spec: `work <cartella>` da terminale + installazione Linux (PR #2)

## Obiettivo

Due modifiche sul branch `install-linux` (PR #2):

1. **Correggere l'installer Linux della PR** (`scripts/install-linux.sh`).
2. **`work <cartella>` da terminale apre Work su quella cartella**, su Linux e macOS, come `code .`.

Utente: uno sviluppatore che vive nel terminale e vuole passare dalla shell a Work sul repo in cui si trova.

### Comportamento di `work [cartella]`

| Situazione | Risultato |
|---|---|
| `work` (senza argomento) | Invariato: ripristina i progetti salvati come oggi. |
| `work .` / `work ../x` / `work /assoluto` | Cartella risolta rispetto alla cwd della shell e aperta **esattamente com'è** (anche se non è un repo git o è una sottocartella di un repo), come tab di progetto **attivo**. |
| Cartella già aperta come progetto | Il tab esistente diventa attivo, nessun duplicato. |
| Work già in esecuzione | La finestra aperta apre il tab, esce dallo stato minimizzato e prende il focus. Non resta vivo un secondo processo. |
| Lanciato da terminale | Il prompt torna subito; Work gira staccato, nessun log nella shell. |
| Non è una cartella esistente | `work: non è una cartella: <arg>` su stderr, exit code 1, non si apre niente. |

## Branch e verifica

Il lavoro è diviso in due branch, ognuno verificato sul proprio sistema operativo:

| Branch | Base | Contenuto | Dove si verifica |
|---|---|---|---|
| `cli-open-mac` | `main` | Nucleo multipiattaforma (`open_arg`, distacco, single-instance, `app:open` nel renderer) + wrapper macOS e README | macOS, in locale (Apple Silicon) |
| `install-linux` (PR #2) | `cli-open-mac` | Correzioni all'installer + app_id Wayland | Linux: container Docker arm64 Ubuntu 24.04 con Xvfb (X11) e Weston headless (Wayland) |

Il nucleo sta nel branch mac perché è l'unico sistema su cui si prova la GUI in locale. Il branch Linux è
costruito sopra, quindi l'ordine di merge è: prima `cli-open-mac`, poi la PR #2 (che dopo il rebase mostra
solo le modifiche Linux).

Nel container le prove si verificano senza guardare lo schermo: lo stato salvato
(`WORK_USER_DATA/state.json`) dice quali progetti sono aperti e qual è attivo, `pgrep` conta i processi,
`WAYLAND_DEBUG=1` mostra l'app_id. L'aspetto del menu applicazioni e della dock va controllato a occhio su
una distro vera (Flavio) prima del merge della PR #2.

## Stack

Tauri 2 (Rust, `src-tauri/`), renderer JS senza framework (`src/renderer/`), test con `node --test` su Node 22.
Nuova dipendenza: `tauri-plugin-single-instance` v2 (approvata: passa argv e cwd del secondo lancio all'istanza già aperta).

## Design

**Rust, `main.rs` / `app.rs`**
- `app::open_arg(args, cwd) -> Result<Option<PathBuf>, String>`: funzione pura. Prende il primo argomento che non è un flag, lo risolve rispetto a `cwd`, lo canonicalizza e controlla `is_dir`. Coperta da unit test.
- All'inizio di `main()`, solo nelle build release (`cfg!(not(debug_assertions))`, così `npm run dev` non cambia): se stdin è un terminale (`std::io::IsTerminal`), valida l'argomento con `open_arg` (in caso di errore stampa il messaggio ed esce con 1). Poi rilancia se stesso con il percorso assoluto risolto, stdio su null, in un nuovo process group (`CommandExt::process_group(0)`), ed esce con 0. Il figlio non ha un terminale, quindi non si stacca di nuovo.
- `tauri-plugin-single-instance` registrato per primo. Callback `(app, argv, cwd)`: chiama `open_arg(argv, cwd)`; se ottiene `Some(path)` emette `app:open` con il percorso; in ogni caso toglie la finestra principale dallo stato minimizzato e le dà il focus (`set_focus`).
- `app_info` aggiunge `"open": <percorso | null>`, calcolato con `open_arg(std::env::args(), current_dir)`.

**Renderer, `app.js` / `bridge.js`**
- `bridge.js`: `onOpen: listen('app:open')` accanto a `onFocus`.
- Avvio: dopo il ripristino dei progetti salvati, se c'è `info.open`, `addProject(info.open)` (che lo rende attivo) al posto della scelta del primo progetto salvato. Il fallback esistente su `info.cwd` (radice git) resta per `work` senza argomento.
- A runtime: `work.app.onOpen((path) => addProject(path))`.

**Installer Linux, `scripts/install-linux.sh`**
- Controllo iniziale: se `uname` non è `Linux`, messaggio ed exit 1.
- Via `rustup update stable` (niente modifiche alla toolchain globale).
- `Exec="$BIN_DIR/work"`: percorso tra virgolette, così funziona anche con uno spazio in `$HOME`.
- Il nome del file `.desktop` coincide con l'app_id Wayland (vedi Domande aperte #1), così la dock mostra l'icona giusta.
- `~/.local/bin/work` è il binario vero: `work .` funziona direttamente, perché il distacco dal terminale è nel binario.

**macOS**
- Lanciare direttamente `Contents/MacOS/work` mantiene il bundle (icona, nome). Il README documenta un comando che installa nel PATH un wrapper di 2 righe (vedi Domande aperte #2):
  ```sh
  #!/bin/sh
  exec /Applications/Work.app/Contents/MacOS/work "$@"
  ```

**deb/rpm/AppImage**: deb e rpm installano già `/usr/bin/work`, quindi lì `work .` funziona senza altri passaggi.

## Comandi

```
Test (tutti):   npm test
Solo Rust:      cargo test --manifest-path src-tauri/Cargo.toml
Dev:            npm run dev            # nelle build debug il distacco è disattivato
Build:          npm run build
Install Linux:  npm run install:linux
Lint shell:     shellcheck scripts/install-linux.sh   # se installato
```

## Struttura

```
src-tauri/src/main.rs      → distacco + registrazione single-instance
src-tauri/src/app.rs       → open_arg, app_info.open, test in mod tests
src-tauri/Cargo.toml       → + tauri-plugin-single-instance
src/renderer/bridge.js     → app.onOpen
src/renderer/app.js        → apertura all'avvio e a runtime
scripts/install-linux.sh   → correzioni all'installer
README.md                  → uso di `work .`, wrapper macOS
```

## Stile

Come il codice attorno: funzioni brevi, testi per l'utente in italiano, commenti in inglese che spiegano il *perché*, commenti `ponytail:` per i limiti noti.

```rust
// Like `code .`: the folder given on the command line, resolved against the caller's cwd.
pub fn open_arg(args: impl IntoIterator<Item = String>, cwd: &Path) -> Result<Option<PathBuf>, String> {
    let Some(arg) = args.into_iter().skip(1).find(|a| !a.starts_with('-')) else { return Ok(None) };
    let path = cwd.join(&arg).canonicalize().map_err(|_| format!("work: non è una cartella: {arg}"))?;
    if path.is_dir() { Ok(Some(path)) } else { Err(format!("work: non è una cartella: {arg}")) }
}
```

## Test

- **Unit test Rust** (`mod tests` in `app.rs`) per `open_arg`: nessun argomento → `None`; `.` → cwd; relativo `../x`; percorso assoluto; argomenti che sono solo flag ignorati; percorso inesistente → `Err`; file (non cartella) → `Err`.
- **Distacco + single-instance**: manuale, non testabile con unit test. Checklist nei Criteri di successo, da eseguire su macOS (in locale) e su Linux (Flavio o una VM).
- **Installer**: `shellcheck` + esecuzione manuale su Linux.
- `npm test` verde prima di ogni commit.

## Limiti

- **Sempre:** `npm test` prima del commit; commit tramite `/conventional-commits`; `npm run dev` deve funzionare come oggi.
- **Prima chiedere:** qualunque dipendenza oltre a `tauri-plugin-single-instance`; modifiche a CI/workflow di release; force-push sul branch di Flavio; cambi al modo in cui vengono ripristinati i progetti salvati.
- **Mai:** scrivere fuori da `~/.local` / `$XDG_DATA_HOME` dall'installer; richiedere root; modificare la toolchain globale dell'utente; fare il merge della PR senza una prova su Linux.

## Criteri di successo

**`cli-open-mac` (verificato su macOS)**

1. `cargo test` copre i casi di `open_arg` elencati sopra e passa; `npm test` verde.
2. Build release: `cd ~/qualche/repo/sub && work .` restituisce subito il prompt; Work si apre con `sub` come tab attivo.
3. Con Work già aperto: `work ~/altro` apre `altro` come nuovo tab attivo nella stessa finestra, con il focus; `pgrep -x work` mostra un solo processo.
4. `work /nope` stampa `work: non è una cartella: /nope`, esce con 1 e non apre niente.
5. `work` senza argomento si comporta esattamente come oggi.
6. `npm run dev` resta attaccato al terminale.
7. Il wrapper del README, installato come indicato, fa funzionare i punti 2–4 da qualunque shell, con icona e nome di Work nella dock.

**`install-linux` (verificato in container Linux)**

8. `npm test` verde nel container.
9. `npm run install:linux` riesce senza `rustup` e senza root; crea binario, icone e file `.desktop` (valido per `desktop-file-validate`).
10. Con Xvfb e con Weston headless: i punti 2–5 valgono anche su Linux, verificati tramite `state.json` e `pgrep`.
11. Il nome del file `.desktop` coincide con l'app_id letto da `WAYLAND_DEBUG=1`.
12. L'installer lanciato su macOS esce con 1 e un messaggio.
13. Prima del merge: Flavio conferma su una distro vera icona nel menu e nella dock.

## Domande aperte

1. **app_id Wayland.** Tauri 2 imposta l'app_id GTK a `it.overzoom.work` o a `work`? Da verificare su Linux (`WAYLAND_DEBUG=1` o guardando la dock). Se è l'identifier, il file si chiama `it.overzoom.work.desktop`. Si risolve durante l'implementazione, non serve una decisione dell'utente.
2. **Comando nel PATH su macOS.** Consigliato: un comando nel README che scrive il wrapper in `/usr/local/bin/work` (serve `sudo`; su Apple Silicon la cartella può richiedere `sudo mkdir -p`). Alternativa: una voce di menu nell'app "Installa comando `work`", come VS Code (più codice). Default: il comando nel README.
3. **single-instance su macOS.** Il supporto macOS del plugin va confermato in fase di build. Se non funziona, il fallback su macOS è il wrapper con `open -na Work --args "<percorso assoluto>"`, e il percorso `app:open` tramite plugin resta solo su Linux.

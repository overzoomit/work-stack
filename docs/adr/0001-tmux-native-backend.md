# ADR 0001: Orchestrazione delle Sessioni Terminali tramite tmux Nativo

## Stato
Accettato e Implementato (Ticket Plane [1], [2], [3], [7], [10], [11])

## Contesto
Work Stack gestisce molteplici terminali e sessioni di agenti AI per ciascun progetto aperto. L'utilizzo di semplici processi PTY isolati causava la perdita dello stato di esecuzione e dei log alla chiusura della finestra dell'applicazione o al cambio di progetto. Inoltre, era impossibile per gli sviluppatori interagire con le sessioni degli agenti da terminale esterno o riprendere sessioni interrotte.

## Decisione
1. Introdurre il modulo backend Rust `src-tauri/src/tmux.rs` per interagire direttamente con il binario di sistema `tmux`.
2. Assegnare a ciascun progetto una sessione tmux deterministica denominata `work_<cartella>_<hash>`.
3. Utilizzare le **sessioni raggruppate (`-t <session>`)** per i riquadri della GUI (`<session>_pty_<id>`), permettendo a ciascun riquadro di visualizzare una specifica finestra tmux senza forzare la sincronizzazione visiva globale tra tab.
4. All'apertura di un progetto, eseguire l'**auto-reattach** di tutte le finestre esistenti (`pm`, `dev*`, `qa*`, `agent*`, `shell`).
5. Alla chiusura di un terminale o dell'app, eseguire un **clean detach** terminando unicamente la sessione PTY secondaria, lasciando la sessione del progetto e gli agenti in esecuzione continua su tmux.

## Conseguenze
- **Vantaggi**: Persistenza assoluta dei processi in background; piena interoperabilità da CLI tramite `tmux attach`; zero memory leak o processi orfani; riavvio trasparente della dashboard desktop senza interruzione dei task degli agenti.
- **Limiti / Requisiti**: Richiede la disponibilità di `tmux` nel sistema (fallback automatico su shell standard PTY se non disponibile).

# ADR 0002: Orchestrazione Interattiva della Squadra Agenti e Agenti Generici

## Stato
Accettato e Implementato (Ticket Plane [4], [6], [10], [13])

## Contesto
Lo sviluppo autonomo e il test end-to-end richiedono ruoli specializzati che collaborano contemporaneamente: un Project Manager (PM), sviluppatori software (Dev), ingegneri del controllo qualità (QA) e agenti generici per compiti ad hoc. L'utente necessita di una gestione chiara e rapida per avviare, monitorare e terminare ciascun membro.

## Decisione
1. Creare il modulo frontend `src/renderer/team.js` e la relativa interfaccia nel popover "👥 Agent Team".
2. Strutturare i ruoli secondo una gerarchia rigida:
   - **PM (1 solo)**: Finestra `pm`, assegnato prioritariamente a Antigravity (`agy`). Se già attivo, non è possibile duplicarlo; è possibile riconfigurarlo o terminarlo.
   - **Developers (`dev1`, `dev2`, ...)**: Multipli con numerazione incrementale calcolata automaticamente (`nextDevName`).
   - **QA Engineers (`qa`, `qa1`, ...)**: Multipli per validazione e test runtime (`nextQaName`).
   - **Agenti Generici (`agent1`, `agent2`, ...)**: Posizionati direttamente sotto QA, utilizzabili per task non convenzionali con selezione libera dell'agente CLI.
3. Rimuovere il vecchio pulsante generico `✦ Agente` dalla barra superiore per unificare tutto il ciclo di vita degli agenti all'interno della Squadra Agenti.
4. Ogni aggiunta apre l'interfaccia di selezione (`select-agent`) che elenca tutti gli agenti CLI configurati con badge cromatico e comando predefinito.

## Conseguenze
- **Vantaggi**: Controllo completo dei ruoli di progetto; prevenzione di conflitti di ruoli (singolo PM); allocazione pulita e progressiva dei nomi; supporto per qualsiasi agente CLI installato nel sistema.
- **Riferimenti**: [`src/renderer/team.js`](file:///home/flavio/workspace/work-stack/src/renderer/team.js), [`src/renderer/launcher.js`](file:///home/flavio/workspace/work-stack/src/renderer/launcher.js).

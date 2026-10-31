# ADR 0003: Layout Unificato a Colonna Singola Sinistra con Accordion VS Code

## Stato
Accettato e Implementato (Ticket Plane [12])

## Contesto
La precedente interfaccia a tre colonne (Sidebar Sinistra per terminali e agenti, Griglia Centrale per i terminali, Pannello Destro per albero file, modifiche Git, grafo, GitHub e comandi Run) restringeva eccessivamente l'area visibile per i terminali dei developer e complicava la gestione dello spazio sui monitor desktop. L'utente ha richiesto un modello analogo a Visual Studio Code.

## Decisione
1. Rimuovere completamente il pannello destro (`<aside class="panel">`), lo splitter destro e il toggle `Ctrl+Alt+B`.
2. Estendere la griglia dei terminali su tutto lo spazio restante della finestra a destra della sidebar.
3. Spostare tutte le sezioni (Albero Progetto, Modifiche Git, Grafo, GitHub, Run) nella colonna di sinistra, incastonandole sotto il blocco Agenti sotto forma di accordion collapsible (`src/renderer/accordion.js`).
4. Comportamento di default:
   - **Agenti**: Sempre aperto di default (equivalente a Explorer).
   - **Progetto, Modifiche, Graph, GitHub, Run**: Chiusi di default con chevron animato (`›` / `⌄`), espandibili al click o tramite tastiera (`Enter` / `Space`).
5. Introdurre la funzione `revealSection(name)` che, se la sidebar è nascosta (`Ctrl+Shift+B`), riapre automaticamente la colonna sinistra (`setPanel('left', true)`) prima di espandere la sezione e attivare il focus.

## Conseguenze
- **Vantaggi**: Terminali ampi a tutto schermo; navigazione fluida e compatta stile VS Code; accessibilità completa da tastiera; hooks on-demand per alleggerire il rendering del Grafo e di GitHub.
- **Riferimenti**: [`src/renderer/accordion.js`](file:///home/flavio/workspace/work-stack/src/renderer/accordion.js), [`src/renderer/style.css`](file:///home/flavio/workspace/work-stack/src/renderer/style.css), [`test/accordion.test.mjs`](file:///home/flavio/workspace/work-stack/test/accordion.test.mjs).

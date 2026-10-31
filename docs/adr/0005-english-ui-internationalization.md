# ADR 0005: Internazionalizzazione Completa dell'Interfaccia Utente (UI) in Lingua Inglese

## Stato
Accettato e Implementato (Ticket Plane [14])

## Contesto
Originariamente le etichette dell'interfaccia utente (UI), i tooltip, i menu popup e i messaggi toast contenevano un mix di terminologia italiana e inglese. Per standardizzare il prodotto e renderlo accessibile a livello globale, l'utente ha richiesto la traduzione integrale dell'interfaccia grafica in lingua inglese.

## Decisione
1. **Interfaccia Grafica (UI)**: Tutte le stringhe visibili all'utente nel frontend (`src/renderer/index.html` e moduli `src/renderer/*.js`), inclusi pulsanti, tooltip, menu contestuali, dialoghi di conferma e notifiche toast, sono rigorosamente in **lingua inglese**.
2. **Backend Rust**: I messaggi di errore restituiti via IPC da Tauri verranno allineati alla lingua inglese in un successivo passaggio dedicato.
3. **Issue Tracker Plane & Commenti Tecnici**: Titoli, descrizioni, criteri di accettazione e tutti i commenti di handoff tecnico/QA su Plane rimangono tassativamente in **lingua italiana**.
4. **Codice Sorgente**: Commenti, nomi di funzioni, variabili e test unitari in **lingua inglese**.

## Conseguenze
- **Vantaggi**: UI coerente, professionale e internazionalizzata; separazione netta tra linguaggio dell'interfaccia (EN) e linguaggio della governance di progetto (IT).
- **Riferimenti**: [`src/renderer/index.html`](file:///home/flavio/workspace/work-stack/src/renderer/index.html), commit `ee46b88`.

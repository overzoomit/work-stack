# ADR 0004: Protocollo Sentinella Dogwatch ed Escalation Domande al PM

## Stato
Accettato e Implementato (Ticket Plane [15])

## Contesto
Durante lo sviluppo autonomo in background, gli agenti CLI (Claude Code, OpenCode, Codex) possono fermarsi su prompt di conferma interattivi (`Do you want to proceed? 1. Yes 2. No`, `[y/N]`, selezioni numerate) o formulare domande tecniche. Se gli agenti attendono una risposta diretta dall'utente umano (Flavio), il flusso di lavoro si blocca e l'utente viene sovraccaricato di micro-decisioni operative non necessarie.

## Decisione
1. **Punto di Contatto Unico**: L'utente si interfaccia **esclusivamente con il Senior PM (Antigravity)**. Nessun dev o QA ha il permesso di interpellare direttamente l'utente.
2. **Sentinella Dogwatch**:
   - Fornire lo strumento di ascolto `scripts/tmux-dogwatch.py` che scansiona periodicamente i riquadri tmux (`tmux capture-pane`) per rilevare stati di attesa input, prompt di conferma o domande.
   - Quando un blocco viene rilevato, lo stato viene registrato nel canale di escalation `.claude/escalation_to_pm.json`.
3. **Delega Decisionale al PM**:
   - **Risoluzione Autonoma**: Se la risposta riguarda dettagli tecnici, autorizzazioni su comandi noti o requisiti già concordati nelle specifiche del ticket, il PM formula la risposta e sblocca l'agente autonomamente tramite `tmux send-keys` o `tmux-dogwatch.py answer <pane> <risposta>`.
   - **Escalation all'Utente**: Solo nei rari casi in cui emerge un dubbio strutturale di business, di design o di prodotto non desumibile dall'architettura, il PM interpella l'utente. L'utente risponde al PM, che propaga poi la risposta all'agente.

## Conseguenze
- **Vantaggi**: Sviluppo continuo senza colli di bottiglia; totale protezione dell'utente da interruzioni futili; tracciabilità strutturata dei blocchi operativi in formato JSON.
- **Riferimenti**: [`scripts/tmux-dogwatch.py`](file:///home/flavio/workspace/work-stack/scripts/tmux-dogwatch.py), [`.claude/escalation_to_pm.json`](file:///home/flavio/workspace/work-stack/.claude/escalation_to_pm.json).

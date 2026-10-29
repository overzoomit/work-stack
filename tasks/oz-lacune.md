# Lacune di oz

Una lacuna è un punto in cui oz (skill, `oz-run`, `oz-sync`, Jev, template) ha fatto diverso da `FLUSSO.md`
del plugin oz o dalla skill che vale. Questo file le raccoglie, in git e non in Plane, perché un agente le
possa fixare senza ricostruire la storia.

## Regole

1. Una scheda per lacuna, con il titolo `## L-<n> · <gg/mm/aaaa> · stato: aperta`. `n` è crescente e non si riusa mai.
2. Ogni scheda ha tutti questi campi:
   - **Dove**: sprint, work item, comando lanciato.
   - **Lancio**: percorso del log o id della sessione.
   - **Atteso**: la frase di `FLUSSO.md` del plugin oz o della skill che vale.
   - **Osservato**: cosa è successo, con l'errore esatto.
   - **Causa**: `file:riga`, o «da capire».
   - **Riproduci**: comandi o passi minimi.
   - **Proposta**: il cambio più piccolo.
   - **Fix**: vuoto finché la scheda è aperta.
3. Solo lacune del flusso di oz (skill, `oz-run`, `oz-sync`, Jev, template). I bug del prodotto vanno nel todo o in un
   hotfix.
4. Scrivi la scheda appena succede, prima di aggirare il problema.
5. Per fixare una lacuna: leggi Riproduci e Causa, scrivi prima un test che fallisce, fai il cambio più piccolo nel repo
   di oz (`overzoomit/plane`, cartella `plugin/`), poi compila Fix (commit e versione di oz) e porta lo stato a
   `chiusa`. Un controllo nuovo in `oz-run` cita la sua `L-n`.
6. Al rilascio di uno sprint l'orchestratore rilegge questo file; l'esito cita le schede aperte e quelle chiuse.

<!-- Esempio di scheda, non una lacuna vera. Le schede vere vanno sotto questo commento.

## L-1 · 27/10/2026 · stato: aperta

- **Dove**: sprint 8, PLS-160, `node plugin/bin/oz-sync.mjs PLS 8 item:lacune --cycle /tmp/cycle.json`
- **Lancio**: `.oz-run/PLS-160.log`
- **Atteso**: «Spec e todo di un modulo vanno nella descrizione del suo work item» (`oz:sprint`).
- **Osservato**: exit 1, `modulo lacune non trovato nella mappa`; la mappa ha la riga `lacune`.
- **Causa**: da capire.
- **Riproduci**: `node plugin/bin/oz-sync.mjs PLS 8 item:lacune --dry-run` dalla radice del repo.
- **Proposta**: leggere il `Module id` della mappa senza spazi ai lati.
- **Fix**:
-->

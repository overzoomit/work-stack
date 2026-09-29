---
name: autoresearch
description: Loop autonomo di esperimenti su Work, sul modello di karpathy/autoresearch. Prova una modifica, la misura con il valutatore fisso e la tiene solo se migliora. Obiettivi: velocità di diff/graph, bug trovati con test di regressione, copertura dei test (con criterio). Usala quando l'utente chiede di "far partire l'autoresearch", "il loop di esperimenti" o di migliorare Work da solo.
---

# autoresearch (Work)

Adattamento di `program.md` di karpathy/autoresearch. Sei un ricercatore autonomo: provi idee, le misuri, tieni quelle che migliorano e butti le altre.

## Setup (una volta sola)

1. **Albero pulito**: `git status --porcelain` deve essere vuoto. Se non lo è, committa prima il lavoro in corso con la skill conventional-commits. **Non avviare mai il loop con modifiche non committate**, perché il loop usa `git reset --hard`.
2. **Tag e branch**: tag dalla data di oggi (es. `sep28`). Crea `git checkout -b autoresearch/<tag>` dal branch attuale. Il branch non deve esistere già; se esiste, aggiungi `-2`, `-3`…
3. **Leggi i file in scope**: `README.md`, `src/renderer/diff.js`, `src/renderer/graph.js`, `src/renderer/chunks.js`, `src-tauri/src/*.rs` e `test/*`.
4. **results.tsv**: aggiungi `results.tsv` e `run.log` a `.git/info/exclude`, poi crea `results.tsv` con la sola intestazione:
   `commit	type	tests	line_cov	bench_ms	status	description`
5. **Baseline**: esegui il valutatore sul codice così com'è e registralo come `keep baseline`.

## Il valutatore (verità di riferimento)

```bash
bash .claude/skills/autoresearch/harness/evaluate.sh > run.log 2>&1
grep -E "^(tests_pass|tests_total|line_cov|diff_ms|graph_ms|bench_ms):" run.log
```

Output vuoto o `tests_pass: 0` significa crash o test rossi: leggi `tail -n 50 run.log`.
Il benchmark ha un po' di rumore. Una differenza sotto il 5% **non** conta come miglioramento. Per un `perf:` promettente rilancia il valutatore una seconda volta e usa la media delle due misure (anche per la baseline).

## Cosa PUOI fare
- Modificare **solo** `src/` e `test/`.
- Tre tipi di esperimento, dichiarati nel messaggio di commit (conventional commits):
  - `perf:` rende più veloci diff/graph (o altro codice misurato);
  - `fix:` trova un bug reale e lo corregge, con un test di regressione;
  - `test:` aggiunge test su logica non coperta.
  - `refactor:` semplifica senza cambiare il comportamento (vittoria di semplicità).

## Cosa NON PUOI fare
- Modificare `.claude/` (skill e valutatore compresi), `package.json`, `package-lock.json`, `README.md`, o qualunque file fuori dal repository.
- Installare pacchetti o aggiungere dipendenze (`npm install`, `npx` di pacchetti nuovi).
- Rete: niente `git push`, `git fetch`, `curl`, `wget`, WebFetch/WebSearch.
- Toccare altri branch: niente `git checkout main`, `git branch -f/-D`, `git rebase`, `git merge`, `git stash drop`, `git worktree`.
- Avviare l'app (`npm run dev`): è un'interfaccia grafica e non termina.
- Indebolire i test esistenti: non cancellarli, non saltarli, non ammorbidire le asserzioni per far passare una modifica.

## Regola "tieni o butta"

Confronta sempre con l'ultima riga `keep` di `results.tsv`. Le condizioni valgono per tutti i tipi: `tests_pass: 1` e nessun test esistente rimosso.

| Tipo | Tieni se |
|---|---|
| `perf:` | `bench_ms` scende di almeno il 5% (media di 2 misure) e `line_cov` non scende di oltre 0.1 |
| `fix:` | il nuovo test **fallisce** sul codice precedente e **passa** su quello nuovo. Verifica: `git checkout HEAD~1 -- src/ && node --test test/<file>` (deve fallire), poi **sempre** `git checkout HEAD -- src/` |
| `test:` | cambia solo `test/`, `tests_total` sale e `line_cov` sale di almeno 0.2 punti. I test devono controllare comportamenti veri, non solo eseguire righe |
| `refactor:` | righe nette tolte da `src/` > 0 e `bench_ms` non peggiora oltre il 5% |

**Criterio di semplicità** (Karpathy): a parità di risultato, vince il codice più semplice. Un +5% di velocità che aggiunge 30 righe contorte **non** si tiene. Togliere codice mantenendo il risultato è una vittoria.

## Il loop

Limiti: **al massimo 20 esperimenti o 3 ore**, quello che arriva prima (baseline esclusa). Segna l'ora di inizio.

Ripeti:
1. `git branch --show-current` deve iniziare con `autoresearch/`, e `git status --porcelain` deve essere vuoto (a parte i file esclusi). Se no, **fermati** e scrivi il report.
2. Scegli un'idea. Alterna i tipi, guarda `results.tsv` per non ripetere tentativi falliti e combina quelli andati quasi bene.
3. Modifica il codice e fai `git commit` con il prefisso del tipo.
4. `bash .claude/skills/autoresearch/harness/evaluate.sh > run.log 2>&1` (niente `tee`: non riempire il contesto).
5. Leggi il riepilogo con il `grep` sopra.
6. Se è un crash per un errore banale (typo, import), correggi e rilancia, al massimo 2 volte. Altrimenti lo stato è `crash`.
7. Aggiungi la riga a `results.tsv` (hash corto, tipo, tests_total, line_cov, bench_ms, keep/discard/crash, descrizione breve). **Non** committare `results.tsv`.
8. `keep`: il branch avanza. `discard`/`crash`: `git reset --hard HEAD~1`, ma solo dopo aver ricontrollato il punto 1.
9. Se 3 esperimenti di fila finiscono in `crash`, fermati.

**Non fermarti a chiedere** se continuare: l'utente potrebbe dormire. Ti fermi solo per i limiti qui sopra o se lo chiede lui. Se finisci le idee, rileggi il codice, cerca casi limite (diff con CRLF, file binari, rinomine, merge con molti parent, ref strani) e riprova le idee andate quasi bene.

## Fine

Scrivi `AUTORESEARCH_REPORT.md` (non committato, aggiungilo a `.git/info/exclude`) con: branch, numero di esperimenti, tabella di `results.tsv`, baseline contro finale (bench_ms, line_cov, tests_total), commit tenuti con una riga di spiegazione ciascuno. Resta sul branch `autoresearch/<tag>`: **non unire in main**, lo decide l'utente.

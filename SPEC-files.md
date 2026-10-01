# Spec: ricerca globale e modifica leggera dei file

## Obiettivo
Trovare in un attimo un file o un testo nel progetto attivo, e correggere al volo un file di
configurazione (soprattutto `.env`) senza aprire un IDE. Oggi Work non ha né una ricerca né un modo di
modificare un file: l'anteprima è in sola lettura.

Utente: chi usa Work ogni giorno su macOS e Linux, con progetti grandi (anche `node_modules` e `target`
pieni) e `.env` quasi sempre in `.gitignore`.

Prototipo approvato (dati di esempio): https://claude.ai/artifact/JAobjZ2uXvAWqRSzxFPnBr, variante A.
La spec descrive il prototipo; dove i due non coincidono, vale la spec.

## Mappa dei moduli
| Id | Responsabilità | Dipende da |
|---|---|---|
| `file-search` | Palette: file per nome (fuzzy) e testo nel contenuto, nel progetto attivo | — |
| `quick-edit` | Modifica di un file di testo dall'anteprima, con valori `.env` visibili e nascondibili | — |

I due moduli sono indipendenti: la palette apre l'anteprima che c'è già, e la modifica vive
nell'anteprima. Ordine: `file-search` → `quick-edit`. Con la ricerca, provare la modifica sui `.env`
diventa immediato.

## Decisioni prese
- Una palette con due modi, **File** e **Testo**: `⇥` passa dall'uno all'altro.
- Cerca nel **progetto attivo**.
- **File ignorati sì, cartelle ignorate no**: `.env` compare (in grigio, etichetta "ignorato"), ma la
  ricerca non entra in `node_modules/`, `target/`, `dist/`.
- **Modifica = variante A**: un pulsante "Modifica" nell'anteprima la trasforma in un'area di testo, per
  ogni file di testo.
- **Valori dei `.env` visibili** all'apertura, nell'anteprima e nei risultati. "Nascondi valori" li copre
  tutti, l'occhio su una riga copre solo quella; vale per quella apertura, non si ricorda.
- **Campo "Cerca in <progetto>"** nella barra in alto, oltre alle scorciatoie.

## Tech stack
Quello esistente (vedi `SPEC.md`). **Nessuna dipendenza nuova.**
- Elenco dei file e ricerca nel testo con `git` (già richiesto a runtime): `git ls-files` e
  `git grep`, che rispettano `.gitignore` e sono già ottimizzati.
- Progetti senza git: scansione con `std::fs` in Rust.
- Fuzzy match e rendering nel renderer, in JS: nessuna chiamata al backend a ogni tasto.

## Comandi
```
Test:        npm test
Solo Rust:   cargo test --manifest-path src-tauri/Cargo.toml
Lint:        cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
Formato:     cargo fmt --manifest-path src-tauri/Cargo.toml
Dev:         npm run dev
```

---

## Modulo `file-search`

### Backend (`src-tauri/src/fsops.rs`, comandi `async` come gli altri `fs_*`)
Entrambi i comandi passano da `guard` con le radici dei progetti aperti, come `fs_list`.

**`fs_files(root) -> { files: [{ path, ignored }], truncated }`**, con percorsi relativi a `root`:
- **in un repository**:
  - `git ls-files -z --cached --others --exclude-standard` dà i file tracciati e quelli nuovi;
  - `git ls-files -z --others --ignored --exclude-standard --directory` dà gli ignorati, con le cartelle
    ignorate riportate come una voce sola e senza scendere al loro interno. Si tengono solo le voci che
    non finiscono con `/`, segnate `ignored: true`;
  - si tolgono i file cancellati dal disco ma ancora nell'indice (`git ls-files -z --deleted`);
- **senza git**: visita ricorsiva che non segue i link simbolici e salta `.git`, `node_modules`,
  `target`, `dist`, `build`, `.next`, `.venv`, `venv` e `__pycache__`;
- al massimo 50 000 file. Oltre, `truncated: true` e la palette lo dice nel piè di pagina.

**`fs_grep(root, query) -> { groups: [{ path, ignored, hits: [{ line, col, text }] }], truncated }`**:
- **testo letterale**, niente regex;
- **maiuscole "smart"**: la ricerca ignora le maiuscole, a meno che la query ne contenga una (come
  `rg -S`);
- **in un repository**: `git grep -z -n --column -I --untracked -F --no-color [-i] -e <query>`. Con
  `-z` il percorso è chiuso da `\0`; dopo vengono `riga:colonna:testo`;
- **file ignorati** (quelli di `fs_files`, quindi i `.env`) **e progetti senza git**: ricerca in Rust
  sui file fino a 1 MB, saltando i binari con la stessa regola di `read` (un `\0` nei primi 8000 byte);
- **limiti**: 2000 risultati in totale (oltre, si chiude `git grep` e `truncated: true`), riga tagliata
  a 300 caratteri intorno alla corrispondenza, timeout di 10 s;
- **ordine**: prima i file non ignorati, poi gli ignorati.

### Renderer (`src/renderer/search.js`, nuovo)
- **Apertura**:
  - File: `⌘P` su macOS e `Ctrl/⌘+Shift+P` ovunque, come le altre scorciatoie di `app.js`;
  - Testo: `Ctrl/⌘+Shift+F`;
  - il campo "Cerca in <progetto>" nella barra apre la palette in modo File.

  Se non c'è un progetto aperto, la palette non si apre.
- **Elenco dei file**: si chiede a `fs_files` a ogni apertura. Intanto si mostra subito l'elenco
  dell'apertura precedente dello stesso progetto (cache in memoria) e, quando arriva quello nuovo, si
  aggiorna senza cambiare la riga selezionata se esiste ancora. La risposta è immediata anche su
  progetti grandi.
- **Modo File**:
  - **a campo vuoto**: "Aperti di recente", gli ultimi 8 file aperti dalla palette in quel progetto
    (`localStorage`, con `try/catch` come in `preview.js`);
  - **con una query**: ricerca fuzzy a ogni tasto, senza attesa. Funzione `fuzzy(query, path)` →
    `{ score, positions }`. Le lettere devono comparire in ordine; il punteggio premia l'inizio di un
    segmento (dopo `/ . _ -`), le lettere consecutive e le lettere nel nome del file, e penalizza poco i
    percorsi lunghi. Si mostrano i primi 200 risultati;
  - **riga**: pallino colorato per tipo, nome con le lettere trovate evidenziate, cartella attenuata,
    etichetta "ignorato" in `--vcs-ignored` per i file ignorati.
- **Modo Testo**:
  - parte 120 ms dopo l'ultimo tasto. Ogni richiesta ha un numero progressivo e le risposte vecchie si
    scartano;
  - risultati raggruppati per file (nome, cartella, numero di risultati), poi le righe, con il numero
    di riga e il testo trovato evidenziato;
  - piè di pagina: "Cerco…" durante la ricerca, poi "N risultati in M file", oppure "Più di 2000
    risultati: restringi la ricerca".
- **Tastiera**: `↑↓` scelgono la riga, `↵` apre l'anteprima (nel modo Testo alla riga trovata, che
  lampeggia con l'animazione `flash` esistente), `⌘/Ctrl+↵` mostra il file nell'albero
  (`ProjectTree.reveal`, poi `select`), `⇥` cambia modo tenendo la query, `esc` chiude e riporta il focus
  dov'era. Il passaggio del puntatore seleziona una riga e il clic la apre.
- **Vuoto**: "Nessun file con “x”. ⇥ per cercarlo nel testo." oppure "Nessun risultato per “x”."
- **Errori**: un `fs_files` o `fs_grep` fallito mostra il messaggio nella palette, non in un toast,
  perché la palette resta aperta.

### Aspetto e movimento (apple-design, come il prototipo)
- **Materiale**: lo stesso dei menu (`.menu`): traslucido, `--blur`, bordo con `--edge`, ombra profonda;
  con `prefers-reduced-transparency` diventa opaco.
- **Posizione**: in alto al centro, larga `min(620px, 100% - 32px)`. Nasce dal campo della barra
  (`transform-origin` verso il campo) con un fade, una scala da .97 e un blur da 4px (`--ease-out`,
  200 ms), ed esce per la stessa strada (`--ease-in`, 130 ms). Sotto c'è un velo leggero (`rgba(0,0,0,.22)`)
  che chiude la palette al `pointerdown`.
- **Selettore File/Testo**: segmentato, con l'indicatore che scorre (240 ms, `--ease-out`).
- **Campo**: testo a 17px con tracking negativo; selezione in `--accent` con il testo bianco.
- **Movimento ridotto**: solo dissolvenze, l'indicatore non scorre.
- **Accessibilità**: il campo è un `combobox` legato alla `listbox` dei risultati, con `aria-selected`
  sulla riga attiva.

---

## Modulo `quick-edit`

### Backend (`fsops.rs`)
- **`fs_read`** aggiunge `mtime` (ms) e `utf8` (`false` se il file non è UTF-8 valido; oggi viene letto
  in modo lossy).
- **`fs_write(file, text, mtime, force) -> { mtime }`**, nuovo comando `async`:
  - `guard(roots, file, true)`: solo dentro i progetti aperti;
  - il file deve esistere ed essere un file. Si creano file solo con `fs_create`;
  - testo fino a 1 MB, come l'anteprima;
  - se l'`mtime` attuale è diverso da quello ricevuto e `force` è falso, restituisce l'errore
    `CHANGED`;
  - scrive con `fs::write` sul file esistente, così restano inode, permessi (`.env` spesso in `600`) e
    link simbolici. `// ponytail: non atomica, un crash a metà scrittura può troncare il file;
    file temporaneo più rename (copiando mode e owner) se mai servisse`;
  - restituisce il nuovo `mtime`.

### Renderer (`src/renderer/preview.js`)
- **Pulsante "Modifica"** tra le azioni dell'anteprima, per i file di testo con `utf8: true` (non per
  immagini, binari o file troppo grandi). Per Markdown e HTML la modifica passa alla vista Sorgente.
- **Modifica**:
  - area di testo monospace con la colonna dei numeri di riga, che scorre con il testo;
  - `tab-size: 2`, nessun controllo ortografico, focus subito nel testo;
  - il titolo mostra un pallino quando ci sono modifiche non salvate;
  - le azioni diventano "Annulla" e "Salva ⌘S", e Salva è disattivato finché non cambia niente.
- **Salva** (pulsante o `⌘/Ctrl+S`):
  - `fs_write` con l'`mtime` della lettura;
  - se il file originale aveva `\r\n`, i fine riga si riconvertono prima di scrivere;
  - **riuscito**: si torna all'anteprima con il testo nuovo e compare il toast "<nome> salvato". L'albero
    e git si aggiornano da soli, perché li guarda già il watcher;
  - **`CHANGED`**: striscia sopra il testo, "<nome> è cambiato su disco da quando l'hai aperto.", con
    "Ricarica dal disco" e "Sovrascrivi" (`force`). Le modifiche restano finché l'utente non sceglie;
  - **altri errori**: toast di errore, e le modifiche restano.
- **Annulla / `esc`**: senza modifiche si torna subito all'anteprima. Con modifiche compare una barra in
  fondo: "Hai modifiche non salvate in <nome>." con "Scarta" e "Continua a modificare" (con il focus).
  Lo stesso vale chiudendo l'anteprima (✕, `esc`, clic fuori). Niente `confirm()`.
- **`.env` in anteprima** (nome che inizia con `.env`):
  - righe `NOME=valore` (anche con `export`) con il nome in `--vcs-mod` e i commenti attenuati;
  - valori visibili all'apertura, con un occhio a fine riga per coprire solo quella;
  - "Nascondi valori" tra le azioni copre tutti i valori e diventa "Mostra valori";
  - un valore coperto si vede come `••••••••••`. In modifica il testo è sempre in chiaro.
- **Piè dell'anteprima**: righe, byte, "UTF-8", e la scorciatoia attiva (`esc` Chiudi o `esc` Annulla).

### Aspetto (apple-design)
- **Pulsanti**: quelli dell'anteprima (`btn btn-small`), con la risposta su `:active`.
- **Striscia di conflitto e barra di conferma**: entrano con `slide-in` (200 ms); con movimento ridotto,
  solo dissolvenza.
- **Etichette dirette**: "Modifica", "Salva", "Scarta", "Ricarica dal disco", "Sovrascrivi". I messaggi
  dicono cosa è successo e cosa fare.

---

## Struttura
```
src-tauri/src/fsops.rs        fs_files, fs_grep, fs_write; mtime e utf8 in fs_read
src-tauri/src/main.rs         registrazione dei nuovi comandi
src/renderer/bridge.js        work.fs.files / grep / write
src/renderer/search.js        nuovo: palette, fuzzy(), highlight()
src/renderer/preview.js       Modifica, Salva, conflitto, valori .env
src/renderer/index.html       campo "Cerca in <progetto>" nella barra
src/renderer/app.js           scorciatoie ⌘P, Ctrl/⌘+Shift+P, Ctrl/⌘+Shift+F
src/renderer/style.css        palette, editor, righe .env
test/search.test.mjs          nuovo
test/preview.test.mjs         casi di modifica
README.md                     "Cosa fa": Ricerca e Modifica
```

## Code style
Come il codice intorno. Rust: funzioni libere chiamate dal comando con `blocking`, errori in
`String` italiane. JS: moduli ES, `$`/`esc` di `ui.js`, niente framework.
```js
// In order, rewarding segment starts, runs and the file name.
export function fuzzy(query, path) {
  const q = query.toLowerCase().replaceAll(' ', ''), p = path.toLowerCase();
  const nameAt = path.lastIndexOf('/') + 1;
  // ...
  return positions && { score, positions };
}
```

## Strategia di test
- **Rust** (`fsops.rs`, `tempfile` e repository di prova come in `git.rs`):
  - `fs_files` in un repository elenca tracciati e nuovi, include `.env` ignorato con
    `ignored: true` ed esclude tutto ciò che sta in `node_modules/`;
  - `fs_files` senza git salta le cartelle della lista;
  - `fs_grep` trova il testo nei file tracciati e nel `.env` ignorato; la smart case funziona; il
    limite dà `truncated`; un file binario viene saltato;
  - un percorso fuori dalle radici è rifiutato (entrambi i comandi);
  - `fs_write` scrive e restituisce l'`mtime`; con un `mtime` vecchio dà `CHANGED` e con `force`
    scrive; mantiene i permessi `600`; rifiuta percorsi fuori dalle radici e cartelle.
- **Renderer** (`node --test`):
  - `fuzzy`: `envlo` → `.env.local` prima di `environment.loader.ts`; lettere fuori ordine → nessun
    risultato; le posizioni evidenziate sono quelle giuste;
  - righe `.env`: `export NOME=valore`, valori vuoti, commenti;
  - conversione dei fine riga CRLF;
  - le risposte di `fs_grep` fuori ordine vengono scartate.
- **Verifica manuale**:
  - su `work-stack` e su un progetto con `node_modules` pieno: la palette si apre subito e le lettere
    rispondono senza ritardi;
  - modifica di un `.env` con permessi `600`: dopo il salvataggio sono ancora `600`;
  - conflitto: con il file modificato da un terminale, compare la striscia.

## Boundaries
- **Sempre**: ogni comando nuovo passa da `guard`; la scrittura solo su file esistenti dentro i
  progetti aperti; nessun ritardo artificiale sul percorso dei tasti; commit con
  `/conventional-commits`.
- **Chiedere prima**: aggiungere dipendenze (es. `ignore`, `grep-searcher`); ricerca con regex o
  sostituzione nel progetto; cercare in tutti i progetti aperti; editor con evidenziazione della
  sintassi.
- **Mai**: scrivere fuori dalle radici dei progetti; salvare senza un'azione dell'utente
  (niente salvataggio automatico); perdere modifiche non salvate senza conferma.

## Criteri di successo
- [ ] `⌘P` (macOS) / `Ctrl+Shift+P` apre la palette in meno di 100 ms, anche in un progetto con
      `node_modules` pieno; ogni tasto aggiorna i risultati senza attesa visibile.
- [ ] `envlo` trova `.env.local` (segnato "ignorato") in cima; nessun file da `node_modules/`.
- [ ] La ricerca nel testo trova `DATABASE_URL` sia nel codice sia nel `.env` ignorato, raggruppato per
      file; `↵` apre l'anteprima alla riga giusta.
- [ ] `⌘↵` mostra il file nell'albero.
- [ ] Un `.env` si apre con i valori visibili; "Nascondi valori" e l'occhio li coprono.
- [ ] Modifica, `⌘S`, toast "salvato": il file su disco è cambiato, i permessi sono gli stessi, e
      l'albero e git si aggiornano.
- [ ] Con il file cambiato su disco, il salvataggio mostra la striscia di conflitto e non sovrascrive
      senza scelta.
- [ ] `esc` con modifiche non salvate chiede "Scarta / Continua a modificare".
- [ ] `npm test`, clippy e fmt verdi.

## Domande aperte
Nessuna.

# work-agent — coordinamento tra agenti della squadra

`scripts/work-agent.py` è la CLI che gli agenti (PM, Dev, QA, agenti generici)
usano per coordinarsi dentro la sessione tmux del progetto. Non serve
interrogare i pannelli con `tmux capture-pane` a ripetizione: lo stato viene
letto dal file condiviso `.claude/dogwatch_state.json`, scritto da Dogwatch
(nativo in Work e dallo script `scripts/tmux-dogwatch.py`).

## Comandi

```bash
# Ruoli e stato rilevato dai manifesti Dogwatch
python3 scripts/work-agent.py list

# Passa un sotto-task a un collega (testo letterale + Invio)
python3 scripts/work-agent.py prompt dev1 "Esegui i test del modulo git e riporta l'esito"

# Attende che il collega raggiunga uno stato, senza sleep ciechi
python3 scripts/work-agent.py wait dev1 --until idle --timeout 600

# Legge l'output recente, ripulito da ANSI e chrome del prompt
python3 scripts/work-agent.py read dev1 --lines 200 --clean
```

Opzioni comuni: `--session <nome>`, `--root <progetto>`, `--state <file>`,
`--tmux-bin <percorso>`. La sessione viene rilevata da `--session`,
`WORK_TMUX_SESSION`, dal pannello tmux corrente (quando `TMUX` è impostato) o
dal nome della directory del progetto. Fuori da tmux non viene usato il client
più recente: si cercano solo le sessioni del progetto, ignorando i client
raggruppati `_pty_<n>`.

## Stati e semantica

- `working`: l'agente sta elaborando (spinner braille, hint di interruzione).
- `blocked`: chiede un permesso o aspetta una risposta.
- `idle`: non sta lavorando.
- `wait --until done`: alias di `idle`/processo terminato; se la finestra
  scompare, il comando ritorna 0.

`wait` osserva il file di stato condiviso, non il terminale: è reattivo e non
sporca il pane del collega. Il timeout predefinito è 300 secondi; `0` attende
senza limite.

Dopo un `prompt`, `wait --until done` (e `--until idle`) non accetta lo snapshot
idle precedente all'avvio: attende di aver osservato l'agente passare a
`working`/`blocked` e solo dopo considera conclusa l'attività. La CLI aggiorna
lo stato subito dopo il prompt e, se serve, legge direttamente il pane per non
perdere l'avvio tra due aggiornamenti di Dogwatch. Un prompt che non fa partire
l'agente porta quindi a timeout (exit 2), non a un falso successo.

## Codici di uscita

| Codice | Significato |
| --- | --- |
| `0` | successo / stato raggiunto |
| `1` | errore, inclusi usage e opzioni non valide (sessione, finestra o tmux non disponibili) |
| `2` | timeout di `wait` |

## Esempi di coordinamento

```bash
# Il PM delega e aspetta senza bloccare il proprio terminale con sleep
python3 scripts/work-agent.py prompt dev2 "Analizza il ticket DUPEGO-42"
python3 scripts/work-agent.py wait dev2 --until done --timeout 900
python3 scripts/work-agent.py read dev2 --lines 120 --clean
```

```bash
# Un dev chiede al QA di verificare e ne legge il report
python3 scripts/work-agent.py prompt qa1 "Verifica la regressione del login"
python3 scripts/work-agent.py wait qa1 --until idle --timeout 600
python3 scripts/work-agent.py read qa1 --clean
```

L'output di `list` è tabellare (`ruolo`, `stato`, `agente`, `regola` quando
presente) e adatto a essere letto sia da una persona sia da un altro agente.

#!/usr/bin/env bash
# Linux checks for SPEC-cli-open.md (criteria 8–11), run on a Linux desktop
# after `npm run install:linux`. Uses a throwaway profile (WORK_USER_DATA), so
# the real projects are not touched. Close Work before running it.
set -u
cd "$(dirname "$0")/.."
BIN=${BIN:-$HOME/.local/bin/work}
SHARE=${XDG_DATA_HOME:-$HOME/.local/share}
fail=0
ok() { echo "  ok   $*"; }
ko() { echo "  FAIL $*"; fail=1; }

if pgrep -x work >/dev/null; then echo "Chiudi Work prima di lanciare le prove."; exit 1; fi

echo "== 8. npm test"
npm test >/tmp/work-npm-test.log 2>&1 && ok "npm test" || ko "npm test (log: /tmp/work-npm-test.log)"

echo "== 9. installazione"
[ -x "$BIN" ] && ok "$BIN" || ko "manca $BIN"
for s in 32x32 128x128 256x256; do
  [ -f "$SHARE/icons/hicolor/$s/apps/work.png" ] && ok "icona $s" || ko "icona $s"
done
if command -v desktop-file-validate >/dev/null; then
  desktop-file-validate "$SHARE/applications/work.desktop" && ok "work.desktop valido" || ko "work.desktop non valido"
else
  echo "  --   desktop-file-validate non installato (pacchetto desktop-file-utils)"
fi

echo "== 10. work <cartella> da terminale"
T=$(mktemp -d)
mkdir -p "$T/data" "$T/repo/sub" "$T/altro"
export WORK_USER_DATA=$T/data
# A pty as stdin/stdout/stderr, as when typing the command in a terminal.
tty_run() { script -qec "$(printf '%q ' "$@")" /dev/null; }
wait_for() { for _ in $(seq 40); do sleep 0.5; grep -q "\"$1\"" "$T/data/state.json" 2>/dev/null && return 0; done; return 1; }
active() { python3 -c "import json;print(json.load(open('$T/data/state.json')).get('active',''))"; }

start=$(date +%s)
(cd "$T/repo/sub" && tty_run "$BIN" . >/dev/null)
[ $(( $(date +%s) - start )) -le 2 ] && ok "work . restituisce subito il prompt" || ko "work . non restituisce il prompt"
wait_for "$T/repo/sub" && [ "$(active)" = "$T/repo/sub" ] && ok "sub è il tab attivo" || ko "sub non aperto come tab attivo"
sleep 1
tty_run "$BIN" "$T/altro" >/dev/null
wait_for "$T/altro" && sleep 1 && [ "$(active)" = "$T/altro" ] && ok "altro aperto nella finestra esistente" || ko "altro non aperto"
[ "$(pgrep -x work | wc -l)" -eq 1 ] && ok "un solo processo" || ko "processi: $(pgrep -x work | wc -l)"
out=$(tty_run "$BIN" /nope | tr -d '\r')
[ "$out" = "work: non è una cartella: /nope" ] && ok "errore su /nope" || ko "errore su /nope: '$out'"
pkill -x work; sleep 1

echo "== 11. app_id"
if [ -n "${WAYLAND_DISPLAY:-}" ]; then
  id=$( (WAYLAND_DEBUG=1 timeout 8 "$BIN" </dev/null 2>&1 || true) | grep -m1 -o 'set_app_id("[^"]*")' | sed 's/set_app_id("\(.*\)")/\1/')
  pkill -x work
  [ "$id.desktop" = work.desktop ] && ok "app_id '$id' = work.desktop" || ko "app_id '$id': il file .desktop deve chiamarsi '$id.desktop'"
else
  echo "  --   sessione X11: a Work aperto, 'xprop WM_CLASS' e un clic sulla finestra; StartupWMClass deve essere uno dei due valori"
fi

rm -rf "$T"
echo
[ $fail = 0 ] && echo "Tutto ok. Manca il controllo a occhio: icona nel menu applicazioni e nella dock (criterio 13)." || echo "Ci sono prove fallite."
exit $fail

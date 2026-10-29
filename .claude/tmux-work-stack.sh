#!/usr/bin/env bash
set -euo pipefail

SESSION="work-stack"
WORKDIR="/home/flavio/workspace/work-stack"

if ! command -v tmux >/dev/null 2>&1; then
  echo "⚠️  tmux non è ancora installato. Installalo su Arch Linux con:"
  echo "   sudo pacman -S tmux"
  exit 1
fi

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "✅ Sessione tmux '$SESSION' già attiva, mi collego..."
  exec tmux attach-session -t "$SESSION"
fi

echo "🚀 Creazione ambiente tmux '$SESSION' in $WORKDIR..."

# Finestra 0: pm (Antigravity — Senior PM & Architect con auto-approvazione completa)
tmux new-session -d -s "$SESSION" -n "pm" -c "$WORKDIR"
tmux send-keys -t "$SESSION:pm" "agy --dangerously-skip-permissions" C-m

# Finestre dev1..dev3 (Claude Code — Sviluppatori Senior con auto-approvazione completa)
for dev in dev1 dev2 dev3; do
  tmux new-window -t "$SESSION" -n "$dev" -c "$WORKDIR"
  tmux send-keys -t "$SESSION:$dev" "claude --dangerously-skip-permissions" C-m
done

# Finestra qa (OpenAI Codex — QA Engineer con auto-approvazione completa)
tmux new-window -t "$SESSION" -n "qa" -c "$WORKDIR"
tmux send-keys -t "$SESSION:qa" "codex --dangerously-bypass-approvals-and-sandbox" C-m

tmux select-window -t "$SESSION:pm"
exec tmux attach-session -t "$SESSION"

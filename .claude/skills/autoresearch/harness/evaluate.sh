#!/usr/bin/env bash
# Valutatore FISSO dell'autoresearch (come evaluate_bpb di Karpathy): NON va modificato.
# Uso: bash .claude/skills/autoresearch/harness/evaluate.sh > run.log 2>&1
# Stampa in fondo il riepilogo: tests_pass, tests_total, line_cov, diff_ms, graph_ms, bench_ms.
cd "$(git rev-parse --show-toplevel)" || exit 2
HERE=.claude/skills/autoresearch/harness

out=$(timeout 300 node --test --experimental-test-coverage "test/*.test.{js,mjs}" 2>&1)
code=$?
echo "$out"
total=$(echo "$out" | sed -n 's/^ℹ tests \([0-9]*\).*/\1/p' | tail -1)
fail=$(echo "$out" | sed -n 's/^ℹ fail \([0-9]*\).*/\1/p' | tail -1)
cov=$(echo "$out" | sed -n 's/^ℹ all files *| *\([0-9.]*\).*/\1/p' | tail -1)

echo "---"
if [ "$code" -eq 0 ] && [ "${fail:-1}" -eq 0 ]; then echo "tests_pass: 1"; else echo "tests_pass: 0"; fi
echo "tests_total: ${total:-0}"
echo "line_cov: ${cov:-0}"
timeout 300 node "$HERE/bench.mjs" . || echo "bench_ms: 0"

// Benchmark FISSO dell'autoresearch (come prepare.py di Karpathy): NON va modificato.
// Misura parseDiff/changeStarts (diff) e layout/renderSvg (graph) su input
// sintetici deterministici. Stampa `bench_ms:` = somma dei tempi minimi su 15 ripetizioni.
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(process.argv[2] || '.');
const load = (p) => import(pathToFileURL(resolve(root, p)).href);
const { parseDiff, changeStarts } = await load('src/renderer/diff.js');
const { layout, renderSvg } = await load('src/renderer/graph.js');

// PRNG deterministico: gli input sono identici a ogni esecuzione.
let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const words = ['const', 'let', 'return', 'value', 'item', 'await', 'if', 'else', 'map', 'filter', 'row', 'col', '=>', '{', '}', '(', ')', ';'];
const line = () => Array.from({ length: 4 + Math.floor(rnd() * 10) }, () => words[Math.floor(rnd() * words.length)]).join(' ');

function bigDiff(nLines) {
  const out = ['diff --git a/f.js b/f.js', '--- a/f.js', '+++ b/f.js', `@@ -1,${nLines} +1,${nLines} @@`];
  for (let i = 0; i < nLines; i++) {
    const r = rnd();
    if (r < 0.7) out.push(' ' + line());
    else if (r < 0.85) { const l = line(); out.push('-' + l, '+' + l.replace('value', 'val').replace('row', 'line')); }
    else if (r < 0.93) out.push('-' + line());
    else out.push('+' + line());
  }
  return out.join('\n') + '\n';
}

function bigHistory(n) {
  const commits = [];
  const open = [];
  for (let i = 0; i < n; i++) {
    const hash = 'c' + i;
    const parents = [];
    if (i < n - 1) parents.push('c' + (i + 1));
    if (rnd() < 0.08 && i < n - 20) { const side = 'c' + (i + 2 + Math.floor(rnd() * 15)); parents.push(side); open.push(side); }
    commits.push({ hash, parents, refs: i % 97 === 0 ? ['refs/heads/b' + i] : [], subject: hash, author: 'a', time: i });
  }
  return commits;
}

const diffText = bigDiff(20000);
const history = bigHistory(20000);

function best(fn, reps = 15) {
  fn(); // warm-up
  const t = [];
  for (let i = 0; i < reps; i++) { const s = performance.now(); fn(); t.push(performance.now() - s); }
  return Math.min(...t); // il minimo è la misura più stabile contro il rumore della macchina
}

const diffMs = best(() => { const p = parseDiff(diffText); changeStarts(p.rows); });
const graphMs = best(() => renderSvg(layout(history)));
console.log(`diff_ms: ${diffMs.toFixed(2)}`);
console.log(`graph_ms: ${graphMs.toFixed(2)}`);
console.log(`bench_ms: ${(diffMs + graphMs).toFixed(2)}`);

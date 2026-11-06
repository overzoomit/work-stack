// Fleet Analytics: formatting, SVG chart geometry and summary rendering.
// The backend parsing and aggregation live in src-tauri/src/analytics.rs and
// are covered by their own cargo tests; here we test the payload the renderer
// receives from analytics_get_summary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers/renderer-env.mjs';

const A = await import('../src/renderer/analytics.js');

const sample = {
  project: '/home/me/project',
  generatedAt: 1793800000000,
  totals: {
    sessions: 12,
    tokens: 1_250_000,
    inputTokens: 900_000,
    outputTokens: 350_000,
    costUsd: 1.234,
    ticketsDone: 4,
    ticketsOpen: 2,
    avgCycleMs: 5_400_000,
    qaFirstPassRate: 0.75,
  },
  models: [
    { key: 'Anthropic/claude-sonnet-4', provider: 'Anthropic', model: 'claude-sonnet-4', sessions: 5, tokens: 900_000, costUsd: 1.1 },
    { key: 'Ollama/deepseek-v4.1', provider: 'Ollama', model: 'deepseek-v4.1', sessions: 4, tokens: 350_000, costUsd: 0.13 },
  ],
  agents: [
    { id: 'claude', name: 'Claude Code', sessions: 5, tokens: 900_000, costUsd: 1.1, avgSessionMs: 3_600_000 },
    { id: 'opencode', name: 'OpenCode', sessions: 4, tokens: 350_000, costUsd: 0.13, avgSessionMs: 1_800_000 },
  ],
  daily: [
    { date: '2026-11-01', sessions: 2, tokens: 100, tickets: 1 },
    { date: '2026-11-02', sessions: 4, tokens: 250, tickets: 0 },
    { date: '2026-11-03', sessions: 3, tokens: 180, tickets: 2 },
  ],
  tickets: [
    { id: '257d1236-7996', state: 'done', startedAt: 1, doneAt: 2, cycleMs: 5_400_000, firstPass: true },
    { id: 'aaaaaaaa-1111', state: 're-open', startedAt: 3, doneAt: null, cycleMs: null, firstPass: false },
  ],
};

test('i token sono compattati con k, M e B', () => {
  assert.equal(A.fmtTokens(0), '0');
  assert.equal(A.fmtTokens(999), '999');
  assert.equal(A.fmtTokens(1_500), '1.5k');
  assert.equal(A.fmtTokens(2_500_000), '2.5M');
  assert.equal(A.fmtTokens(1_500_000_000), '1.5B');
  assert.equal(A.fmtTokens('rotto'), '0');
});

test('il costo stimato resta leggibile anche sotto il centesimo', () => {
  assert.equal(A.fmtUsd(0), '$0.00');
  assert.equal(A.fmtUsd(1.234), '$1.23');
  assert.equal(A.fmtUsd(0.0042), '$0.0042');
});

test('la durata distingue secondi, minuti, ore e giorni', () => {
  assert.equal(A.fmtDuration(null), '—');
  assert.equal(A.fmtDuration(45_000), '45s');
  assert.equal(A.fmtDuration(45 * 60_000), '45m');
  assert.equal(A.fmtDuration(90 * 60_000), '1h 30m');
  assert.equal(A.fmtDuration(150 * 60_000), '2h 30m');
  assert.equal(A.fmtDuration(26 * 3_600_000), '1d 2h');
});

test('la percentuale del primo passaggio QA è arrotondata', () => {
  assert.equal(A.fmtPercent(null), '—');
  assert.equal(A.fmtPercent(0.75), '75%');
  assert.equal(A.fmtPercent(1), '100%');
});

test('sparkPath scala i punti nel viewBox e chiude l’area sulla base', () => {
  const p = A.sparkPath([0, 5, 10], 100, 50, 0);
  assert.deepEqual(p.points.map((x) => [x.x, x.y]), [[0, 50], [50, 25], [100, 0]]);
  assert.equal(p.max, 10);
  assert.match(p.d, /^M0\.0 50\.0 L50\.0 25\.0 L100\.0 0\.0$/);
  assert.match(p.area, /Z$/);
  assert.equal(A.sparkPath([], 100, 50).d, '');
});

test('il grafico del trend disegna ticket e sessioni con le date', () => {
  const svg = A.trendSvg(sample.daily);
  assert.match(svg, /^<svg /);
  assert.match(svg, /data-series="tickets"/);
  assert.match(svg, /data-series="sessions"/);
  assert.match(svg, /<title>2026-11-01: 1 ticket<\/title>/);
  assert.match(svg, />11\/01</);
  assert.match(svg, />11\/03</);
});

test('il grafico dei costi usa il costo quando disponibile e i token altrimenti', () => {
  const svg = A.barsSvg(sample.models);
  assert.match(svg, /data-model="Anthropic\/claude-sonnet-4"/);
  assert.match(svg, /\$1\.10/);
  assert.match(svg, /<rect /);
  const tokensOnly = A.barsSvg([{ key: 'Local/llama', provider: 'Local', model: 'llama', tokens: 1500, costUsd: 0 }]);
  assert.match(tokensOnly, /1\.5k/);
  assert.match(A.barsSvg([]), /No token usage recorded yet/);
});

test('il riepilogo mostra le KPI, gli agenti e i ticket', () => {
  const html = A.summaryHtml(sample);
  assert.equal((html.match(/class="an-kpi"/g) || []).length, 6);
  assert.match(html, /1\.3M/); // tokens
  assert.match(html, /\$1\.23/);
  assert.match(html, /75%/);
  assert.match(html, /1h 30m/);
  assert.match(html, /Claude Code/);
  assert.match(html, /first pass/);
  assert.match(html, /re-opened/);
  assert.match(html, /257d1236/);
});

test('i valori che arrivano dai log vengono sempre escapati', () => {
  const html = A.summaryHtml({
    totals: {},
    models: [{ key: '<script>x</script>', provider: '<b>', model: '&', tokens: 1, costUsd: 0 }],
    agents: [{ id: 'a', name: '<img src=x>', sessions: 1, tokens: 1, costUsd: 0 }],
    daily: [],
    tickets: [{ id: '<b>', state: '<i>', cycleMs: null, firstPass: false }],
  });
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<img src=x>/);
  assert.match(html, /&lt;script&gt;/);
});

test('un payload vuoto resta un riepilogo valido', () => {
  const html = A.summaryHtml(null);
  assert.match(html, /No agent sessions recorded yet/);
  assert.match(html, /No Plane ticket history recorded yet/);
});

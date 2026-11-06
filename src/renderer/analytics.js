// Fleet Analytics: a dashboard over the agent history the backend aggregates
// (analytics.rs) — tokens and estimated cost per model, sessions per agent,
// ticket throughput and the Dev→QA→Done cycle. Charts are plain SVG so the
// panel has no charting dependency.
import { esc } from './escape.js';
import { leave, toastError } from './ui.js';

const getBridge = () => globalThis.window?.work ?? null;

let sheet = null;
let back = null;
let project = null;
let busy = false;

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

export function fmtTokens(value) {
  const n = Math.max(0, number(value));
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) {
    const v = n / 1_000;
    return `${v.toFixed(v < 10 ? 1 : 0).replace(/\.0$/, '')}k`;
  }
  if (n < 1_000_000_000) {
    const v = n / 1_000_000;
    return `${v.toFixed(v < 10 ? 1 : 0).replace(/\.0$/, '')}M`;
  }
  const v = n / 1_000_000_000;
  return `${v.toFixed(1).replace(/\.0$/, '')}B`;
}

export function fmtUsd(value) {
  const n = Math.max(0, number(value));
  if (n === 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function fmtDuration(ms) {
  const n = Math.max(0, number(ms));
  if (n === 0) return '—';
  if (n < 60_000) return `${Math.round(n / 1_000)}s`;
  if (n < 3_600_000) return `${Math.round(n / 60_000)}m`;
  if (n < 86_400_000) {
    const hours = Math.floor(n / 3_600_000);
    const minutes = Math.round((n % 3_600_000) / 60_000);
    return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  const days = Math.floor(n / 86_400_000);
  const hours = Math.round((n % 86_400_000) / 3_600_000);
  return hours ? `${days}d ${hours}h` : `${days}d`;
}

export function fmtPercent(value) {
  if (value === null || value === undefined) return '—';
  const n = number(value);
  return `${Math.round(n * 100)}%`;
}

// Coordinates for one series inside a viewBox, with a little padding so the
// first and last points are not clipped.
export function sparkPath(values, width = 520, height = 120, pad = 8) {
  const list = (Array.isArray(values) ? values : []).map((v) => Math.max(0, number(v)));
  if (!list.length) return { d: '', area: '', max: 1, points: [] };
  const max = Math.max(1, ...list);
  const step = list.length > 1 ? (width - pad * 2) / (list.length - 1) : 0;
  const points = list.map((v, i) => ({
    x: pad + step * i,
    y: height - pad - (v / max) * (height - pad * 2),
    value: v,
  }));
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const first = points[0];
  const last = points[points.length - 1];
  const area = `${d} L${last.x.toFixed(1)} ${height - pad} L${first.x.toFixed(1)} ${height - pad} Z`;
  return { d, area, max, points };
}

const shortDate = (date) => String(date || '').slice(5).replace('-', '/');

export function trendSvg(daily, { width = 520, height = 150 } = {}) {
  const list = Array.isArray(daily) ? daily : [];
  const tickets = sparkPath(list.map((d) => d.tickets), width, height);
  const sessions = sparkPath(list.map((d) => d.sessions), width, height);
  const labels = list.length
    ? [list[0].date, list[Math.floor((list.length - 1) / 2)].date, list[list.length - 1].date]
    : [];
  const grid = [0.25, 0.5, 0.75]
    .map((f) => `<line x1="8" y1="${(height * f).toFixed(1)}" x2="${width - 8}" y2="${(height * f).toFixed(1)}" class="an-gridline"/>`)
    .join('');
  const dots = tickets.points
    .map((p, i) => (p.value > 0
      ? `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.6" class="an-dot" data-series="tickets"><title>${esc(list[i].date)}: ${p.value} ticket</title></circle>`
      : ''))
    .join('');
  const xLabels = labels
    .map((date, i) => {
      const x = i === 0 ? 8 : i === 1 ? width / 2 : width - 8;
      const anchor = i === 0 ? 'start' : i === 1 ? 'middle' : 'end';
      return `<text x="${x}" y="${height - 1}" text-anchor="${anchor}" class="an-axis">${esc(shortDate(date))}</text>`;
    })
    .join('');
  return `<svg class="an-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Ticket e sessioni nel tempo">
    <defs><linearGradient id="an-trend" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--green)" stop-opacity=".32"/><stop offset="100%" stop-color="var(--green)" stop-opacity="0"/></linearGradient></defs>
    ${grid}
    <path d="${tickets.area}" fill="url(#an-trend)"/>
    <path d="${tickets.d}" class="an-line an-line-tickets" data-series="tickets"/>
    <path d="${sessions.d}" class="an-line an-line-sessions" data-series="sessions"/>
    ${dots}${xLabels}
  </svg>`;
}

const MODEL_COLORS = ['var(--accent)', 'var(--green)', 'var(--purple)', 'var(--orange)', 'var(--teal)', 'var(--yellow)'];

export function barsSvg(models, { width = 520, rowHeight = 26, labelWidth = 190 } = {}) {
  const list = (Array.isArray(models) ? models : []).slice(0, 6);
  if (!list.length) return '<p class="an-empty">No token usage recorded yet.</p>';
  const max = Math.max(1, ...list.map((m) => number(m.costUsd) > 0 ? number(m.costUsd) : number(m.tokens)));
  const byCost = list.some((m) => number(m.costUsd) > 0);
  const height = list.length * rowHeight + 6;
  const rows = list.map((m, i) => {
    const value = byCost ? number(m.costUsd) : number(m.tokens);
    const w = Math.max(2, ((width - labelWidth - 74) * value) / max);
    const label = `${m.provider || ''} ${m.model || m.key || ''}`.trim();
    const shown = byCost ? fmtUsd(m.costUsd) : fmtTokens(m.tokens);
    const y = i * rowHeight + 4;
    return `<g data-model="${esc(m.key || m.model)}">
      <text x="0" y="${y + 14}" class="an-bar-label">${esc(label)}</text>
      <rect x="${labelWidth}" y="${y + 3}" width="${w.toFixed(1)}" height="${rowHeight - 12}" rx="4" fill="${MODEL_COLORS[i % MODEL_COLORS.length]}"/>
      <text x="${width - 2}" y="${y + 14}" text-anchor="end" class="an-bar-value">${shown}</text>
    </g>`;
  }).join('');
  return `<svg class="an-bars" viewBox="0 0 ${width} ${height}" role="img" aria-label="Costi e token per modello">${rows}</svg>`;
}

function stateClass(state) {
  const s = String(state || '').toLowerCase();
  if (s === 'done') return 'done';
  if (s === 're-open') return 'reopen';
  if (s === 'test') return 'test';
  if (s === 'in progress') return 'progress';
  return '';
}

export function summaryHtml(summary) {
  const s = summary && typeof summary === 'object' ? summary : {};
  const totals = s.totals || {};
  const daily = Array.isArray(s.daily) ? s.daily : [];
  const models = Array.isArray(s.models) ? s.models : [];
  const agents = Array.isArray(s.agents) ? s.agents : [];
  const tickets = Array.isArray(s.tickets) ? s.tickets : [];
  const kpis = [
    ['Tokens', fmtTokens(totals.tokens), `${fmtTokens(totals.inputTokens)} in · ${fmtTokens(totals.outputTokens)} out`],
    ['Estimated cost', fmtUsd(totals.costUsd), 'list price per model'],
    ['Tickets done', number(totals.ticketsDone), `${number(totals.ticketsOpen)} open`],
    ['Avg cycle', fmtDuration(totals.avgCycleMs), 'Dev → QA → Done'],
    ['QA first pass', fmtPercent(totals.qaFirstPassRate), 'no re-open'],
    ['Sessions', number(totals.sessions), 'agent sessions'],
  ];
  const kpiHtml = kpis
    .map(([label, value, hint]) => `<div class="an-kpi"><span class="an-kpi-label">${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(hint)}</small></div>`)
    .join('');
  const agentRows = agents.length
    ? agents.map((a) => `<tr>
        <td><span class="an-agent-dot"></span>${esc(a.name || a.id)}</td>
        <td>${number(a.sessions)}</td>
        <td>${fmtTokens(a.tokens)}</td>
        <td>${fmtDuration(a.avgSessionMs)}</td>
        <td>${fmtUsd(a.costUsd)}</td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="an-empty-cell">No agent sessions recorded yet.</td></tr>';
  const ticketRows = tickets.length
    ? tickets.slice(0, 10).map((t) => `<tr>
        <td class="an-ticket-id" title="${esc(t.id)}">${esc(String(t.id).slice(0, 8))}</td>
        <td><span class="an-state ${stateClass(t.state)}">${esc(t.state)}</span></td>
        <td>${fmtDuration(t.cycleMs)}</td>
        <td>${t.firstPass ? '<span class="an-pass">first pass</span>' : '<span class="an-reopen">re-opened</span>'}</td>
      </tr>`).join('')
    : '<tr><td colspan="4" class="an-empty-cell">No Plane ticket history recorded yet.</td></tr>';
  return `
    <section class="an-kpis">${kpiHtml}</section>
    <section class="an-grid">
      <div class="an-card">
        <header class="an-card-head"><h3>Tickets and sessions</h3>
          <span class="an-legend"><i class="an-legend-tickets"></i> tickets <i class="an-legend-sessions"></i> sessions</span>
        </header>
        ${trendSvg(daily)}
      </div>
      <div class="an-card">
        <header class="an-card-head"><h3>Cost by model</h3><span class="an-muted">estimated</span></header>
        ${barsSvg(models)}
      </div>
    </section>
    <section class="an-grid">
      <div class="an-card">
        <header class="an-card-head"><h3>Agents</h3></header>
        <table class="an-table">
          <thead><tr><th>Agent</th><th>Sessions</th><th>Tokens</th><th>Avg session</th><th>Cost</th></tr></thead>
          <tbody>${agentRows}</tbody>
        </table>
      </div>
      <div class="an-card">
        <header class="an-card-head"><h3>Recent tickets</h3></header>
        <table class="an-table">
          <thead><tr><th>ID</th><th>State</th><th>Cycle</th><th>QA</th></tr></thead>
          <tbody>${ticketRows}</tbody>
        </table>
      </div>
    </section>`;
}

const q = (sel) => sheet?.querySelector(sel);

async function refresh() {
  if (!sheet || !project || busy) return;
  busy = true;
  q('.an-refresh').disabled = true;
  q('.an-refresh').textContent = 'Refreshing…';
  try {
    const summary = await getBridge().analytics.summary(project.path);
    if (!sheet) return;
    q('.an-body').innerHTML = summaryHtml(summary);
    q('.an-sub').textContent = `${project.name} · updated ${new Date(summary.generatedAt || Date.now()).toLocaleTimeString()}`;
  } catch (e) {
    if (sheet) q('.an-body').innerHTML = `<p class="an-empty">Could not read the analytics: ${esc(e?.message || e)}</p>`;
    toastError(e);
  } finally {
    busy = false;
    if (sheet) {
      q('.an-refresh').disabled = false;
      q('.an-refresh').textContent = 'Refresh';
    }
  }
}

function onKey(e) {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  e.stopPropagation();
  closeAnalytics();
}

export function closeAnalytics() {
  if (!sheet) return;
  const el = sheet;
  sheet = null;
  project = null;
  busy = false;
  removeEventListener('keydown', onKey, true);
  leave(el, () => el.remove());
  back?.focus?.();
}

export async function openAnalytics(target) {
  if (!target) {
    toastError('Open a project first to see Fleet Analytics.');
    return;
  }
  if (target.remote) {
    toastError('Fleet Analytics is available for local projects only.');
    return;
  }
  if (!getBridge()?.analytics?.summary) {
    toastError('Fleet Analytics is not available in this build.');
    return;
  }
  if (sheet) {
    if (project === target) {
      await refresh();
    }
    return;
  }
  project = target;
  back = document.activeElement;
  sheet = document.createElement('div');
  sheet.className = 'sheet analytics-sheet';
  sheet.innerHTML = `
    <div class="analytics-card" role="dialog" aria-modal="true" aria-labelledby="analytics-title">
      <header class="an-head">
        <div>
          <h3 id="analytics-title">Fleet Analytics</h3>
          <p class="an-sub">${esc(target.name)} · reading agent logs…</p>
        </div>
        <div class="spacer"></div>
        <button class="btn an-refresh" type="button" data-act="refresh">Refresh</button>
        <button class="icon-btn" data-act="close" title="Close (Esc)" aria-label="Close">✕</button>
      </header>
      <div class="an-body"><div class="an-loading"><span class="an-spinner"></span> Aggregating agent sessions and ticket history…</div></div>
    </div>`;
  document.body.appendChild(sheet);
  sheet.onpointerdown = (e) => {
    if (e.target === sheet) closeAnalytics();
  };
  sheet.onclick = (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') closeAnalytics();
    else if (act === 'refresh') refresh();
  };
  addEventListener('keydown', onKey, true);
  q('.an-refresh').focus();
  await refresh();
}

export function initAnalytics({ activeProject } = {}) {
  const button = document.querySelector('#fleet-analytics');
  if (!button || typeof activeProject !== 'function') return;
  button.onclick = () => openAnalytics(activeProject());
}

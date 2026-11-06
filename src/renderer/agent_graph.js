// Mission Control: a live node canvas for the agent team.
//
// The module is deliberately free of DOM and bridge access: team.js collects
// the same snapshot it already uses for the list view and hands it here, so the
// graph can be unit-tested and re-rendered on every dogwatch / plane update.
import { esc } from './escape.js';

export const GRAPH_WIDTH = 420;
export const NODE_W = 124;
export const NODE_H = 64;
const GAP_X = 10;
const GAP_Y = 12;
const PAD = 8;
const PM_GAP = 20;

export const AGENT_STATE_LABELS = {
  idle: 'Idle',
  working: 'Working',
  blocked: 'Needs You',
  done: 'Done',
};

const FAMILY_ORDER = { pm: 0, dev: 1, qa: 2, doc: 3, generic: 4 };

// Window name -> role family and badge. Mirrors the roles in team.js without
// importing it (which would create a cycle through the popover).
export function roleOf(name) {
  const n = String(name || '').trim();
  const lower = n.toLowerCase();
  if (lower === 'pm') return { family: 'pm', label: 'PM', number: 0 };
  const match = lower.match(/^(dev|qa|doc|agent)(\d*)$/);
  if (match) {
    const family = match[1] === 'agent' ? 'generic' : match[1];
    return { family, label: n.toUpperCase(), number: Number(match[2] || 0) };
  }
  if (lower === 'generico') return { family: 'generic', label: 'AGENT', number: 0 };
  return { family: 'generic', label: n.toUpperCase() || 'AGENT', number: 0 };
}

export function sortMemberNames(names = []) {
  return [...names]
    .filter(Boolean)
    .sort((a, b) => {
      const ra = roleOf(a);
      const rb = roleOf(b);
      const fam = FAMILY_ORDER[ra.family] - FAMILY_ORDER[rb.family];
      if (fam) return fam;
      return ra.number - rb.number || String(a).localeCompare(String(b));
    });
}

// A dogwatch entry is `{ state, prompt }`; an inspection/pending entry may be a
// bare prompt. Both mean the same thing to the canvas.
export function agentState(entry) {
  if (!entry) return 'idle';
  if (entry.state === 'blocked' || entry.state === 'working' || entry.state === 'idle' || entry.state === 'done') {
    return entry.state;
  }
  if (entry.prompt_type || entry.prompt) return 'blocked';
  return 'idle';
}

function ticketFor(assignments, name) {
  return (assignments || []).find((a) => a?.window === name) || null;
}

function ticketText(assignment) {
  if (!assignment) return '';
  const issue = assignment.issue ?? assignment.id ?? '?';
  const state = String(assignment.state || '').trim();
  return `[${issue}]${state ? ` ${state}` : ''}`;
}

// Lays the PM on top and everyone else on a compact two-column grid. The
// layout is deterministic so a re-render never makes nodes jump around.
export function layoutMembers(members) {
  const pm = members.find((m) => m.family === 'pm') || null;
  const rest = members.filter((m) => m !== pm);
  const colCount = Math.min(2, Math.max(1, rest.length));
  const gridW = colCount * NODE_W + (colCount - 1) * GAP_X;
  const startX = Math.max(PAD, (GRAPH_WIDTH - gridW) / 2);
  let top = PAD;
  const placed = [];

  if (pm) {
    placed.push({ ...pm, x: (GRAPH_WIDTH - NODE_W) / 2, y: top });
    top += NODE_H + PM_GAP;
  }
  rest.forEach((member, i) => {
    const col = i % colCount;
    const row = Math.floor(i / colCount);
    placed.push({
      ...member,
      x: startX + col * (NODE_W + GAP_X),
      y: top + row * (NODE_H + GAP_Y),
    });
  });

  const height = placed.length
    ? Math.max(...placed.map((m) => m.y + NODE_H)) + PAD
    : NODE_H + PAD * 2;
  return { nodes: placed, width: GRAPH_WIDTH, height };
}

// Builds the renderable model: one node per team window plus one delegation
// edge PM -> member for each role the PM coordinates.
export function buildAgentGraph({ names = [], states = new Map(), agents = new Map(), assignments = [] } = {}) {
  const members = sortMemberNames(names).map((name) => {
    const role = roleOf(name);
    const entry = states?.get?.(name) ?? states?.[name];
    const assignment = ticketFor(assignments, name);
    const live = agentState(entry);
    // A finished ticket turns an otherwise idle node into the "done" badge;
    // dogwatch itself only reports idle / working / blocked.
    const state = live === 'idle' && String(assignment?.state || '').toLowerCase() === 'done' ? 'done' : live;
    return {
      name,
      family: role.family,
      badge: role.label,
      state,
      agent: agents?.get?.(name) || agents?.[name] || null,
      ticket: assignment,
      ticketText: ticketText(assignment),
    };
  });

  const { nodes, width, height } = layoutMembers(members);
  const pm = nodes.find((n) => n.family === 'pm');
  const edges = pm
    ? nodes
        .filter((n) => n !== pm)
        .map((n) => {
          const x1 = pm.x + NODE_W / 2;
          const y1 = pm.y + NODE_H;
          const x2 = n.x + NODE_W / 2;
          const y2 = n.y;
          const mid = Math.round((y1 + y2) / 2);
          return {
            from: pm.name,
            to: n.name,
            state: n.state,
            path: `M${x1} ${y1} C${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`,
          };
        })
    : [];
  return { nodes, edges, width, height };
}

function stateClass(state) {
  return AGENT_STATE_LABELS[state] ? state : 'idle';
}

export function nodeHtml(node) {
  const state = stateClass(node.state);
  const label = AGENT_STATE_LABELS[state];
  const agent = node.agent ? ` · ${node.agent}` : '';
  const title = `${node.name}${agent} — ${label}${node.ticketText ? ` · Ticket ${node.ticketText}` : ''}`;
  return `
    <g class="ag-node state-${state}" data-graph-node="${esc(node.name)}" transform="translate(${node.x} ${node.y})" role="button" tabindex="0" aria-label="${esc(title)}">
      <title>${esc(title)}</title>
      <rect class="ag-node-box" width="${NODE_W}" height="${NODE_H}" rx="11"/>
      <circle class="ag-state-dot" cx="${NODE_W - 12}" cy="13" r="3.5"/>
      <text class="ag-node-badge" x="9" y="16">[${esc(node.badge)}]</text>
      <text class="ag-node-name" x="9" y="33">${esc(node.name)}</text>
      <text class="ag-node-state" x="9" y="47">${esc(label)}</text>
      ${node.ticketText ? `<text class="ag-node-ticket" x="9" y="59">Ticket ${esc(node.ticketText)}</text>` : ''}
    </g>`;
}

function edgeHtml(edge) {
  const active = edge.state === 'working' || edge.state === 'blocked';
  return `
    <g class="ag-edge state-${esc(edge.state)}">
      <path class="ag-edge-line" d="${edge.path}"/>
      ${active ? `
        <circle class="ag-flow-particle state-${esc(edge.state)}" r="2.6">
          <animateMotion dur="${edge.state === 'blocked' ? '1.1s' : '1.8s'}" repeatCount="indefinite" path="${edge.path}"/>
        </circle>` : ''}
    </g>`;
}

// The SVG uses a fixed viewBox: the popover is 460px wide, so the canvas scales
// with CSS while node coordinates stay stable.
export function agentGraphSvg(graph) {
  const { nodes, edges, width, height } = graph;
  const empty = `<text class="ag-empty" x="${width / 2}" y="${height / 2}" text-anchor="middle">No agents running yet</text>`;
  return `
    <svg class="tp-graph-svg" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="Mission Control graph">
      <g class="ag-edges">${edges.map(edgeHtml).join('')}</g>
      <g class="ag-nodes">${nodes.map(nodeHtml).join('')}</g>
      ${nodes.length ? '' : empty}
    </svg>`;
}

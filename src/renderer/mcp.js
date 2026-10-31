// MCP servers, debug browsers and graphical environment, as the Agent Team
// popover shows them (data: backend mcp_status).
import { esc } from './ui.js';

export const serverReady = (s) => s.command_found !== false && s.endpoint_up !== false;

export function serverDetail(s) {
  const problems = [];
  if (s.command_found === false) problems.push(`command "${s.target}" not found`);
  if (s.endpoint_up === false) problems.push(`${s.endpoint} unreachable`);
  if (problems.length) return problems.join(' · ');
  return s.endpoint_up ? `${s.target} · ${s.endpoint} reachable` : s.target;
}

const row = (ok, name, detail, trailing) => `
  <div class="tp-row tp-mcp-row">
    <span class="tp-status-dot ${ok ? 'active' : 'waiting'}"></span>
    <div class="tp-info">
      <div class="tp-name"><span>${esc(name)}</span>${trailing}</div>
      <div class="tp-desc" title="${esc(detail)}">${esc(detail)}</div>
    </div>
  </div>`;

const badge = (ok, text) => `<span class="tp-badge-status ${ok ? 'active' : 'waiting'}">${esc(text)}</span>`;

function browserRow(b) {
  if (b.running) return row(true, b.label, b.detail, badge(true, 'Running'));
  if (!b.installed) return row(false, b.label, b.detail, badge(false, 'Not installed'));
  const start = `<button class="tp-add-btn mcp-start" data-act="mcp-launch" data-browser="${esc(b.id)}">Start</button>`;
  return row(false, b.label, b.detail, start);
}

export function mcpSection(status) {
  if (!status) return '<div class="tp-desc">MCP status not available.</div>';
  const servers = status.servers.length
    ? status.servers.map((s) => row(serverReady(s), s.name, serverDetail(s), badge(serverReady(s), serverReady(s) ? 'Ready' : 'Check'))).join('')
    : '<div class="tp-desc">No MCP servers in ~/.claude.json.</div>';
  const env = status.env.map((v) => `${esc(v.name)} ${v.present ? '✓' : '✗'}`).join(' · ');
  return `${servers}${status.browsers.map(browserRow).join('')}<div class="tp-desc tp-mcp-env">Environment for agents: ${env}</div>`;
}

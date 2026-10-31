// MCP section of the Agent Team popover: what each server and browser row says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers/renderer-env.mjs';

const { mcpSection, serverReady, serverDetail } = await import('../src/renderer/mcp.js');

const plane = { name: 'plane', transport: 'stdio', target: 'npx', env_keys: ['PLANE_API_KEY'], endpoint: 'https://plane.example.it', command_found: true, endpoint_up: true };
const firefox = { name: 'firefox-devtools', transport: 'stdio', target: 'npx', env_keys: [], endpoint: null, command_found: true, endpoint_up: null };
const env = [{ name: 'DISPLAY', present: true }, { name: 'WAYLAND_DISPLAY', present: false }];

test('a server is ready unless its command is missing or its endpoint is down', () => {
  assert.equal(serverReady(plane), true);
  assert.equal(serverReady(firefox), true, 'no endpoint to check');
  assert.equal(serverReady({ ...plane, command_found: false }), false);
  assert.equal(serverReady({ ...plane, endpoint_up: false }), false);
});

test('the detail names the problem, or what was reached', () => {
  assert.equal(serverDetail({ ...plane, command_found: false, endpoint_up: false }), 'command "npx" not found · https://plane.example.it unreachable');
  assert.equal(serverDetail(plane), 'npx · https://plane.example.it reachable');
  assert.equal(serverDetail(firefox), 'npx');
});

test('the section lists servers, browsers with their action, and the environment', () => {
  const html = mcpSection({
    servers: [plane, { ...firefox, command_found: false }],
    browsers: [
      { id: 'firefox', label: 'Firefox', installed: true, running: true, detail: 'profile /p' },
      { id: 'chrome', label: 'Chrome', installed: true, running: false, detail: 'debug port 9222' },
      { id: 'other', label: 'Other', installed: false, running: false, detail: '' },
    ],
    env,
  });
  assert.match(html, /plane[\s\S]*Ready/);
  assert.match(html, /firefox-devtools[\s\S]*Check/);
  assert.match(html, /Running/);
  assert.match(html, /data-act="mcp-launch" data-browser="chrome"/);
  assert.doesNotMatch(html, /data-browser="firefox"/, 'a running browser has no Start button');
  assert.match(html, /Not installed/);
  assert.match(html, /DISPLAY ✓ · WAYLAND_DISPLAY ✗/);
});

test('without data or servers the section says so', () => {
  assert.match(mcpSection(null), /not available/);
  assert.match(mcpSection({ servers: [], browsers: [], env: [] }), /No MCP servers/);
});

test('server text from the config is escaped', () => {
  const html = mcpSection({ servers: [{ ...firefox, name: '<img onerror=x>' }], browsers: [], env: [] });
  assert.doesNotMatch(html, /<img/);
});

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers/session.mjs';

let app;

before(async () => {
  app = await startApp();
});

after(async () => {
  await app?.stop();
});

test('window title is Work', async () => {
  await app.waitFor('#new-project');
  assert.equal(await app.title(), 'Work');
});

test('shows the empty state when no project is open', async () => {
  const empty = await app.waitFor('#empty-text');
  assert.equal(await app.text(empty), 'Open a project to get started');
});

test('topbar and open-project button are rendered', async () => {
  await app.waitFor('#new-project');
  await app.waitFor('#empty-new-term');
});

test('renders a non-empty screenshot', async () => {
  const png = await app.screenshot();
  assert.ok(png.length > 5000);
});

// Plugins… dialog: the list, install from GitHub, updates, removal and closing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { $, El, env, tick } from './helpers/renderer-env.mjs';

const oz = { id: 'oz', name: 'oz', version: '1.2.0', description: 'Sprint tools', author: 'Overzoom', repo: 'overzoomit/oz', commit: 'abc1234', path: '/p/oz', source: 'work', update_available: null };
const lint = { ...oz, id: 'lint', name: 'lint', version: null, description: null, author: null, repo: null, commit: 'def5678', path: '/p/lint' };
const stripe = { id: 'stripe@official', name: 'stripe', version: '0.11.17', description: 'Payments', author: null, repo: null, commit: 'deae744', path: '/c/stripe', source: 'claude', update_available: null };

const calls = [];
const backend = {
  list: [oz, lint, stripe],
  checked: null,
  install: null,
  update: {},
  removeFails: null,
  gate: null, // a promise that holds the next install
};
window.work.plugins = {
  list: async () => { calls.push(['list']); return backend.list; },
  checkUpdates: async () => { calls.push(['check']); return backend.checked; },
  install: async (url) => {
    calls.push(['install', url]);
    await backend.gate;
    if (backend.install instanceof Error) throw backend.install;
    return backend.install;
  },
  update: async (id) => {
    calls.push(['update', id]);
    const r = backend.update[id];
    if (r instanceof Error) throw r;
    return r;
  },
  remove: async (id) => {
    calls.push(['remove', id]);
    if (backend.removeFails) throw backend.removeFails;
  },
};
$('#modal').hidden = true; // as in index.html

const { pluginsHtml, openPluginsDialog, closePluginsDialog } = await import('../src/renderer/plugins.js');

const sheets = () => document.body.children.filter((c) => c.className === 'sheet plugins-sheet' && !c.classList.contains('closing'));
const sheet = () => sheets().at(-1);
const list = () => sheet().querySelector('.pl-list').innerHTML;
const lastToast = () => $('#toasts').children.at(-1);
const click = (act, data = {}) => {
  const target = new El();
  target.dataset = { act, ...data };
  sheet().onclick({ target });
};
const submit = (url) => {
  sheet().querySelector('.pl-url').value = url;
  sheet().querySelector('.pl-install').onsubmit({ preventDefault() {} });
};
const reset = () => {
  calls.length = 0;
  closePluginsDialog();
};

test('rows show name, version, repository and the update badge', () => {
  const html = pluginsHtml([{ ...oz, update_available: true }, { ...lint, update_available: false }, stripe]);
  assert.match(html, /<b>oz<\/b><span class="pl-version">v1\.2\.0<\/span><span class="pl-badge update">Update available<\/span>/);
  assert.match(html, /data-act="repo" data-url="https:\/\/github\.com\/overzoomit\/oz">overzoomit\/oz</);
  assert.match(html, /Sprint tools/);
  assert.match(html, /Overzoom/);
  assert.match(html, /<b>lint<\/b><span class="pl-version">def5678<\/span><span class="pl-badge ok">Up to date/, 'no version: the commit');
  assert.match(html, /<b>stripe<\/b>[\s\S]*Claude Code/);
});

test('only plugins installed by Work get Update and Remove', () => {
  const html = pluginsHtml([oz, stripe]);
  assert.match(html, /data-act="update" data-id="oz"/);
  assert.match(html, /data-act="remove" data-id="oz"/);
  assert.doesNotMatch(html, /data-id="stripe@official"/);
  assert.doesNotMatch(pluginsHtml([oz]), /pl-badge/, 'not checked yet: no badge');
});

test('a running operation disables every row and names itself', () => {
  const html = pluginsHtml([oz, lint], 'update:oz');
  assert.match(html, /data-id="oz" disabled>Updating…/);
  assert.match(html, /data-act="remove" data-id="lint" disabled>Remove/);
});

test('empty and loading lists say so; text is escaped', () => {
  assert.match(pluginsHtml([]), /No plugins installed/);
  assert.match(pluginsHtml([], 'list'), /Loading…/);
  const html = pluginsHtml([{ ...oz, name: '<img onerror=x>', repo: 'a/"><script>' }]);
  assert.doesNotMatch(html, /<img|<script/);
});

test('opening the dialog loads the list; a second open does nothing', async () => {
  reset();
  await openPluginsDialog();
  assert.equal(sheets().length, 1);
  assert.match(list(), /<b>oz<\/b>[\s\S]*<b>lint<\/b>[\s\S]*<b>stripe<\/b>/);
  await openPluginsDialog();
  assert.equal(sheets().length, 1);
  assert.deepEqual(calls, [['list']]);
});

test('install sends the trimmed URL, adds the plugin on top and clears the field', async () => {
  reset();
  await openPluginsDialog();
  backend.install = { ...oz, id: 'tools', name: 'tools' };
  submit('  ');
  assert.equal(calls.filter(([c]) => c === 'install').length, 0, 'an empty URL is not sent');
  submit('  https://github.com/o/tools  ');
  await tick();
  assert.deepEqual(calls.at(-1), ['install', 'https://github.com/o/tools']);
  assert.match(list(), /^<li class="pl-row">[\s\S]*?<b>tools<\/b>/);
  assert.equal(sheet().querySelector('.pl-url').value, '');
  assert.equal(lastToast().firstChild.textContent, 'Installed tools');
});

test('a failed install is reported and the buttons come back', async () => {
  reset();
  await openPluginsDialog();
  backend.install = new Error('Repository not found or private: check the URL and your access to it on GitHub');
  submit('https://github.com/o/secret');
  await tick();
  assert.ok(lastToast().classList.contains('error'));
  assert.match(lastToast().firstChild.textContent, /private/);
  assert.equal(sheet().querySelector('.pl-install-btn').disabled, false);
  assert.equal(sheet().querySelector('.pl-url').value, 'https://github.com/o/secret', 'kept to fix it');
});

test('while one operation runs the others wait', async () => {
  reset();
  await openPluginsDialog();
  let release;
  backend.gate = new Promise((r) => { release = r; });
  backend.install = { ...oz, id: 'slow', name: 'slow' };
  submit('https://github.com/o/slow');
  await tick(0);
  assert.equal(sheet().querySelector('.pl-install-btn').textContent, 'Installing…');
  assert.equal(sheet().querySelector('.pl-check').disabled, true);
  click('check');
  click('update', { id: 'oz' });
  release();
  backend.gate = null;
  await tick();
  assert.deepEqual(calls.map(([c]) => c), ['list', 'install']);
});

test('check for updates shows the badges and says what it found', async () => {
  reset();
  await openPluginsDialog();
  backend.checked = [{ ...oz, update_available: true }, { ...lint, update_available: false }, stripe];
  click('check');
  await tick();
  assert.match(list(), /Update available/);
  assert.match(list(), /Up to date/);
  assert.equal(lastToast().firstChild.textContent, '1 update available');
  assert.equal(sheet().querySelector('.pl-all').hidden, false);

  backend.checked = [{ ...oz, update_available: null }, { ...lint, update_available: false }, stripe];
  click('check');
  await tick();
  assert.equal(lastToast().firstChild.textContent, 'Could not check 1 plugin: is GitHub reachable?');
  assert.equal(sheet().querySelector('.pl-all').hidden, true);

  backend.checked = [{ ...oz, update_available: false }, stripe];
  click('check');
  await tick();
  assert.equal(lastToast().firstChild.textContent, 'All plugins are up to date');
});

test('update replaces the row with the new version', async () => {
  reset();
  await openPluginsDialog();
  backend.update.oz = { ...oz, version: '1.3.0', update_available: false };
  click('update', { id: 'oz' });
  await tick();
  assert.deepEqual(calls.at(-1), ['update', 'oz']);
  assert.match(list(), /v1\.3\.0[\s\S]*Up to date/);
  assert.equal(lastToast().firstChild.textContent, 'Updated oz');
});

test('update all updates only the outdated ones and goes on after a failure', async () => {
  reset();
  backend.list = [oz, lint, stripe];
  await openPluginsDialog();
  backend.checked = [{ ...oz, update_available: true }, { ...lint, update_available: true }, { ...stripe, update_available: true }];
  click('check');
  await tick();
  backend.update.oz = new Error('Not possible to fast-forward, aborting.');
  backend.update.lint = { ...lint, update_available: false };
  click('all');
  await tick();
  assert.deepEqual(calls.filter(([c]) => c === 'update'), [['update', 'oz'], ['update', 'lint']]);
  assert.match(list(), /<b>lint<\/b>[\s\S]*?Up to date/);
  assert.ok($('#toasts').children.some((t) => t.firstChild.textContent === 'oz: Not possible to fast-forward, aborting.'));
});

test('remove asks first; cancelling keeps the plugin', async () => {
  reset();
  backend.list = [oz, lint, stripe];
  await openPluginsDialog();
  click('remove', { id: 'oz' });
  await tick(0);
  assert.equal($('#modal').hidden, false);
  assert.match($('#modal-text').textContent, /Remove the plugin "oz"/);
  $('#modal-cancel').onclick();
  await tick();
  assert.equal(calls.filter(([c]) => c === 'remove').length, 0);
  assert.match(list(), /<b>oz<\/b>/);

  click('remove', { id: 'oz' });
  await tick(0);
  $('#modal-form').onsubmit({ preventDefault() {} });
  await tick();
  assert.deepEqual(calls.at(-1), ['remove', 'oz']);
  assert.doesNotMatch(list(), /<b>oz<\/b>/);
  assert.equal(lastToast().firstChild.textContent, 'Removed oz');
});

test('Claude Code plugins cannot be removed from here', async () => {
  reset();
  await openPluginsDialog();
  click('remove', { id: 'stripe@official' });
  await tick();
  assert.equal(calls.filter(([c]) => c === 'remove').length, 0);
});

test('the repository link opens in the browser', async () => {
  reset();
  await openPluginsDialog();
  click('repo', { url: 'https://github.com/overzoomit/oz' });
  assert.equal(env.opened.at(-1), 'https://github.com/overzoomit/oz');
});

test('Esc, the close button and a click outside close the dialog', async () => {
  reset();
  await openPluginsDialog();
  env.key('Escape');
  assert.equal(sheets().length, 0);

  await openPluginsDialog();
  click('close');
  assert.equal(sheets().length, 0);

  await openPluginsDialog();
  const s = sheet();
  s.onpointerdown({ target: s.querySelector('.plugins-card') });
  assert.equal(sheets().length, 1, 'a click inside keeps it open');
  s.onpointerdown({ target: s });
  assert.equal(sheets().length, 0);
});

test('Esc answers the Remove confirmation, not the dialog under it', async () => {
  reset();
  await openPluginsDialog();
  $('#modal').hidden = false;
  env.key('Escape');
  assert.equal(sheets().length, 1);
  $('#modal').hidden = true;
  env.key('Escape');
  assert.equal(sheets().length, 0);
});

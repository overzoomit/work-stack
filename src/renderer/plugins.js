// Plugins… (⋯ menu, macOS app menu): the plugins every agent Work starts can
// use, installed from GitHub (backend: plugins.rs). Claude Code's own are
// updated through its CLI and never removed from here: Claude Code manages them.
import { $, esc, ask, toast, toastError, leave } from './ui.js';

const { work } = window;

let sheet = null;
let back = null; // what had the focus before the dialog
let plugins = [];
let busy = null; // 'list' | 'install' | 'check' | 'all' | 'update:<id>' | 'remove:<id>'

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const managed = (p) => p.source === 'work';

function badge(p) {
  const source = managed(p) ? '' : '<span class="pl-badge">Claude Code</span>';
  if (p.update_available === true) return `${source}<span class="pl-badge update">Update available</span>`;
  if (p.update_available === false) return `${source}<span class="pl-badge ok">Up to date</span>`;
  return source;
}

// A Claude Code plugin gets Update only when one is known to be available.
function actions(p, now) {
  const id = esc(p.id);
  const off = now ? ' disabled' : '';
  const update = managed(p) || p.update_available
    ? `<button class="btn btn-small" data-act="update" data-id="${id}"${off}>${now === `update:${p.id}` ? 'Updating…' : 'Update'}</button>`
    : '';
  const remove = managed(p)
    ? `<button class="btn btn-small btn-danger-text" data-act="remove" data-id="${id}"${off}>${now === `remove:${p.id}` ? 'Removing…' : 'Remove'}</button>`
    : '';
  return update + remove;
}

function row(p, now) {
  const version = p.version ? `v${p.version}` : p.commit || '';
  const source = p.repo
    ? `<button class="link" data-act="repo" data-url="https://github.com/${esc(p.repo)}">${esc(p.repo)}</button>`
    : `<span title="${esc(p.path)}">${esc(p.path)}</span>`;
  const meta = [source, p.author && esc(p.author)].filter(Boolean).join(' · ');
  return `<li class="pl-row">
    <div class="pl-info">
      <div class="pl-name"><b>${esc(p.name)}</b><span class="pl-version">${esc(version)}</span>${badge(p)}</div>
      ${p.description ? `<div class="pl-desc">${esc(p.description)}</div>` : ''}
      <div class="pl-meta">${meta}</div>
    </div>
    <div class="pl-actions">${actions(p, now)}</div>
  </li>`;
}

export function pluginsHtml(list, now = null) {
  if (!list.length) {
    return `<li class="pl-empty">${now === 'list' ? 'Loading…' : 'No plugins installed. Paste a GitHub repository URL above.'}</li>`;
  }
  return list.map((p) => row(p, now)).join('');
}

function render() {
  if (!sheet) return;
  sheet.querySelector('.pl-list').innerHTML = pluginsHtml(plugins, busy);
  const button = (sel, what, idle, working) => {
    const b = sheet.querySelector(sel);
    b.disabled = !!busy;
    b.textContent = busy === what ? working : idle;
    return b;
  };
  button('.pl-install-btn', 'install', '+ Install', 'Installing…');
  button('.pl-check', 'check', 'Check for updates', 'Checking…');
  button('.pl-all', 'all', 'Update all', 'Updating…').hidden = !plugins.some((p) => p.update_available);
}

// One operation at a time: the buttons are disabled until it ends.
async function run(what, fn) {
  if (busy) return;
  busy = what;
  render();
  try {
    await fn();
  } catch (e) {
    toastError(e);
  } finally {
    busy = null;
    render();
  }
}

// A plugin already listed is replaced in place; a new one goes on top.
function upsert(p) {
  const same = (x) => x.id === p.id && x.source === p.source;
  plugins = plugins.some(same) ? plugins.map((x) => (same(x) ? p : x)) : [p, ...plugins];
}

export function install(url) {
  const trimmed = url.trim();
  if (!trimmed) return;
  return run('install', async () => {
    const p = await work.plugins.install(trimmed);
    upsert(p);
    if (sheet) sheet.querySelector('.pl-url').value = '';
    toast(`Installed ${p.name}`);
  });
}

export const checkUpdates = () => run('check', async () => {
  plugins = await work.plugins.checkUpdates();
  // Only Work's own count as failed checks: a Claude Code plugin without
  // release tags simply cannot be judged.
  const unknown = plugins.filter((p) => managed(p) && p.update_available == null).length;
  const updates = plugins.filter((p) => p.update_available).length;
  if (unknown) toast(`Could not check ${plural(unknown, 'plugin', 'plugins')}: is GitHub reachable?`, { error: true });
  else if (updates) toast(`${plural(updates, 'update', 'updates')} available`);
  else toast('All plugins are up to date');
});

export const update = (id) => run(`update:${id}`, async () => {
  const p = await work.plugins.update(id);
  upsert(p);
  toast(managed(p) ? `Updated ${p.name}` : `Updated ${p.name}: restart Claude Code sessions to load it`);
});

// A failure is reported and the others still update.
export const updateAll = () => run('all', async () => {
  for (const p of plugins.filter((x) => x.update_available)) {
    try {
      upsert(await work.plugins.update(p.id));
    } catch (e) {
      toastError(`${p.name}: ${e?.message ?? e}`);
    }
    render();
  }
});

export async function remove(id) {
  const p = plugins.find((x) => managed(x) && x.id === id);
  if (!p || busy) return;
  const ok = await ask({ text: `Remove the plugin "${p.name}"? Its folder is deleted.`, input: false, danger: true, okLabel: 'Remove' });
  if (!ok) return;
  await run(`remove:${id}`, async () => {
    await work.plugins.remove(id);
    plugins = plugins.filter((x) => !(managed(x) && x.id === id));
    toast(`Removed ${p.name}`);
  });
}

const acts = {
  close: () => closePluginsDialog(),
  check: () => checkUpdates(),
  all: () => updateAll(),
  update: ({ id }) => update(id),
  remove: ({ id }) => remove(id),
  repo: ({ url }) => work.app.openExternal(url),
};

function onClick(e) {
  const b = e.target.closest('[data-act]');
  if (b && !b.disabled) acts[b.dataset.act]?.(b.dataset);
}

// The Remove confirmation answers its own Esc.
function onKey(e) {
  if (e.key !== 'Escape' || !$('#modal').hidden) return;
  e.preventDefault();
  e.stopPropagation();
  closePluginsDialog();
}

export function closePluginsDialog() {
  if (!sheet) return;
  const el = sheet;
  sheet = null;
  removeEventListener('keydown', onKey, true);
  leave(el, () => el.remove());
  back?.focus?.();
}

export async function openPluginsDialog() {
  if (sheet) return;
  back = document.activeElement;
  sheet = document.createElement('div');
  sheet.className = 'sheet plugins-sheet';
  sheet.innerHTML = `
    <div class="plugins-card" role="dialog" aria-modal="true" aria-labelledby="plugins-title">
      <header class="pl-head">
        <div>
          <h3 id="plugins-title">Plugins</h3>
          <p class="pl-sub">Shared by every agent Work starts (dev, qa, pm) through <code>$WORK_PLUGINS_PATH</code></p>
        </div>
        <button class="icon-btn" data-act="close" title="Close (Esc)" aria-label="Close">✕</button>
      </header>
      <form class="pl-install">
        <input class="pl-url" aria-label="GitHub repository URL" placeholder="https://github.com/owner/repo or git@github.com:owner/repo.git" autocomplete="off" spellcheck="false">
        <button class="btn btn-accent pl-install-btn" type="submit">+ Install</button>
      </form>
      <ul class="pl-list"></ul>
      <footer class="pl-foot">
        <button class="btn pl-all" data-act="all" hidden>Update all</button>
        <button class="btn pl-check" data-act="check">Check for updates</button>
      </footer>
    </div>`;
  document.body.appendChild(sheet);
  sheet.onpointerdown = (e) => {
    if (e.target === sheet) closePluginsDialog();
  };
  sheet.onclick = onClick;
  sheet.querySelector('.pl-install').onsubmit = (e) => {
    e.preventDefault();
    install(sheet.querySelector('.pl-url').value);
  };
  addEventListener('keydown', onKey, true);
  sheet.querySelector('.pl-url').focus();
  await run('list', async () => {
    plugins = await work.plugins.list();
  });
}

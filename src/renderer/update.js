// App updates: look for a newer release, say so in the status bar and in one
// toast, and let the person decide. Nothing is installed on its own.
import { $, esc, ask, toast, toastError, leave, hideTip } from './ui.js';
import { marked } from './vendor/marked.esm.js';
import DOMPurify from './vendor/purify.es.mjs';

const { work } = window;

const RELEASES = 'https://github.com/overzoomit/work-stack/releases';
export const FIRST_CHECK = 10_000; // after the start, off the boot path
export const EVERY = 6 * 3600_000;

let current = ''; // the installed version
let found = null; // { version, notes, date, canInstall } of a newer one
const notified = new Set(); // one toast per version and per start
let pop = null;
// idle → installing → ready (installed, waiting for a restart)
let install = { phase: 'idle', done: 0, total: 0, error: null };
let hooks = { guard: (then) => then(), liveWork: () => ({}) }; // { guard(then), liveWork() }

export function initUpdate({ version, ...opts }) {
  current = version;
  hooks = { ...hooks, ...opts };
  setTimeout(() => check(), FIRST_CHECK);
  setInterval(() => check(), EVERY);
  work.app.onCheckUpdate(() => check({ manual: true }));
  work.app.onUpdateProgress((done, total) => {
    install = { ...install, done, total };
    drawProgress();
  });
}

// A manual check also answers when there is nothing new, or when it fails.
export async function check({ manual = false } = {}) {
  if (install.phase !== 'idle') return; // already downloaded: nothing newer to look for
  try {
    found = await work.app.updateCheck();
  } catch (e) {
    // The network is allowed to be away: only the log hears about it.
    console.warn(`controllo aggiornamenti: ${e?.message ?? e}`);
    if (manual) toastError(`Impossibile controllare gli aggiornamenti: ${e?.message ?? e}`);
    return;
  }
  showCapsule();
  if (!found) {
    closePop();
    if (manual) toast(`Work è aggiornato (${current})`);
  } else if (manual) openPop();
  else if (!notified.has(found.version)) {
    notified.add(found.version);
    toast(`Work ${found.version} è disponibile`, { action: { label: 'Dettagli', run: openPop } });
  }
}

// The version in the status bar becomes a blue capsule that opens the details.
function showCapsule() {
  const el = $('#status-version');
  el.classList.toggle('has-update', !!found);
  el.textContent = !found ? `v${current}` : install.phase === 'ready' ? 'Riavvia per aggiornare' : `Aggiorna a ${found.version}`;
  el.onclick = found ? openPop : null;
  el.onkeydown = found ? (e) => (e.key === 'Enter' || e.key === ' ') && openPop() : null;
}

const day = (ms) => new Date(ms).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });

export const notesHtml = (md) => (md?.trim() ? DOMPurify.sanitize(marked.parse(md, { gfm: true })) : '<p class="update-none">Nessuna nota di rilascio.</p>');

function closePop() {
  if (!pop) return;
  const el = pop;
  pop = null;
  removeEventListener('pointerdown', onOutside, true);
  removeEventListener('keydown', onKey, true);
  leave(el, () => el.remove());
}

function onOutside(e) {
  if (!pop?.contains(e.target) && !$('#status-version').contains(e.target)) closePop();
}

function onKey(e) {
  if (e.key === 'Escape') closePop();
}

const mb = (n) => (n / 1e6).toLocaleString('it-IT', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// "2 terminali e 1 agente verranno chiusi", or '' when nothing would end.
export function closingText({ terminals = 0, agents = 0, runs = 0 }) {
  const parts = [
    terminals && plural(terminals, 'terminale', 'terminali'),
    agents && plural(agents, 'agente', 'agenti'),
    runs && plural(runs, 'processo', 'processi'),
  ].filter(Boolean);
  if (!parts.length) return '';
  const list = parts.length > 2 ? `${parts.slice(0, -1).join(', ')} e ${parts.at(-1)}` : parts.join(' e ');
  return `${list} ${terminals + agents + runs === 1 ? 'verrà chiuso' : 'verranno chiusi'}`;
}

// The progress bar moves by transform, so it glides instead of stepping.
function drawProgress() {
  if (!pop) return;
  const { done, total } = install;
  pop.querySelector('.update-bar i').style.setProperty('--v', total ? (done / total).toFixed(3) : '0');
  pop.querySelector('.update-bar').classList.toggle('unknown', !total);
  pop.querySelector('.update-mb').textContent = total ? `${mb(done)} di ${mb(total)} MB` : `${mb(done)} MB`;
}

function buttons() {
  if (install.phase === 'installing') return '';
  if (install.phase === 'ready') return '<button class="btn" data-up="later">Al prossimo avvio</button><button class="btn btn-accent" data-up="restart">Riavvia ora</button>';
  return `<button class="btn" data-up="later">Più tardi</button>${
    found.canInstall
      ? `<button class="btn btn-accent" data-up="install">${install.error ? 'Riprova' : 'Installa'}</button>`
      : '<button class="btn btn-accent" data-up="download">Scarica</button>'}`;
}

// Buttons and the bar follow the phase; the notes stay as they are.
function drawPop() {
  if (!pop) return;
  const installing = install.phase === 'installing';
  pop.querySelector('.update-progress').hidden = !installing;
  pop.querySelector('.update-error').textContent = install.error || '';
  pop.querySelector('.update-btns').innerHTML = buttons();
  if (installing) drawProgress();
  const btn = (name) => pop.querySelector(`[data-up="${name}"]`);
  btn('later') && (btn('later').onclick = closePop);
  btn('install') && (btn('install').onclick = installNow);
  btn('restart') && (btn('restart').onclick = restartNow);
  btn('download') && (btn('download').onclick = () => {
    work.app.openExternal(`${RELEASES}/tag/v${found.version}`);
    closePop();
  });
}

async function installNow() {
  install = { phase: 'installing', done: 0, total: 0, error: null };
  drawPop();
  try {
    await work.app.updateInstall();
    install = { ...install, phase: 'ready' };
  } catch (e) {
    install = { phase: 'idle', done: 0, total: 0, error: e?.message ?? String(e) };
    toastError(e);
  }
  showCapsule();
  drawPop();
}

// Unsaved edits are asked about first; live terminals and agents are named before they end.
function restartNow() {
  hooks.guard(async () => {
    const closing = closingText(hooks.liveWork());
    if (closing) {
      const ok = await ask({ text: `Riavviando Work, ${closing}. Riavviare ora?`, input: false, danger: true, okLabel: 'Riavvia' });
      if (!ok) return;
    }
    try {
      await work.app.updateRestart();
    } catch (e) {
      toastError(e);
    }
  });
}

// Grows out of the capsule and goes back into it.
function openPop() {
  if (pop) return closePop();
  if (!found) return;
  hideTip();
  const el = document.createElement('div');
  el.className = 'update-pop';
  el.setAttribute('role', 'dialog');
  el.innerHTML = `<h3>Work ${esc(found.version)}</h3>
    <p class="update-date">${found.date ? `Pubblicata il ${day(found.date)} · ` : ''}hai la ${esc(current)}</p>
    <div class="update-notes">${notesHtml(found.notes)}</div>
    <div class="update-progress" hidden><div class="update-bar"><i></i></div><span class="update-mb"></span></div>
    <p class="update-error"></p>
    <div class="update-btns"></div>`;
  // Links in the notes open in the browser, never in the app's own page.
  el.querySelector('.update-notes').onclick = (e) => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    e.preventDefault();
    if (/^https?:/.test(a.getAttribute('href'))) work.app.openExternal(a.getAttribute('href'));
  };
  document.body.appendChild(el);
  pop = el;
  drawPop();
  const r = $('#status-version').getBoundingClientRect();
  el.style.right = `${Math.max(8, innerWidth - r.right)}px`;
  el.style.bottom = `${innerHeight - r.top + 8}px`;
  el.style.transformOrigin = `calc(100% - ${r.width / 2}px) 100%`;
  addEventListener('pointerdown', onOutside, true);
  addEventListener('keydown', onKey, true);
}

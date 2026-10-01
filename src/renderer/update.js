// App updates: look for a newer release, say so in the status bar and in one
// toast, and let the person decide. Nothing is installed on its own.
import { $, esc, toast, toastError, leave, hideTip } from './ui.js';
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

export function initUpdate({ version }) {
  current = version;
  setTimeout(() => check(), FIRST_CHECK);
  setInterval(() => check(), EVERY);
  work.app.onCheckUpdate(() => check({ manual: true }));
}

// A manual check also answers when there is nothing new, or when it fails.
export async function check({ manual = false } = {}) {
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
  el.textContent = found ? `Aggiorna a ${found.version}` : `v${current}`;
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
    <div class="update-btns">
      <button class="btn" data-up="later">Più tardi</button>
      <button class="btn btn-accent" data-up="download">Scarica</button>
    </div>`;
  // Links in the notes open in the browser, never in the app's own page.
  el.querySelector('.update-notes').onclick = (e) => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    e.preventDefault();
    if (/^https?:/.test(a.getAttribute('href'))) work.app.openExternal(a.getAttribute('href'));
  };
  el.querySelector('[data-up="later"]').onclick = closePop;
  el.querySelector('[data-up="download"]').onclick = () => {
    work.app.openExternal(`${RELEASES}/tag/v${found.version}`);
    closePop();
  };
  document.body.appendChild(el);
  const r = $('#status-version').getBoundingClientRect();
  el.style.right = `${Math.max(8, innerWidth - r.right)}px`;
  el.style.bottom = `${innerHeight - r.top + 8}px`;
  el.style.transformOrigin = `calc(100% - ${r.width / 2}px) 100%`;
  pop = el;
  addEventListener('pointerdown', onOutside, true);
  addEventListener('keydown', onKey, true);
}

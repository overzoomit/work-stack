// Shared UI primitives: helpers, toasts, prompt modal, context menu, sheets.
import { esc } from './escape.js';

export { esc };
export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];

// Replace an element's markup only when it actually changed: avoids re-layout
// and repaint for periodic refreshes that produce the same list.
export function setHtml(el, html) {
  if (el._html === html) return false;
  el._html = html;
  el.innerHTML = html;
  return true;
}

// First n characters without cutting an emoji (a surrogate pair) in half.
export function clip(s, n) {
  const c = s.slice(0, n);
  return /[\uD800-\uDBFF]$/.test(c) ? c.slice(0, -1) : c;
}

export const basename = (p) => p?.split('/').filter(Boolean).pop() || p;
export const dirname = (p) => p.slice(0, p.lastIndexOf('/')) || '/';

export function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 10) return 'ora';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  if (s < 30 * 86400) return `${Math.floor(s / 86400)} g`;
  return new Date(ms).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: '2-digit' });
}

export const fullDate = (ms) => new Date(ms).toLocaleString('it-IT', {
  day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

// Exit along the same path the element came in, then run `done`.
// Runs `fn` once the exit animation just started on `el` has finished. An
// element that is hidden or detached never fires animationend, so then `fn`
// runs right away; a timer covers any other case where the event is lost.
export function afterExit(el, fn, fallbackMs = 600) {
  let done = false;
  let timer = null;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    fn();
  };
  const animated = el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).animationName !== 'none';
  if (!animated) {
    finish();
    return;
  }
  el.addEventListener('animationend', finish, { once: true });
  timer = setTimeout(finish, fallbackMs);
}

export function leave(el, done) {
  el.classList.add('closing');
  afterExit(el, () => {
    el.classList.remove('closing');
    done?.();
  });
}

// ── Toasts ───────────────────────────────────────────────────
// action: { label, run } adds an inline button (e.g. "Annulla").
export function toast(message, { error = false, action = null } = {}) {
  const el = document.createElement('div');
  el.className = `toast${error ? ' error' : ''}`;
  el.innerHTML = `<span class="toast-text"></span>`;
  el.firstChild.textContent = message;
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-action';
    b.textContent = action.label;
    b.onclick = () => {
      dismiss();
      action.run();
    };
    el.appendChild(b);
  }
  $('#toasts').appendChild(el);
  let gone = false;
  const dismiss = () => {
    if (gone) return;
    gone = true;
    leave(el, () => el.remove());
  };
  setTimeout(dismiss, error ? 7000 : action ? 6000 : 3000);
}
export const toastError = (e) => toast(e?.message || String(e), { error: true });

// ── Prompt / confirm modal ──────────────────────────────────
export function ask({ text, value = '', placeholder = '', okLabel = 'OK', danger = false, input = true, select = null }) {
  return new Promise((resolve) => {
    const modal = $('#modal');
    const field = $('#modal-input');
    const ok = $('#modal-ok');
    $('#modal-text').textContent = text;
    field.hidden = !input;
    field.value = value;
    field.placeholder = placeholder;
    ok.textContent = okLabel;
    ok.classList.toggle('btn-danger', danger);
    ok.classList.toggle('btn-accent', !danger);
    modal.hidden = false;
    if (input) {
      field.focus();
      // Pre-select the part people usually change (file name without extension).
      const [a, b] = select || [0, value.length];
      field.setSelectionRange(a, b);
    } else ok.focus();

    const finish = (result) => {
      $('#modal-form').onsubmit = null;
      $('#modal-cancel').onclick = null;
      modal.onkeydown = null;
      leave(modal, () => {
        modal.hidden = true;
        resolve(result);
      });
    };
    $('#modal-form').onsubmit = (e) => {
      e.preventDefault();
      finish(input ? field.value.trim() || null : true);
    };
    $('#modal-cancel').onclick = () => finish(null);
    // Block body: an on<event> handler returning false cancels the event, and
    // a cancelled Enter never submits the form.
    modal.onkeydown = (e) => {
      if (e.key === 'Escape') finish(null);
    };
  });
}

// ── Tooltips ────────────────────────────────────────────────
// A small card that grows out of its anchor. As on macOS the first one waits
// a moment, while moving to a neighbour right after shows it at once. A press
// or keyboard focus shows it without waiting.
let tip = null; // { el, card, render }
let tipTimer = 0;
let warmUntil = 0;
let tipClosing = null;

export function tooltip(el, render) {
  el.tabIndex = 0;
  el.setAttribute('aria-describedby', 'tip');
  const open = () => showTip(el, render);
  el.addEventListener('pointerenter', () => {
    clearTimeout(tipTimer);
    tipTimer = setTimeout(open, performance.now() < warmUntil ? 0 : 450);
  });
  el.addEventListener('pointerleave', hideTip);
  el.addEventListener('pointerdown', open);
  el.addEventListener('focus', open);
  el.addEventListener('blur', hideTip);
}

function showTip(el, render) {
  clearTimeout(tipTimer);
  if (tip?.el === el) return;
  const warm = !!tip || performance.now() < warmUntil;
  if (tip) tip.card.remove();
  // Switching between neighbours: no exit/enter overlap, the new card just appears.
  if (warm) tipClosing?.remove();
  const card = document.createElement('div');
  card.className = warm ? 'tip warm' : 'tip';
  card.id = 'tip';
  card.setAttribute('role', 'tooltip');
  document.body.append(card);
  tip = { el, card, render };
  refreshTip();
}

// Re-renders the open tooltip (all of them, or only the one of `el`), e.g.
// when the numbers it shows change while it is open.
export function refreshTip(el) {
  if (!tip || (el && tip.el !== el)) return;
  const { card } = tip;
  card.innerHTML = tip.render();
  // Above the anchor, centred on it but kept on screen; it grows from the anchor.
  const a = tip.el.getBoundingClientRect();
  const w = card.offsetWidth;
  const left = Math.min(Math.max(8, a.left + a.width / 2 - w / 2), innerWidth - w - 8);
  card.style.left = `${left}px`;
  card.style.bottom = `${innerHeight - a.top + 6}px`;
  card.style.transformOrigin = `${a.left + a.width / 2 - left}px 100%`;
}

export function hideTip() {
  clearTimeout(tipTimer);
  if (!tip) return;
  const { card } = tip;
  tip = null;
  warmUntil = performance.now() + 600;
  tipClosing = card;
  leave(card, () => card.remove());
}
addEventListener('keydown', (e) => e.key === 'Escape' && hideTip());
addEventListener('resize', hideTip);
addEventListener('blur', hideTip);

// ── Context menu ────────────────────────────────────────────
// Grows out of the pointer position so the link to the click is obvious.
let menuEl = null;

export function closeMenu() {
  if (!menuEl) return;
  const el = menuEl;
  menuEl = null;
  leave(el, () => el.remove());
}

export function contextMenu(x, y, items) {
  closeMenu();
  const el = document.createElement('div');
  el.className = 'menu';
  for (const item of items) {
    if (item === '-') {
      el.insertAdjacentHTML('beforeend', '<div class="menu-sep"></div>');
      continue;
    }
    if (item.header) {
      el.insertAdjacentHTML('beforeend', `<div class="menu-label">${esc(item.header)}</div>`);
      continue;
    }
    const b = document.createElement('button');
    b.className = `menu-item${item.danger ? ' danger' : ''}${item.checked !== undefined ? ' checkable' : ''}`;
    b.disabled = !!item.disabled;
    b.innerHTML = `${item.checked !== undefined ? `<i class="check">${item.checked ? '✓' : ''}</i>` : ''}<span></span>${item.detail ? `<small></small>` : ''}<kbd>${esc(item.hint || '')}</kbd>`;
    b.querySelector('span').textContent = item.label;
    if (item.detail) b.querySelector('small').textContent = item.detail;
    b.onclick = () => {
      closeMenu();
      item.run();
    };
    el.appendChild(b);
  }
  document.body.appendChild(el);
  const r = el.getBoundingClientRect();
  const left = Math.min(x, innerWidth - r.width - 8);
  const top = Math.min(y, innerHeight - r.height - 8);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.style.transformOrigin = `${x - left}px ${y - top}px`;
  menuEl = el;
}

addEventListener('pointerdown', (e) => {
  if (menuEl && !menuEl.contains(e.target)) closeMenu();
}, true);
addEventListener('keydown', (e) => e.key === 'Escape' && closeMenu());
addEventListener('blur', closeMenu);

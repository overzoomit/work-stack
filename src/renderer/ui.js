// Shared UI primitives: helpers, toasts, prompt modal, context menu, sheets.

export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Replace an element's markup only when it actually changed: avoids re-layout
// and repaint for periodic refreshes that produce the same list.
export function setHtml(el, html) {
  if (el._html === html) return false;
  el._html = html;
  el.innerHTML = html;
  return true;
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
export function leave(el, done) {
  el.classList.add('closing');
  el.addEventListener('animationend', () => {
    el.classList.remove('closing');
    done?.();
  }, { once: true });
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
    modal.onkeydown = (e) => e.key === 'Escape' && finish(null);
  });
}

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

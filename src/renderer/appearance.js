// "Aa" popover: terminal profiles (Terminal.app style), text size, cursor.
// Hovering a swatch previews it live on every pane; clicking commits.
import { esc, leave } from './ui.js';
import { THEMES, DEFAULTS, FONT_MIN, FONT_MAX } from './themes.js';
import { getAppearance, setAppearance, previewTheme } from './terminals.js';

let pop = null;
let anchor = null;

// A tiny prompt drawn with the theme's own colours.
function swatch(t) {
  const [, red, green, yellow, blue, magenta, cyan] = t.ansi;
  return `
    <button class="tp-swatch" data-theme="${t.id}" title="${esc(t.name)}">
      <span class="tp-screen${t.glass ? ' glass' : ''}" style="--bg:${t.bg};--fg:${t.fg}">
        <span><i style="color:${green}">~</i> <i style="color:${blue}">work</i> <i style="color:${t.fg}">$</i> ls</span>
        <span><i style="color:${cyan}">src</i> <i style="color:${magenta}">docs</i> <i style="color:${yellow}">a.md</i></span>
        <span><i style="color:${red}">✗</i> <i style="color:${t.fg}">$</i> <b style="background:${t.cursor}"></b></span>
      </span>
      <span class="tp-name">${esc(t.name)}</span>
    </button>`;
}

function render() {
  const s = getAppearance();
  pop.querySelectorAll('.tp-swatch').forEach((b) => b.classList.toggle('active', b.dataset.theme === s.theme));
  pop.querySelector('.tp-size-value').textContent = `${s.fontSize} pt`;
  pop.querySelector('[data-size="-1"]').disabled = s.fontSize <= FONT_MIN;
  pop.querySelector('[data-size="1"]').disabled = s.fontSize >= FONT_MAX;
  pop.querySelectorAll('[data-cursor]').forEach((b) => b.classList.toggle('active', b.dataset.cursor === s.cursorStyle));
  pop.querySelector('.tp-blink').setAttribute('aria-checked', String(s.cursorBlink));
}

export function closeAppearance() {
  if (!pop) return;
  const el = pop;
  pop = null;
  anchor?.classList.remove('open');
  previewTheme(null);
  removeEventListener('pointerdown', onOutside, true);
  removeEventListener('keydown', onKey, true);
  leave(el, () => el.remove());
}

function onOutside(e) {
  if (pop && !pop.contains(e.target) && e.target !== anchor) closeAppearance();
}

function onKey(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeAppearance();
  }
}

export function openAppearance(button) {
  if (pop) {
    const same = anchor === button;
    closeAppearance();
    if (same) return;
  }
  anchor = button;
  anchor.classList.add('open');
  pop = document.createElement('div');
  pop.className = 'term-pop';
  pop.innerHTML = `
    <header class="ap-head">
      <div class="ap-title">Aspetto del terminale</div>
      <div class="ap-sub">Vale per tutti i terminali · passa sopra un tema per provarlo</div>
    </header>
    <div class="tp-grid">${THEMES.map(swatch).join('')}</div>
    <div class="tp-rows">
      <div class="tp-row">
        <span class="tp-label">Dimensione testo</span>
        <div class="tp-stepper">
          <button data-size="-1" title="Più piccolo (Ctrl −)">−</button>
          <span class="tp-size-value"></span>
          <button data-size="1" title="Più grande (Ctrl +)">+</button>
        </div>
      </div>
      <div class="tp-row">
        <span class="tp-label">Cursore</span>
        <div class="segmented">
          <button data-cursor="bar"><i class="cur bar"></i>Barra</button>
          <button data-cursor="block"><i class="cur block"></i>Blocco</button>
          <button data-cursor="underline"><i class="cur underline"></i>Linea</button>
        </div>
      </div>
      <div class="tp-row">
        <span class="tp-label">Cursore lampeggiante</span>
        <button class="tp-blink switch" role="switch" aria-checked="true"><i></i></button>
      </div>
    </div>
    <footer class="ap-foot">
      <span><kbd>Ctrl</kbd><kbd>+</kbd> <kbd>−</kbd> <kbd>0</kbd> dimensione</span>
      <div class="spacer"></div>
      <button class="link tp-reset">Ripristina</button>
    </footer>`;
  document.body.appendChild(pop);

  // Anchored under the "Aa" button, growing out of it.
  const b = button.getBoundingClientRect();
  const w = pop.offsetWidth;
  const left = Math.min(Math.max(8, b.right - w), innerWidth - w - 8);
  const top = Math.min(b.bottom + 8, innerHeight - pop.offsetHeight - 8);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  pop.style.transformOrigin = `${b.left + b.width / 2 - left}px ${b.top - top}px`;
  render();

  pop.addEventListener('pointerover', (e) => {
    const sw = e.target.closest('.tp-swatch');
    if (sw) previewTheme(sw.dataset.theme);
  });
  pop.querySelector('.tp-grid').addEventListener('pointerleave', () => previewTheme(null));
  pop.addEventListener('click', (e) => {
    const sw = e.target.closest('.tp-swatch');
    const size = e.target.closest('[data-size]');
    const cur = e.target.closest('[data-cursor]');
    if (sw) {
      previewTheme(null);
      setAppearance({ theme: sw.dataset.theme });
    } else if (size) {
      setAppearance({ fontSize: getAppearance().fontSize + Number(size.dataset.size) });
    } else if (cur) {
      setAppearance({ cursorStyle: cur.dataset.cursor });
    } else if (e.target.closest('.tp-blink')) {
      setAppearance({ cursorBlink: !getAppearance().cursorBlink });
    } else if (e.target.closest('.tp-reset')) {
      setAppearance({ ...DEFAULTS });
    } else return;
    render();
  });
  addEventListener('pointerdown', onOutside, true);
  addEventListener('keydown', onKey, true);
}

// Ctrl/Cmd + = / − / 0 change the text size, like Terminal.app.
addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
  const s = getAppearance();
  let next = null;
  if (e.key === '=' || e.key === '+') next = s.fontSize + 1;
  else if (e.key === '-') next = s.fontSize - 1;
  else if (e.key === '0') next = DEFAULTS.fontSize;
  if (next === null) return;
  e.preventDefault();
  e.stopPropagation();
  setAppearance({ fontSize: next });
  if (pop) render();
}, true);

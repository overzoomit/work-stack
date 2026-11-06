// In-buffer search for a terminal pane. One bar per pane, so every terminal
// keeps its own query and match position; switching project hides and restores
// it with the pane. The matches come from @xterm/addon-search, which also
// repaints them after a resize.
import { SearchAddon } from './vendor/addon-search.mjs';
import { isTerminalSearchKey } from './keys.js';

const DECORATIONS = {
  // The addon turns matchBackground/activeMatchBackground into the decoration
  // fill, and the *Border values into its outline; the overview ruler alone
  // leaves the matches invisible in the buffer.
  matchBackground: 'rgba(10, 132, 255, 0.30)',
  matchBorder: '#0a84ff',
  activeMatchBackground: 'rgba(255, 214, 10, 0.45)',
  activeMatchBorder: '#ffd60a',
  matchOverviewRuler: '#0a84ff',
  activeMatchColorOverviewRuler: '#ffd60a',
};

const SEARCH_OPTIONS = {
  incremental: true,
  decorations: DECORATIONS,
};

// Returns the bar attached to `pane`; the terminal in it is `term`.
export function createTerminalSearch({ term, pane, host }) {
  const addon = new SearchAddon();
  term.loadAddon(addon);

  const el = document.createElement('div');
  el.className = 'term-search';
  el.hidden = true;
  el.setAttribute('role', 'search');
  el.setAttribute('aria-label', 'Find in terminal');
  el.innerHTML = `
    <input class="term-search-input" type="text" spellcheck="false" autocomplete="off"
      placeholder="Find in terminal" aria-label="Find in terminal">
    <span class="term-search-count" aria-live="polite"></span>
    <button type="button" class="icon-btn term-search-prev" title="Previous match (Shift+Enter)" aria-label="Previous match">↑</button>
    <button type="button" class="icon-btn term-search-next" title="Next match (Enter)" aria-label="Next match">↓</button>
    <button type="button" class="icon-btn term-search-close" title="Close (Esc)" aria-label="Close search">✕</button>`;
  host.appendChild(el);

  const input = el.querySelector('.term-search-input');
  const count = el.querySelector('.term-search-count');
  const prev = el.querySelector('.term-search-prev');
  const next = el.querySelector('.term-search-next');
  const closeBtn = el.querySelector('.term-search-close');

  // `open` is the user's intent, not just visibility: a project switch hides
  // the pane (and the bar) and brings both back when the project returns.
  const state = { open: false, query: '' };
  let resizeTimer = 0;

  const results = addon.onDidChangeResults(({ resultIndex, resultCount }) => {
    if (!state.query) return paintCount('');
    if (!resultCount) return paintCount('No results');
    paintCount(resultIndex >= 0 ? `${resultIndex + 1} of ${resultCount}` : `${resultCount} matches`);
  });

  function paintCount(text) {
    count.textContent = text;
    count.classList.toggle('empty', !text);
    const none = text === 'No results' || !text;
    prev.disabled = none;
    next.disabled = none;
  }

  function runSearch(query, { incremental = true, backwards = false } = {}) {
    if (!query) {
      addon.clearDecorations();
      paintCount('');
      return false;
    }
    const options = { ...SEARCH_OPTIONS, incremental };
    return backwards ? addon.findPrevious(query, options) : addon.findNext(query, options);
  }

  function readInput() {
    state.query = input.value;
    runSearch(state.query);
  }

  function open() {
    state.open = true;
    el.hidden = false;
    input.focus();
    if (state.query) {
      input.value = state.query;
      runSearch(state.query);
    }
    input.setSelectionRange(0, input.value?.length || 0);
    prev.disabled = next.disabled = !state.query;
    return el;
  }

  function close({ restoreFocus = true } = {}) {
    state.open = false;
    el.hidden = true;
    addon.clearDecorations();
    paintCount('');
    if (restoreFocus) term.focus();
  }

  function toggle() {
    if (state.open) close();
    else open();
  }

  // Matches follow the pane through a resize; debounced because a window drag
  // fires one event per frame.
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!state.open || !state.query) return;
      runSearch(state.query, { incremental: true });
    }, 120);
  }

  input.addEventListener('input', readInput);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      runSearch(input.value, { incremental: false, backwards: e.shiftKey });
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });
  prev.onclick = () => runSearch(input.value, { incremental: false, backwards: true });
  next.onclick = () => runSearch(input.value, { incremental: false });
  closeBtn.onclick = () => close();

  // Ctrl/⌘+F and Ctrl/⌘+Shift+F open the bar from anywhere in the pane. Capture
  // it before xterm's textarea turns it into a control character.
  pane.addEventListener('keydown', (e) => {
    if (!isTerminalSearchKey(e)) return;
    e.preventDefault();
    e.stopPropagation();
    open();
  }, true);

  addEventListener('resize', onResize);

  function suspend() {
    el.hidden = true;
  }

  function resume() {
    if (state.open) el.hidden = false;
  }

  function dispose() {
    clearTimeout(resizeTimer);
    removeEventListener('resize', onResize);
    results?.dispose?.();
    addon.dispose();
    el.remove();
  }

  return {
    el, input, count, prev, next, closeBtn, addon, state,
    open, close, toggle, suspend, resume, dispose,
    search: (query) => { input.value = query; readInput(); },
    findNext: () => runSearch(input.value, { incremental: false }),
    findPrevious: () => runSearch(input.value, { incremental: false, backwards: true }),
    isOpen: () => state.open && !el.hidden,
  };
}

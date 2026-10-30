// Sidebar accordion sections, VS Code style. Kept apart from the app so the
// open/close rules (pointer, keyboard, reveal) can be tested without booting it.
import { $, $$ } from './ui.js';

let hooks = {
  openSidebar: () => {},
  onExpand: () => {},
};

export function initAccordion(opts = {}) {
  hooks = { ...hooks, ...opts };
  bindAccordions($$('.acc-toggle'));
}

// A real click is what Enter and Space produce on a <button>: one handler
// covers pointer, keyboard and assistive technology.
export function bindAccordions(toggles) {
  for (const b of toggles) b.onclick = () => toggleSection(b.dataset.sec);
}

export function sectionEl(name) {
  return $(`.acc[data-sec="${name}"]`);
}

export const sectionOpen = (name) => !!sectionEl(name)?.classList.contains('open');

export function setSection(name, open) {
  const sec = sectionEl(name);
  if (!sec) return false;
  sec.classList.toggle('open', open);
  sec.querySelector('.acc-toggle')?.setAttribute('aria-expanded', String(open));
  hooks.onExpand(name, open);
  return true;
}

export const toggleSection = (name) => setSection(name, !sectionOpen(name));

// Reveal a section from an action (search result, run start, repo open): the
// sidebar may be collapsed, so bring it back before expanding the section.
export function revealSection(name) {
  hooks.openSidebar();
  return setSection(name, true);
}

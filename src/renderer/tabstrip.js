// Project tab strip behaviour: wheel scrolling and keeping the active tab in view.

export function wheelScroll(strip, event) {
  if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
  event.preventDefault();
  strip.scrollLeft += event.deltaY;
}

export function revealActiveTab(strip) {
  strip.querySelector('.ptab.active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

// The strip width changes as the rest of the topbar settles, which moves the
// scroll limit: reveal again so the active tab is never left cut off.
export function keepActiveTabVisible(strip) {
  new ResizeObserver(() => revealActiveTab(strip)).observe(strip);
}

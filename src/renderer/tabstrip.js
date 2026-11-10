// Project tab strip behaviour: wheel scrolling and keeping the active tab in view.

export function wheelScroll(strip, event) {
  if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
  event.preventDefault();
  strip.scrollLeft += event.deltaY;
}

export function revealActiveTab(strip) {
  strip.querySelector('.ptab.active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

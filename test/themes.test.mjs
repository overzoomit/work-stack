// Every terminal theme must be complete and readable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THEMES, DEFAULTS, themeById, xtermTheme } from '../src/renderer/themes.js';

const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;
// "#rrggbb[aa]" or "rgba(r, g, b, a)" → [r, g, b] in 0..255 (alpha ignored).
const rgb = (c) => (c.startsWith('#') ? [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) : c.match(/\d+/g).slice(0, 3).map(Number));
const luminance = (color) => {
  const [r, g, b] = rgb(color).map((c) => c / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('ogni tema ha id univoco, 16 colori ANSI e tutti i colori richiesti', () => {
  assert.equal(new Set(THEMES.map((t) => t.id)).size, THEMES.length);
  for (const t of THEMES) {
    assert.equal(t.ansi.length, 16, t.id);
    for (const c of [...t.ansi, t.fg, t.cursor]) assert.match(c, HEX, `${t.id}: ${c}`);
    assert.ok(t.selection, `${t.id}: selection`);
    assert.equal(typeof t.dark, 'boolean', t.id);
  }
});

test('il testo di ogni tema è leggibile sul suo sfondo (contrasto AA)', () => {
  for (const t of THEMES) {
    // Translucent themes are judged on their opaque colour.
    assert.ok(contrast(t.fg, t.bg) >= 4.5, `${t.id}: ${contrast(t.fg, t.bg).toFixed(2)}`);
  }
});

test('xtermTheme lascia lo sfondo al pannello e mappa i colori ANSI in ordine', () => {
  const t = themeById('basic-light');
  const x = xtermTheme(t);
  assert.equal(x.background, '#00000000');
  assert.equal(x.black, t.ansi[0]);
  assert.equal(x.brightWhite, t.ansi[15]);
  assert.equal(x.cursorAccent, '#ffffff', 'light theme: light accent under the cursor');
});

test('un id sconosciuto torna al tema predefinito', () => {
  assert.equal(themeById('non-esiste'), THEMES[0]);
  assert.equal(themeById(DEFAULTS.theme).id, DEFAULTS.theme);
});

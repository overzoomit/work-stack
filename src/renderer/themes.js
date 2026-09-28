// Terminal profiles in the spirit of macOS Terminal.app, plus Work's own.
// ansi: black, red, green, yellow, blue, magenta, cyan, white, then the 8 bright variants.

const TERMINAL_APP_ANSI = [
  '#000000', '#c23621', '#25bc24', '#adad27', '#492ee1', '#d338d3', '#33bbc8', '#cbcccd',
  '#818383', '#fc391f', '#31e722', '#eaec23', '#5833ff', '#f935f8', '#14f0f0', '#e9ebeb',
];

export const THEMES = [
  {
    id: 'work', name: 'Work', dark: true,
    bg: 'rgba(12, 13, 16, 0.92)', fg: '#e6e7eb', cursor: '#0a84ff', selection: 'rgba(10, 132, 255, 0.35)',
    ansi: ['#1c1d22', '#ff453a', '#30d158', '#ffd60a', '#0a84ff', '#bf5af2', '#64d2ff', '#d1d3da',
      '#6b7080', '#ff6961', '#4cd964', '#ffe066', '#409cff', '#da8fff', '#8fe1ff', '#ffffff'],
  },
  {
    id: 'basic-dark', name: 'Basic scuro', dark: true,
    bg: '#1e1e1e', fg: '#ffffff', cursor: '#a0a0a0', selection: 'rgba(120, 140, 170, 0.45)', ansi: TERMINAL_APP_ANSI,
  },
  {
    id: 'basic-light', name: 'Basic chiaro', dark: false,
    bg: '#ffffff', fg: '#000000', cursor: '#7f7f7f', selection: 'rgba(164, 205, 255, 0.8)',
    ansi: ['#000000', '#990000', '#00a600', '#999900', '#0000b2', '#b200b2', '#00a6b2', '#bfbfbf',
      '#666666', '#e50000', '#00d900', '#b3b300', '#0000ff', '#e500e5', '#00c4cc', '#e5e5e5'],
  },
  {
    id: 'pro', name: 'Pro', dark: true,
    bg: 'rgba(0, 0, 0, 0.88)', fg: '#f2f2f2', cursor: '#4d4d4d', selection: 'rgba(65, 65, 65, 0.9)',
    ansi: ['#000000', '#990000', '#00a600', '#999900', '#2009db', '#b200b2', '#00a6b2', '#bfbfbf',
      '#666666', '#e50000', '#00d900', '#e5e500', '#0000ff', '#e500e5', '#00e5e5', '#e5e5e5'],
  },
  {
    id: 'homebrew', name: 'Homebrew', dark: true,
    bg: 'rgba(0, 0, 0, 0.92)', fg: '#28fe14', cursor: '#38fe27', selection: 'rgba(8, 50, 170, 0.8)',
    ansi: ['#000000', '#990000', '#00a600', '#999900', '#0000b2', '#b200b2', '#00a6b2', '#bfbfbf',
      '#666666', '#e50000', '#00d900', '#e5e500', '#0000ff', '#e500e5', '#00e5e5', '#e5e5e5'],
  },
  {
    id: 'ocean', name: 'Ocean', dark: true,
    bg: '#224fbc', fg: '#ffffff', cursor: '#7f7f7f', selection: 'rgba(33, 99, 255, 0.9)',
    ansi: ['#000000', '#990000', '#00a600', '#999900', '#0000b2', '#b200b2', '#00a6b2', '#bfbfbf',
      '#666666', '#e50000', '#00d900', '#e5e500', '#0000ff', '#e500e5', '#00e5e5', '#e5e5e5'],
  },
  {
    id: 'grass', name: 'Grass', dark: true,
    bg: '#13773d', fg: '#fff0a5', cursor: '#8c2800', selection: 'rgba(182, 73, 38, 0.8)',
    ansi: ['#000000', '#bb0000', '#00bb00', '#e7b000', '#0000a3', '#950062', '#00bbbb', '#bbbbbb',
      '#555555', '#bb0000', '#00bb00', '#e7b000', '#0000bb', '#ff55ff', '#55ffff', '#ffffff'],
  },
  {
    id: 'red-sands', name: 'Red Sands', dark: true,
    bg: '#7a251e', fg: '#d7c9a7', cursor: '#ffffff', selection: 'rgba(160, 160, 160, 0.6)',
    ansi: ['#000000', '#ff3f00', '#00bb00', '#e7b000', '#0072ff', '#bb00bb', '#00bbbb', '#bbbbbb',
      '#555555', '#bb0000', '#00bb00', '#e7b000', '#0072ae', '#ff55ff', '#55ffff', '#ffffff'],
  },
  {
    id: 'silver-aerogel', name: 'Silver Aerogel', dark: false,
    bg: '#929292', fg: '#000000', cursor: '#d9d9d9', selection: 'rgba(69, 69, 69, 0.5)',
    ansi: ['#000000', '#7e0000', '#007e00', '#7e7e00', '#00007e', '#7e007e', '#007e7e', '#cfcfcf',
      '#4d4d4d', '#b20000', '#00b200', '#b2b200', '#0000b2', '#b200b2', '#00b2b2', '#ffffff'],
  },
  {
    id: 'clear-dark', name: 'Clear Dark', dark: true, glass: true,
    bg: 'rgba(0, 0, 0, 0.45)', fg: '#ffffff', cursor: '#ffffff', selection: 'rgba(255, 255, 255, 0.25)',
    ansi: TERMINAL_APP_ANSI,
  },
];

// Like Terminal.app, the cursor doesn't blink by default (and a still cursor costs no repaints).
export const DEFAULTS = { theme: 'work', fontSize: 13, cursorStyle: 'bar', cursorBlink: false };
export const FONT_MIN = 9;
export const FONT_MAX = 28;

export const themeById = (id) => THEMES.find((t) => t.id === id) || THEMES[0];

// xterm.js theme object; the pane paints the background so translucency works.
export function xtermTheme(t) {
  const [black, red, green, yellow, blue, magenta, cyan, white,
    brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite] = t.ansi;
  return {
    background: '#00000000',
    foreground: t.fg,
    cursor: t.cursor,
    cursorAccent: t.dark ? '#000000' : '#ffffff',
    selectionBackground: t.selection,
    black, red, green, yellow, blue, magenta, cyan, white,
    brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite,
  };
}

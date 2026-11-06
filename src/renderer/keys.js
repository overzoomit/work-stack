// Global shortcuts. Inside a terminal pane the program running there owns
// its keys: F5 is "copy" in Midnight Commander and a view in htop.
export const inTerminal = (e) => !!e.target?.closest?.('.pane');

export const isRefreshKey = (e) => e.key === 'F5' && !e.ctrlKey && !e.metaKey && !inTerminal(e);

// Find in the focused terminal's buffer: Ctrl/⌘+F, or Ctrl/⌘+Shift+F when the
// focus is in a pane (elsewhere the latter is the project text search).
export const isTerminalSearchKey = (e) => !e.altKey && e.key.toLowerCase() === 'f' && (e.ctrlKey || e.metaKey);

// Settings…: Ctrl+, everywhere and ⌘, on macOS, as in the app menu.
export const isSettingsKey = (e) => e.key === ',' && !e.altKey && !e.shiftKey && (e.ctrlKey || e.metaKey);

// Command palette: Ctrl+K everywhere, ⌘K on macOS. It opens even from a
// terminal: the palette is universal, and closing it gives the pane its keys back.
export const isPaletteKey = (e) => !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey);

// Close the focused terminal: Ctrl/⌘+Shift+W, and on Mac plain ⌘W as in
// Terminal.app (Ctrl+W stays the shell's delete-word).
export const isCloseTerminalKey = (e, mac) => e.key.toLowerCase() === 'w' && !e.altKey
  && ((e.shiftKey && (e.ctrlKey || e.metaKey)) || (mac && e.metaKey && !e.shiftKey && !e.ctrlKey));

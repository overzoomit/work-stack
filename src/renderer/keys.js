// Global shortcuts. Inside a terminal pane the program running there owns
// its keys: F5 is "copy" in Midnight Commander and a view in htop.
export const inTerminal = (e) => !!e.target?.closest?.('.pane');

export const isRefreshKey = (e) => e.key === 'F5' && !e.ctrlKey && !e.metaKey && !inTerminal(e);

// Close the focused terminal: Ctrl/⌘+Shift+W, and on Mac plain ⌘W as in
// Terminal.app (Ctrl+W stays the shell's delete-word).
export const isCloseTerminalKey = (e, mac) => e.key.toLowerCase() === 'w' && !e.altKey
  && ((e.shiftKey && (e.ctrlKey || e.metaKey)) || (mac && e.metaKey && !e.shiftKey && !e.ctrlKey));

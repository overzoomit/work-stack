// Global shortcuts. Inside a terminal pane the program running there owns
// its keys: F5 is "copy" in Midnight Commander and a view in htop.
export const inTerminal = (e) => !!e.target?.closest?.('.pane');

export const isRefreshKey = (e) => e.key === 'F5' && !e.ctrlKey && !e.metaKey && !inTerminal(e);

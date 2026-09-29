// macOS application menu. Electron's default one has "Close Window" on ⌘W:
// Work has a single window, so ⌘W (the habit to close a terminal tab) would
// quit everything, terminals and running agents included. This one keeps the
// standard editing shortcuts (⌘C, ⌘V, ⌘A…) and ⌘Q, without a close item.
function macMenuTemplate() {
  return [
    { role: 'appMenu' },
    { role: 'editMenu' },
    { label: 'Finestra', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] },
  ];
}

module.exports = { macMenuTemplate };

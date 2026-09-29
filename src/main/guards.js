// The window only ever shows Work's own page. By default Chromium navigates
// to a file dropped on the window (or a link followed by mistake): the whole
// UI would be replaced and every terminal left without its pane. New windows
// are refused; web links open in the browser instead.
function lockNavigation(contents, openExternal) {
  contents.on('will-navigate', (e, url) => {
    if (url !== contents.getURL()) e.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) openExternal(url);
    return { action: 'deny' };
  });
}

module.exports = { lockNavigation };

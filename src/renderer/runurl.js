// Finds the local address a dev server prints ("Local: http://localhost:5173/").
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):\d+[^\s'")\]]*/;

// Wildcard binds (0.0.0.0, [::]) aren't browsable: open them as localhost.
// Sentence punctuation after the address and a trailing slash are dropped.
export function findLocalUrl(text) {
  const m = text.replace(ANSI, '').match(LOCAL_URL);
  if (!m) return null;
  return m[0].replace(/\/\/(0\.0\.0\.0|\[::\])/, '//localhost').replace(/[.,;:!?]+$/, '').replace(/\/$/, '');
}

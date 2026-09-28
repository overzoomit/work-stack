// Persistent app state (open projects, active project) in the user data dir.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const file = () => path.join(app.getPath('userData'), 'state.json');

// A file edited by hand may be valid JSON of the wrong shape: keep only what
// the app can use, so it still starts.
function load() {
  let s;
  try {
    s = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    s = null;
  }
  if (!s || typeof s !== 'object' || Array.isArray(s)) return { projects: [], active: null };
  const projects = Array.isArray(s.projects) ? s.projects.filter((p) => typeof p?.path === 'string') : [];
  return { ...s, projects, active: typeof s.active === 'string' ? s.active : null };
}

// Written to a temporary file and renamed over the old one: a write cut short
// (disk full, crash) never leaves a truncated state.json behind.
function save(state) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = `${file()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file());
}

module.exports = { load, save };

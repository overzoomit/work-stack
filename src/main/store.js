// Persistent app state (open projects, active project) in the user data dir.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const file = () => path.join(app.getPath('userData'), 'state.json');

function load() {
  try {
    const s = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return { projects: [], active: null, ...s };
  } catch {
    return { projects: [], active: null };
  }
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

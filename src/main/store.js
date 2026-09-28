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

function save(state) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(state, null, 2));
}

module.exports = { load, save };

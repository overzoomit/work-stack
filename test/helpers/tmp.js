// Temp folders for tests, removed when the test process exits: a full run
// used to leave about 120 of them in /tmp, and the suite runs often.
const fs = require('fs');
const os = require('os');
const path = require('path');

const made = [];

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

process.on('exit', () => {
  for (const dir of made) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // still in use: the OS cleans /tmp eventually
    }
  }
});

module.exports = { tempDir };

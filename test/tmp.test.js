// Temp folders made by tests are removed when the test process ends.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

test('le cartelle temporanee dei test vengono cancellate alla fine del processo (regressione: ne restavano ~120 per run)', () => {
  const helper = path.join(__dirname, 'helpers', 'tmp.js');
  const script = `const fs=require('fs');const {tempDir}=require(${JSON.stringify(helper)});const d=tempDir('work-tmptest-');fs.mkdirSync(d+'/sub');fs.writeFileSync(d+'/sub/f','x');console.log(d)`;
  const dir = execFileSync(process.execPath, ['-e', script]).toString().trim();
  assert.match(dir, /work-tmptest-/);
  assert.equal(fs.existsSync(dir), false);
});

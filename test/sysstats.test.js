// Status bar load: CPU busy share between two os.cpus() samples.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cpuBusy, sample } = require('../src/main/sysstats');

const core = (user, idle) => ({ times: { user, nice: 0, sys: 0, idle, irq: 0 } });

test('la CPU occupata è la quota non idle di tutti i core tra due letture', () => {
  // core 1: 30 busy of 100; core 2: 90 busy of 100 → 120 of 200
  assert.equal(cpuBusy([core(0, 0), core(10, 10)], [core(30, 70), core(100, 20)]), 0.6);
  assert.equal(cpuBusy([core(5, 5)], [core(5, 5)]), 0, 'no time passed');
  assert.equal(cpuBusy([], [core(5, 5)]), 0, 'a core that appeared has no baseline');
});

test('il consumo di Work somma i suoi processi, in byte e sulla quota di tutti i core', () => {
  const m = (kb, pct) => ({ memory: { workingSetSize: kb }, cpu: { percentCPUUsage: pct } });
  const s = sample([m(1000, 50), m(3000, 50)]);
  assert.equal(s.work.mem, 4000 * 1024);
  assert.equal(s.work.cpu, 1 / s.cores);
  assert.ok(s.memUsed > 0 && s.memUsed <= s.memTotal);
});

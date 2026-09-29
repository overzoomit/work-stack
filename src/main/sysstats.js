// Machine load for the status bar: system CPU and RAM, plus Work's own
// processes. CPU is measured between two calls, so the first one reads 0.
const os = require('os');

// Busy share of all cores between two os.cpus() samples, 0..1.
function cpuBusy(before, after) {
  let busy = 0;
  let total = 0;
  after.forEach((c, i) => {
    const b = before[i]?.times;
    if (!b) return;
    const t = c.times;
    const all = t.user + t.nice + t.sys + t.idle + t.irq - (b.user + b.nice + b.sys + b.idle + b.irq);
    busy += all - (t.idle - b.idle);
    total += all;
  });
  return total > 0 ? busy / total : 0;
}

let last = os.cpus();

// `metrics` is app.getAppMetrics(): Work's main, window and GPU processes
// (not the shells and agents running in its terminals).
// ponytail: on macOS os.freemem() counts only free pages, so RAM reads high;
// use vm_stat (free + inactive) when packaging for Mac.
function sample(metrics) {
  const now = os.cpus();
  const cpu = cpuBusy(last, now);
  last = now;
  return {
    cpu,
    memUsed: os.totalmem() - os.freemem(),
    memTotal: os.totalmem(),
    load: os.loadavg(),
    cores: now.length,
    work: {
      mem: metrics.reduce((s, p) => s + p.memory.workingSetSize * 1024, 0),
      // percentCPUUsage is per core: spread it over all of them, like `cpu`.
      cpu: metrics.reduce((s, p) => s + p.cpu.percentCPUUsage, 0) / 100 / now.length,
    },
  };
}

module.exports = { cpuBusy, sample };

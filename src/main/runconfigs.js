// Detects runnable commands in a project folder, like WebStorm's run
// configurations: npm scripts, Make targets, Cargo, Django, Compose, Go.
const fs = require('fs/promises');
const path = require('path');

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// The "packageManager" field (Corepack) wins, then the lockfile. Only known
// names are trusted: the value ends up in a shell command.
async function packageManager(dir, pkg) {
  const declared = String(pkg.packageManager || '').split('@')[0];
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(declared)) return declared;
  if (await exists(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await exists(path.join(dir, 'yarn.lock'))) return 'yarn';
  if (await exists(path.join(dir, 'bun.lockb')) || await exists(path.join(dir, 'bun.lock'))) return 'bun';
  return 'npm';
}

// Most useful scripts first, the rest alphabetically.
const PRIORITY = ['dev', 'start', 'serve', 'watch', 'build', 'test', 'lint'];
const rank = (name) => {
  const i = PRIORITY.indexOf(name);
  return i === -1 ? PRIORITY.length : i;
};

// Script names may contain spaces or shell characters ("e2e test"): quote
// anything that isn't a plain word so the shell passes it as one argument.
const shellArg = (s) => (/^[\w:.@/+=-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

async function detect(dir) {
  const configs = [];
  const add = (group, name, command) => configs.push({ id: `${group}:${name}`, group, name, command });

  try {
    const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
    const pm = await packageManager(dir, pkg);
    const names = Object.keys(pkg.scripts || {}).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    for (const name of names) add(pm, name, `${pm} run ${shellArg(name)}`);
  } catch {
    // no package.json
  }

  // The first of these make reads, in its own order.
  for (const file of ['GNUmakefile', 'makefile', 'Makefile']) {
    let make;
    try {
      make = await fs.readFile(path.join(dir, file), 'utf8');
    } catch {
      continue;
    }
    // "a b:" or "a::" is a rule (one line may name several targets);
    // "name := …", "::=" and ":::=" are assignments.
    const lines = make.matchAll(/^([a-zA-Z0-9][\w.-]*(?:[ \t]+[a-zA-Z0-9][\w.-]*)*)[ \t]*:(?!:{0,2}=)/gm);
    const targets = [...lines].flatMap((m) => m[1].split(/[ \t]+/));
    for (const t of [...new Set(targets)]) add('make', t, `make ${t}`);
    break;
  }

  if (await exists(path.join(dir, 'Cargo.toml'))) {
    add('cargo', 'run', 'cargo run');
    add('cargo', 'test', 'cargo test');
    add('cargo', 'build', 'cargo build');
  }
  if (await exists(path.join(dir, 'manage.py'))) add('django', 'runserver', 'python3 manage.py runserver'); // no bare "python" on Ubuntu 20.04 / recent macOS
  if (await exists(path.join(dir, 'go.mod'))) {
    add('go', 'run', 'go run .');
    add('go', 'test', 'go test ./...');
  }
  for (const f of ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml']) {
    if (await exists(path.join(dir, f))) {
      add('docker', 'compose up', 'docker compose up');
      break;
    }
  }
  return configs;
}

module.exports = { detect };

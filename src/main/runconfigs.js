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

async function packageManager(dir) {
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

async function detect(dir) {
  const configs = [];
  const add = (group, name, command) => configs.push({ id: `${group}:${name}`, group, name, command });

  try {
    const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
    const pm = await packageManager(dir);
    const names = Object.keys(pkg.scripts || {}).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    for (const name of names) add(pm, name, pm === 'npm' ? `npm run ${name}` : `${pm} run ${name}`);
  } catch {
    // no package.json
  }

  try {
    const make = await fs.readFile(path.join(dir, 'Makefile'), 'utf8');
    const targets = [...make.matchAll(/^([a-zA-Z0-9][\w.-]*)\s*:(?!=)/gm)].map((m) => m[1]);
    for (const t of [...new Set(targets)]) add('make', t, `make ${t}`);
  } catch {
    // no Makefile
  }

  if (await exists(path.join(dir, 'Cargo.toml'))) {
    add('cargo', 'run', 'cargo run');
    add('cargo', 'test', 'cargo test');
    add('cargo', 'build', 'cargo build');
  }
  if (await exists(path.join(dir, 'manage.py'))) add('django', 'runserver', 'python manage.py runserver');
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

// File-system operations for the Project tree. Every path must live inside
// one of the open projects, so the renderer can't touch anything else.
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { shell } = require('electron');

let roots = []; // real paths of the open projects

function setRoots(list) {
  roots = list.map((p) => {
    try {
      return fsSync.realpathSync(path.resolve(p));
    } catch {
      return path.resolve(p);
    }
  });
}

// Real path of `p` even if its last parts don't exist yet: resolve the
// deepest existing ancestor and append the rest.
async function realOf(p) {
  let cur = p;
  const tail = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(cur), ...tail.reverse());
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return p;
      tail.push(path.basename(cur));
      cur = up;
    }
  }
}

const inside = (real) => roots.some((r) => real === r || real.startsWith(r + path.sep));

// Checks a path against the open projects using real paths, so a symlink
// inside a project can't be used to reach files outside it.
//  follow: true  → the operation follows the link (read, list, open): check its target
//  follow: false → the operation acts on the entry itself (rename, move, trash): check its folder
async function guard(p, { follow }) {
  const abs = path.resolve(p);
  let real;
  if (follow) real = await realOf(abs);
  else real = path.join(await realOf(path.dirname(abs)), path.basename(abs));
  if (!inside(real)) throw new Error(`Percorso fuori dai progetti aperti: ${abs}`);
  return abs;
}

const isRoot = async (abs) => roots.includes(await realOf(abs));

// ".git" is refused too: the tree hides it, and a stray one breaks git there.
function checkName(name) {
  if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..' || name.toLowerCase() === '.git') {
    throw new Error(`Nome non valido: ${name}`);
  }
}

async function exists(p) {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

async function list(dir) {
  const abs = await guard(dir, { follow: true });
  const entries = await fs.readdir(abs, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (e.name === '.git') continue;
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) {
      try {
        isDir = (await fs.stat(path.join(abs, e.name))).isDirectory();
      } catch {
        // dangling link: show it as a file
      }
    }
    out.push({ name: e.name, path: path.join(abs, e.name), dir: isDir });
  }
  return out.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : collator.compare(a.name, b.name)));
}

const MAX_PREVIEW = 1024 * 1024;

async function read(file) {
  const abs = await guard(file, { follow: true });
  const st = await fs.stat(abs);
  if (st.isDirectory()) throw new Error(`${path.basename(abs)} è una cartella: aprila dal tab Project.`);
  if (st.size > MAX_PREVIEW) return { tooBig: true, size: st.size };
  const buf = await fs.readFile(abs);
  if (buf.subarray(0, 8000).includes(0)) return { binary: true, size: st.size };
  return { text: buf.toString('utf8'), size: st.size };
}

async function create(parent, name, dir) {
  checkName(name);
  const abs = await guard(path.join(parent, name), { follow: false });
  if (await exists(abs)) throw new Error(`Esiste già: ${name}`);
  if (dir) await fs.mkdir(abs);
  else await fs.writeFile(abs, '', { flag: 'wx' });
  return abs;
}

async function rename(from, name) {
  checkName(name);
  const src = await guard(from, { follow: false });
  if (await isRoot(src)) throw new Error('Non puoi rinominare la cartella del progetto.');
  const dest = await guard(path.join(path.dirname(src), name), { follow: false });
  if (dest === src) return dest;
  if (await exists(dest)) throw new Error(`Esiste già: ${name}`);
  await fs.rename(src, dest);
  return dest;
}

async function move(from, toDir) {
  const src = await guard(from, { follow: false });
  if (await isRoot(src)) throw new Error('Non puoi spostare la cartella del progetto.');
  const destDir = await guard(toDir, { follow: true });
  const dest = path.join(destDir, path.basename(src));
  if (dest === src) return dest;
  if (destDir === src || destDir.startsWith(src + path.sep)) throw new Error('Non puoi spostare una cartella dentro sé stessa.');
  if (await exists(dest)) throw new Error(`In ${path.basename(destDir)} esiste già ${path.basename(src)}`);
  await fs.rename(src, dest);
  return dest;
}

async function trash(p) {
  const abs = await guard(p, { follow: false });
  if (await isRoot(abs)) throw new Error('Non puoi eliminare la cartella del progetto.');
  await shell.trashItem(abs);
}

// Opening follows links (it may launch the target), revealing only shows the entry.
async function openPath(p) {
  return shell.openPath(await guard(p, { follow: true }));
}

async function reveal(p) {
  shell.showItemInFolder(await guard(p, { follow: false }));
}

module.exports = { setRoots, list, read, create, rename, move, trash, openPath, reveal };

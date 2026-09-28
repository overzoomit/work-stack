// File-system operations for the Project tree. Every path must live inside
// one of the open projects, so the renderer can't touch anything else.
const fs = require('fs/promises');
const path = require('path');
const { shell } = require('electron');

let roots = [];

function setRoots(list) {
  roots = list.map((p) => path.resolve(p));
}

function guard(p) {
  const abs = path.resolve(p);
  if (!roots.some((r) => abs === r || abs.startsWith(r + path.sep))) {
    throw new Error(`Percorso fuori dai progetti aperti: ${abs}`);
  }
  return abs;
}

function checkName(name) {
  if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
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
  const abs = guard(dir);
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
  const abs = guard(file);
  const st = await fs.stat(abs);
  if (st.size > MAX_PREVIEW) return { tooBig: true, size: st.size };
  const buf = await fs.readFile(abs);
  if (buf.subarray(0, 8000).includes(0)) return { binary: true, size: st.size };
  return { text: buf.toString('utf8'), size: st.size };
}

async function create(parent, name, dir) {
  checkName(name);
  const abs = guard(path.join(parent, name));
  if (await exists(abs)) throw new Error(`Esiste già: ${name}`);
  if (dir) await fs.mkdir(abs);
  else await fs.writeFile(abs, '', { flag: 'wx' });
  return abs;
}

async function rename(from, name) {
  checkName(name);
  const src = guard(from);
  const dest = guard(path.join(path.dirname(src), name));
  if (dest === src) return dest;
  if (await exists(dest)) throw new Error(`Esiste già: ${name}`);
  await fs.rename(src, dest);
  return dest;
}

async function move(from, toDir) {
  const src = guard(from);
  const destDir = guard(toDir);
  const dest = path.join(destDir, path.basename(src));
  if (dest === src) return dest;
  if (destDir === src || destDir.startsWith(src + path.sep)) throw new Error('Non puoi spostare una cartella dentro sé stessa.');
  if (await exists(dest)) throw new Error(`In ${path.basename(destDir)} esiste già ${path.basename(src)}`);
  await fs.rename(src, dest);
  return dest;
}

async function trash(p) {
  const abs = guard(p);
  if (roots.includes(abs)) throw new Error('Non puoi eliminare la cartella del progetto.');
  await shell.trashItem(abs);
}

module.exports = { setRoots, list, read, create, rename, move, trash };

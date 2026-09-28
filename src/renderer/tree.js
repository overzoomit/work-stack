// Project tree: browse and edit the project's folders (create, rename,
// move by drag & drop, trash), decorated with git status like WebStorm.
import { esc, basename, dirname, toast, toastError, ask, contextMenu } from './ui.js';

const { work } = window;

export class ProjectTree {
  constructor(project, hooks) {
    this.project = project;
    this.hooks = hooks; // { openTerminal(cwd), showDiff(rel), preview(path), refreshGit() }
    this.children = new Map(); // dir path -> entries
    this.expanded = new Set([project.path]);
    this.selected = null;
    this.box = null;
    this.vcs = new Map(); // abs path -> 'mod' | 'add' | 'new' | 'del'
    this.ignored = [];
  }

  // ── Data ──
  async load(dir) {
    try {
      this.children.set(dir, await work.fs.list(dir));
    } catch (e) {
      this.children.set(dir, []);
      if (dir === this.project.path) toastError(e);
    }
  }

  // Runs on every window focus: re-reads the open folders but only repaints
  // when something in them actually changed.
  async reload() {
    const dirs = [...this.expanded].filter((d) => d === this.project.path || this.children.has(d));
    const snapshot = () => JSON.stringify(dirs.map((d) => this.children.get(d)));
    const before = snapshot();
    await Promise.all(dirs.map((d) => this.load(d)));
    // Drop expanded folders that no longer exist.
    for (const d of this.expanded) {
      if (d !== this.project.path && !this.find(d)) this.expanded.delete(d);
    }
    if (snapshot() !== before) this.render();
  }

  find(p) {
    const list = this.children.get(dirname(p));
    return list?.find((e) => e.path === p);
  }

  setGitStatus(st, gitRoot) {
    this.vcs.clear();
    this.ignored = [];
    if (st && gitRoot) {
      const mark = (rel, kind) => {
        const abs = `${gitRoot}/${rel}`;
        const prev = this.vcs.get(abs);
        if (!prev || prev === 'mod') this.vcs.set(abs, kind);
        // Folders take the "modified" colour of anything changed inside them.
        for (let d = dirname(abs); d.length >= this.project.path.length && d !== '/'; d = dirname(d)) {
          if (!this.vcs.has(d)) this.vcs.set(d, 'mod');
        }
      };
      for (const f of st.staged) mark(f.file, f.code === 'A' ? 'add' : f.code === 'D' ? 'del' : 'mod');
      for (const f of st.unstaged) mark(f.file, f.code === 'U' ? 'new' : f.code === 'D' ? 'del' : f.code === 'X' ? 'conflict' : 'mod');
      this.ignored = st.ignored.map((rel) => `${gitRoot}/${rel}`);
    }
    this.render();
  }

  isIgnored(p) {
    return this.ignored.some((i) => p === i || p.startsWith(`${i}/`));
  }

  // ── Rendering ──
  // Every project's tree shares the same #tree element: the last one mounted
  // owns it, so background projects refreshing their git status don't paint.
  mount(box) {
    this.box = box;
    box.owner = this;
    box.tabIndex = 0;
    box.onpointerdown = (e) => this.onPointerDown(e);
    box.ondblclick = (e) => this.onDoubleClick(e);
    box.oncontextmenu = (e) => this.onContextMenu(e);
    box.onkeydown = (e) => this.onKey(e);
    box.ondragstart = (e) => this.onDragStart(e);
    box.ondragover = (e) => this.onDragOver(e);
    box.ondragleave = (e) => e.target.closest?.('.tn')?.classList.remove('drop');
    box.ondrop = (e) => this.onDrop(e);
    box.ondragend = () => this.clearDrop();
    if (!this.children.has(this.project.path)) this.load(this.project.path).then(() => this.render());
    else this.render();
  }

  rowHtml(e, depth) {
    const open = e.dir && this.expanded.has(e.path);
    const vcs = this.vcs.get(e.path);
    const cls = [
      'tn',
      e.dir ? 'dir' : 'file',
      open ? 'open' : '',
      vcs ? `vcs-${vcs}` : this.isIgnored(e.path) ? 'vcs-ignored' : '',
      e.path === this.selected ? 'selected' : '',
      e.name.startsWith('.') ? 'hidden-file' : '',
    ].join(' ');
    const icon = e.dir ? '<span class="ico folder"></span>' : `<span class="ico file" data-ext="${esc(ext(e.name))}"></span>`;
    return `<div class="${cls}" draggable="true" data-path="${esc(e.path)}" style="--depth:${depth}">
      <span class="chev">${e.dir ? '›' : ''}</span>${icon}<span class="tn-name">${esc(e.name)}</span></div>`;
  }

  walk(dir, depth) {
    const list = this.children.get(dir);
    if (!list) return `<div class="tn loading" style="--depth:${depth}"><span class="chev"></span>…</div>`;
    let html = '';
    for (const e of list) {
      html += this.rowHtml(e, depth);
      if (e.dir && this.expanded.has(e.path)) html += this.walk(e.path, depth + 1);
    }
    return html;
  }

  owns() {
    return !!this.box?.isConnected && this.box.owner === this;
  }

  render() {
    if (!this.owns()) return;
    const scroll = this.box.scrollTop;
    const root = { name: this.project.name, path: this.project.path, dir: true };
    this.box.innerHTML = this.rowHtml(root, 0).replace('class="tn dir', 'class="tn dir root') + this.walk(root.path, 1);
    this.box.scrollTop = scroll;
  }

  visibleRows() {
    return [...this.box.querySelectorAll('.tn[data-path]')];
  }

  // ── Actions ──
  async toggle(p) {
    if (this.expanded.has(p)) {
      if (p === this.project.path) return;
      this.expanded.delete(p);
    } else {
      this.expanded.add(p);
      if (!this.children.has(p)) {
        this.render(); // show the folder open immediately, children follow
        await this.load(p);
      }
    }
    this.render();
  }

  // Expand every folder down to `p`, then select and scroll to it.
  async reveal(p) {
    const root = this.project.path;
    if (!p.startsWith(`${root}/`)) return;
    const parts = p.slice(root.length + 1).split('/');
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      dir = `${dir}/${part}`;
      this.expanded.add(dir);
      if (!this.children.has(dir)) await this.load(dir);
    }
    this.render();
    this.select(p);
    this.box?.focus({ preventScroll: true });
  }

  select(p) {
    this.selected = p;
    if (!this.owns()) return;
    for (const el of this.box.querySelectorAll('.tn.selected')) el.classList.remove('selected');
    const el = this.box.querySelector(`.tn[data-path="${CSS.escape(p)}"]`);
    el?.classList.add('selected');
    el?.scrollIntoView({ block: 'nearest' });
  }

  entry(p) {
    if (p === this.project.path) return { name: this.project.name, path: p, dir: true };
    return this.find(p);
  }

  targetDir(p) {
    const e = this.entry(p);
    return e?.dir ? p : dirname(p);
  }

  async refreshDirs(...dirs) {
    await Promise.all([...new Set(dirs)].map((d) => this.load(d)));
    this.render();
    this.hooks.refreshGit();
  }

  async create(p, dir) {
    const parent = this.targetDir(p);
    const name = await ask({ text: dir ? 'Nome della nuova cartella' : 'Nome del nuovo file', placeholder: dir ? 'cartella' : 'file.ts', okLabel: 'Crea' });
    if (!name) return;
    try {
      const created = await work.fs.create(parent, name, dir);
      this.expanded.add(parent);
      await this.refreshDirs(parent);
      this.select(created);
    } catch (e) {
      toastError(e);
    }
  }

  async rename(p) {
    if (p === this.project.path) return;
    const name = basename(p);
    const dot = name.lastIndexOf('.');
    const next = await ask({ text: 'Rinomina', value: name, okLabel: 'Rinomina', select: [0, dot > 0 ? dot : name.length] });
    if (!next || next === name) return;
    try {
      const dest = await work.fs.rename(p, next);
      await this.refreshDirs(dirname(p), ...this.renameExpanded(p, dest));
      this.select(dest);
    } catch (e) {
      toastError(e);
    }
  }

  // Open folders follow a renamed or moved folder; returns their new paths,
  // whose contents must be loaded again.
  renameExpanded(from, to) {
    const moved = [];
    for (const d of [...this.expanded]) {
      if (d === from || d.startsWith(`${from}/`)) {
        this.expanded.delete(d);
        this.children.delete(d);
        moved.push(to + d.slice(from.length));
      }
    }
    for (const d of moved) this.expanded.add(d);
    return moved;
  }

  async move(p, toDir, { undo = true } = {}) {
    const from = dirname(p);
    if (from === toDir) return;
    try {
      const dest = await work.fs.move(p, toDir);
      const moved = this.renameExpanded(p, dest);
      this.expanded.add(toDir);
      await this.refreshDirs(from, toDir, ...moved);
      this.select(dest);
      if (undo) {
        toast(`${basename(p)} spostato in ${basename(toDir)}`, {
          action: { label: 'Annulla', run: () => this.move(dest, from, { undo: false }) },
        });
      }
    } catch (e) {
      toastError(e);
    }
  }

  async trash(p) {
    if (p === this.project.path) return;
    try {
      await work.fs.trash(p);
      this.forget(p);
      await this.refreshDirs(dirname(p));
      toast(`${basename(p)} spostato nel cestino`);
    } catch (e) {
      toastError(e);
    }
  }

  // Drops what the tree remembers about `p` and everything inside it: a folder
  // recreated later under the same name must not show the old open subfolders.
  forget(p) {
    const gone = (x) => x === p || x.startsWith(`${p}/`);
    for (const d of [...this.expanded]) if (gone(d)) this.expanded.delete(d);
    for (const d of [...this.children.keys()]) if (gone(d)) this.children.delete(d);
    if (this.selected && gone(this.selected)) this.selected = null;
  }

  open(p) {
    const e = this.entry(p);
    if (!e) return;
    if (e.dir) this.toggle(p);
    else this.hooks.preview(p);
  }

  rel(p) {
    return p === this.project.path ? '.' : p.slice(this.project.path.length + 1);
  }

  // ── Events ──
  onPointerDown(e) {
    if (e.button !== 0) return;
    const row = e.target.closest('.tn[data-path]');
    if (!row) return;
    const p = row.dataset.path;
    this.select(p);
    if (row.classList.contains('dir') && (e.target.closest('.chev') || !row.classList.contains('root'))) {
      // Single click on a folder expands it (feedback on press, not release).
      if (!e.target.closest('.chev') && e.detail > 1) return;
      this.toggle(p);
    }
  }

  onDoubleClick(e) {
    const row = e.target.closest('.tn.file[data-path]');
    if (row) this.hooks.preview(row.dataset.path);
  }

  onContextMenu(e) {
    e.preventDefault();
    const row = e.target.closest('.tn[data-path]');
    const p = row ? row.dataset.path : this.project.path;
    this.select(p);
    const ent = this.entry(p);
    const isRoot = p === this.project.path;
    const changed = this.vcs.has(p) && !ent?.dir;
    contextMenu(e.clientX, e.clientY, [
      { label: 'Nuovo file…', run: () => this.create(p, false) },
      { label: 'Nuova cartella…', run: () => this.create(p, true) },
      '-',
      ...(!ent?.dir ? [
        { label: 'Anteprima', hint: 'Invio', run: () => this.hooks.preview(p) },
        { label: 'Apri con app di sistema', run: () => work.fs.openPath(p) },
      ] : []),
      ...(changed ? [{ label: 'Mostra differenze', run: () => this.hooks.showDiff(p) }] : []),
      { label: 'Apri terminale qui', run: () => this.hooks.openTerminal(this.targetDir(p)) },
      { label: 'Mostra nel file manager', run: () => work.fs.reveal(p) },
      '-',
      { label: 'Copia percorso', run: () => work.app.copy(p) },
      { label: 'Copia percorso relativo', run: () => work.app.copy(this.rel(p)) },
      '-',
      { label: 'Rinomina…', hint: 'F2', disabled: isRoot, run: () => this.rename(p) },
      { label: 'Sposta nel cestino', hint: 'Canc', danger: true, disabled: isRoot, run: () => this.trash(p) },
    ]);
  }

  onKey(e) {
    if (!this.selected) return;
    const rows = this.visibleRows();
    const i = rows.findIndex((r) => r.dataset.path === this.selected);
    const row = rows[i];
    const p = this.selected;
    const isDir = row?.classList.contains('dir');
    const handled = {
      ArrowDown: () => rows[i + 1] && this.select(rows[i + 1].dataset.path),
      ArrowUp: () => rows[i - 1] && this.select(rows[i - 1].dataset.path),
      ArrowRight: () => isDir && !this.expanded.has(p) && this.toggle(p),
      ArrowLeft: () => {
        if (isDir && this.expanded.has(p) && p !== this.project.path) this.toggle(p);
        else if (p !== this.project.path) this.select(dirname(p));
      },
      Enter: () => this.open(p),
      // Like the context menu: the project folder itself can't be renamed or trashed.
      F2: () => p !== this.project.path && this.rename(p),
      Delete: () => p !== this.project.path && this.trash(p),
    }[e.key];
    if (handled) {
      e.preventDefault();
      handled();
    }
  }

  onDragStart(e) {
    const row = e.target.closest('.tn[data-path]');
    if (!row || row.classList.contains('root')) return e.preventDefault();
    this.dragging = row.dataset.path;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', this.dragging);
    row.classList.add('dragging');
  }

  dropDirFor(target) {
    const row = target.closest?.('.tn[data-path]');
    if (!row) return null;
    const p = row.dataset.path;
    return row.classList.contains('dir') ? p : dirname(p);
  }

  clearDrop() {
    this.box?.querySelectorAll('.drop, .dragging').forEach((el) => el.classList.remove('drop', 'dragging'));
  }

  onDragOver(e) {
    if (!this.dragging) return;
    const dir = this.dropDirFor(e.target);
    const src = this.dragging;
    const valid = dir && dir !== dirname(src) && dir !== src && !dir.startsWith(`${src}/`);
    this.box.querySelectorAll('.drop').forEach((el) => el.classList.remove('drop'));
    if (!valid) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    this.box.querySelector(`.tn[data-path="${CSS.escape(dir)}"]`)?.classList.add('drop');
  }

  onDrop(e) {
    e.preventDefault();
    const dir = this.dropDirFor(e.target);
    const src = this.dragging;
    this.dragging = null;
    this.clearDrop();
    if (dir && src) this.move(src, dir);
  }
}

function ext(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

// Commit graph: assigns each commit a lane, then draws lanes as SVG
// behind an HTML list of rows.

export const ROW_H = 26;
const LANE_W = 14;
const PAD = 12;
const COLORS = ['#0a84ff', '#30d158', '#bf5af2', '#ff9f0a', '#64d2ff', '#ff375f', '#ffd60a', '#5e5ce6'];

// Each row keeps the lane layout before and after its commit.
// Lanes hold the hash each column is waiting for (or null when free).
export function layout(commits) {
  const lanes = [];
  const rows = [];
  for (const c of commits) {
    const before = lanes.slice();
    let col = lanes.indexOf(c.hash);
    if (col === -1) {
      col = lanes.indexOf(null);
      if (col === -1) col = lanes.length;
    }
    // Other children waiting for the same commit converge here.
    for (let i = 0; i < lanes.length; i++) if (i !== col && lanes[i] === c.hash) lanes[i] = null;

    const [first, ...rest] = c.parents;
    lanes[col] = first ?? null;
    for (const p of rest) {
      if (lanes.includes(p)) continue;
      const free = lanes.indexOf(null);
      if (free === -1) lanes.push(p);
      else lanes[free] = p;
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    rows.push({ commit: c, col, before, after: lanes.slice() });
  }
  // Per-row text indent so a wide section of the graph doesn't push every row.
  for (const r of rows) r.indent = PAD * 2 + (Math.max(r.before.length, r.after.length, r.col + 1) - 1) * LANE_W;
  return { rows, width: Math.max(...rows.map((r) => r.indent)) };
}

const x = (col) => PAD + col * LANE_W;
const color = (col) => COLORS[col % COLORS.length];

export function renderSvg({ rows, width }) {
  const h = rows.length * ROW_H;
  let lines = '';
  const curve = (x1, y1, x2, y2, c) => {
    if (x1 === x2) return `<path d="M${x1} ${y1}V${y2}" stroke="${c}"/>`;
    const my = (y1 + y2) / 2;
    return `<path d="M${x1} ${y1}C${x1} ${my} ${x2} ${my} ${x2} ${y2}" stroke="${c}"/>`;
  };

  let nodes = '';
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const top = i * ROW_H;
    const mid = top + ROW_H / 2;
    const bottom = top + ROW_H;
    const { hash, parents, refs } = r.commit;

    // Incoming: lanes that were waiting for this commit join the node,
    // every other lane passes straight through.
    for (let j = 0; j < r.before.length; j++) {
      const w = r.before[j];
      if (!w) continue;
      if (w === hash) lines += curve(x(j), top, x(r.col), mid, color(j));
      else {
        const k = r.after.indexOf(w);
        if (k !== -1) lines += curve(x(j), top, x(k), bottom, color(k));
      }
    }
    // Outgoing: node to each parent's lane.
    for (const p of parents) {
      const k = r.after.indexOf(p);
      if (k !== -1) lines += curve(x(r.col), mid, x(k), bottom, color(k));
    }

    const cx = x(r.col);
    const head = refs.some((ref) => ref.startsWith('HEAD'));
    nodes += head
      ? `<circle cx="${cx}" cy="${mid}" r="5.5" fill="#0c0d10" stroke="${color(r.col)}" stroke-width="2.5"/>`
      : `<circle cx="${cx}" cy="${mid}" r="${parents.length > 1 ? 3 : 4}" fill="${color(r.col)}"/>`;
  }

  return `<svg width="${width}" height="${h}" fill="none" stroke-width="2" stroke-linecap="round">${lines}${nodes}</svg>`;
}

// Decorations come from `git log --decorate=full`, so local and remote
// branches are told apart by their namespace, not by guessing from a "/"
// (a local "feature/x" is still local).
const REF_KINDS = [
  ['HEAD -> refs/heads/', 'head'],
  ['tag: refs/tags/', 'tag'],
  ['refs/heads/', 'local'],
  ['refs/remotes/', 'remote'],
];

export function refBadges(refs) {
  const out = [];
  for (const ref of refs) {
    if (ref === 'HEAD') {
      out.push({ cls: 'head', label: 'HEAD' });
      continue;
    }
    const kind = REF_KINDS.find(([prefix]) => ref.startsWith(prefix));
    if (!kind) continue;
    const [prefix, cls] = kind;
    const label = ref.slice(prefix.length);
    if (cls === 'remote' && label.endsWith('/HEAD')) continue; // origin/HEAD duplicates the default branch
    out.push({ cls, label });
  }
  return out;
}

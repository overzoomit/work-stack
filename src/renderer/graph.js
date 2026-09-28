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
  const parts = [];
  const curve = (x1, y1, x2, y2, c) => {
    if (x1 === x2) return `<path d="M${x1} ${y1}V${y2}" stroke="${c}"/>`;
    const my = (y1 + y2) / 2;
    return `<path d="M${x1} ${y1}C${x1} ${my} ${x2} ${my} ${x2} ${y2}" stroke="${c}"/>`;
  };

  rows.forEach((r, i) => {
    const top = i * ROW_H;
    const mid = top + ROW_H / 2;
    const bottom = top + ROW_H;
    const hash = r.commit.hash;

    // Incoming: lanes that were waiting for this commit join the node,
    // every other lane passes straight through.
    r.before.forEach((h, j) => {
      if (!h) return;
      if (h === hash) parts.push(curve(x(j), top, x(r.col), mid, color(j)));
      else {
        const k = r.after.indexOf(h);
        if (k !== -1) parts.push(curve(x(j), top, x(k), bottom, color(k)));
      }
    });
    // Outgoing: node to each parent's lane.
    for (const p of r.commit.parents) {
      const k = r.after.indexOf(p);
      if (k !== -1) parts.push(curve(x(r.col), mid, x(k), bottom, color(k === r.col ? r.col : k)));
    }
  });

  const nodes = rows.map((r, i) => {
    const cy = i * ROW_H + ROW_H / 2;
    const merge = r.commit.parents.length > 1;
    const head = r.commit.refs.some((ref) => ref.startsWith('HEAD'));
    return head
      ? `<circle cx="${x(r.col)}" cy="${cy}" r="5.5" fill="#0c0d10" stroke="${color(r.col)}" stroke-width="2.5"/>`
      : `<circle cx="${x(r.col)}" cy="${cy}" r="${merge ? 3 : 4}" fill="${color(r.col)}"/>`;
  });

  return `<svg width="${width}" height="${h}" fill="none" stroke-width="2" stroke-linecap="round">${parts.join('')}${nodes.join('')}</svg>`;
}

// Decorations come from `git log --decorate=full`, so local and remote
// branches are told apart by their namespace, not by guessing from a "/"
// (a local "feature/x" is still local).
export function refBadges(refs) {
  const out = [];
  for (const ref of refs) {
    if (ref === 'HEAD') out.push({ cls: 'head', label: 'HEAD' });
    else if (ref.startsWith('HEAD -> refs/heads/')) out.push({ cls: 'head', label: ref.slice('HEAD -> refs/heads/'.length) });
    else if (ref.startsWith('tag: refs/tags/')) out.push({ cls: 'tag', label: ref.slice('tag: refs/tags/'.length) });
    else if (ref.startsWith('refs/heads/')) out.push({ cls: 'local', label: ref.slice('refs/heads/'.length) });
    else if (ref.startsWith('refs/remotes/') && !ref.endsWith('/HEAD')) out.push({ cls: 'remote', label: ref.slice('refs/remotes/'.length) });
  }
  return out;
}

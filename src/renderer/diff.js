// Turns a unified git diff (with full-file context) into aligned rows and
// renders them side-by-side (old | new) or unified, WebStorm style.
import { esc } from './escape.js';
import { insertChunked, resetChunks } from './chunks.js';

const CONTEXT = 4;

export function parseDiff(text) {
  const rows = [];
  const lines = text.split('\n');
  let i = 0;
  let created = false;
  let deleted = false;
  // Git reports a binary file, or a new / deleted one, in the header before any hunk.
  for (; i < lines.length && !lines[i].startsWith('@@'); i++) {
    if (/^Binary files .* differ$/.test(lines[i])) return { binary: true, rows: [] };
    if (lines[i].startsWith('new file mode')) created = true;
    if (lines[i].startsWith('deleted file mode')) deleted = true;
  }

  let ln = 0;
  let rn = 0;
  let dels = [];
  let adds = [];
  const flush = () => {
    if (!dels.length && !adds.length) return; // most lines are context: nothing pending
    for (const pair of align(dels, adds)) {
      const [l, r] = pair;
      rows.push({ type: l && r ? 'mod' : l ? 'del' : 'add', l, r, whole: !!pair.whole });
    }
    dels = [];
    adds = [];
  };

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('@@')) {
      flush();
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      const nl = Number(m[1]);
      const nr = Number(m[2]);
      // A gap between hunks means unchanged lines git didn't send.
      if (rows.length && nl - ln > 1) rows.push({ type: 'gap', count: nl - ln - 1 });
      ln = Math.max(0, nl - 1); // "-0,0": the side is empty (new or deleted file)
      rn = Math.max(0, nr - 1);
      continue;
    }
    const sign = line[0];
    const t = line.slice(1);
    if (sign === '-') dels.push({ n: ++ln, t });
    else if (sign === '+') adds.push({ n: ++rn, t });
    else if (sign === ' ') {
      flush();
      rows.push({ type: 'ctx', l: { n: ++ln, t }, r: { n: ++rn, t } });
    } else if (sign === '\\') {
      // "\ No newline at end of file": the line just read ends the file without one.
      const prev = lines[i - 1]?.[0];
      const last = prev === '-' ? dels.at(-1) : prev === '+' ? adds.at(-1) : null;
      if (last) last.noEol = true;
    }
    // the trailing empty line is skipped
  }
  flush();
  return { binary: false, rows, created, deleted };
}

// Words and single punctuation marks, whitespace dropped.
const tokens = (line) => line.match(/\w+|[^\w\s]/g) || [];

// Similarity of two lines (0..1) from their shared word tokens, counted with
// repeats. Both token lists are sorted, so a single merge pass finds them.
function similarity(ta, tb) {
  if (!ta.length && !tb.length) return 1;
  let common = 0;
  for (let i = 0, j = 0; i < ta.length && j < tb.length;) {
    if (ta[i] === tb[j]) {
      common++;
      i++;
      j++;
    } else if (ta[i] < tb[j]) i++;
    else j++;
  }
  return (2 * common) / (ta.length + tb.length);
}

// Pair removed and added lines of one change block, keeping order and only
// matching lines that actually resemble each other (like WebStorm).
// Unmatched lines stay as pure deletions / additions.
const MIN_SIM = 0.4;
function align(dels, adds) {
  const n = dels.length;
  const m = adds.length;
  if (!n || !m) return [...dels.map((l) => [l, null]), ...adds.map((r) => [null, r])];
  if (n * m > 4000) {
    // Huge block: plain positional pairing.
    return Array.from({ length: Math.max(n, m) }, (_, k) => [dels[k] || null, adds[k] || null]);
  }
  // Each line is tokenized and sorted once, then compared n × m times.
  const addTokens = adds.map((a) => tokens(a.t).sort());
  const delTokens = dels.map((d) => tokens(d.t).sort());
  if (n === 1 && m === 1) {
    // The common one-line edit ends up on one row either way (see the folding
    // below): with word highlights only when the two lines are alike.
    const row = [dels[0], adds[0]];
    row.whole = similarity(delTokens[0], addTokens[0]) < MIN_SIM;
    return [row];
  }
  const sim = delTokens.map((dt) => addTokens.map((at) => similarity(dt, at)));
  // score[i][j] = best total similarity using dels[i..] and adds[j..]
  const score = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const pair = sim[i][j] >= MIN_SIM ? sim[i][j] + score[i + 1][j + 1] : -1;
      score[i][j] = Math.max(pair, score[i + 1][j], score[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (sim[i][j] >= MIN_SIM && score[i][j] === sim[i][j] + score[i + 1][j + 1]) out.push([dels[i++], adds[j++]]);
    else if (score[i][j] === score[i + 1][j]) out.push([dels[i++], null]);
    else out.push([null, adds[j++]]);
  }
  while (i < n) out.push([dels[i++], null]);
  while (j < m) out.push([null, adds[j++]]);
  // A run of unmatched deletions followed by unmatched additions is a rewritten
  // block: show it side by side on the same rows, without word highlights.
  const folded = [];
  for (let k = 0; k < out.length;) {
    let d = k;
    while (d < out.length && out[d][0] && !out[d][1]) d++;
    let a = d;
    while (a < out.length && !out[a][0] && out[a][1]) a++;
    if (d > k && a > d) {
      const ls = out.slice(k, d).map((x) => x[0]);
      const rs = out.slice(d, a).map((x) => x[1]);
      for (let q = 0; q < Math.max(ls.length, rs.length); q++) {
        const row = [ls[q] || null, rs[q] || null];
        row.whole = true;
        folded.push(row);
      }
      k = a;
    } else {
      folded.push(out[k]);
      k++;
    }
  }
  return folded;
}

const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;

// Highlight the changed middle of a modified line pair. The common prefix and
// suffix never end inside a surrogate pair (emoji and other astral characters).
export function wordDiff(a, b) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  if (p > 0 && isHigh(a.charCodeAt(p - 1))) p--;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  if (s > 0 && isLow(a.charCodeAt(a.length - s))) s--;
  // Only spaces, tabs or line endings changed (CRLF → LF, re-indent): shown
  // as symbols, otherwise the highlight would wrap invisible characters.
  const ws = /^\s*$/.test(a.slice(p, a.length - s)) && /^\s*$/.test(b.slice(p, b.length - s));
  const mark = (x) => {
    const mid = x.slice(p, x.length - s);
    const hl = !mid ? '' : ws
      ? `<span class="w ws" title="Cambiano solo spazi o fine riga">${mid.replace(/\s/g, (c) => WS_GLYPHS[c] || '·')}</span>`
      : `<span class="w">${esc(mid)}</span>`;
    return esc(x.slice(0, p)) + hl + esc(x.slice(x.length - s));
  };
  return [mark(a), mark(b)];
}

const WS_GLYPHS = { '\r': '␍', '\t': '→', ' ': '·' };

// Which rows stay visible: every change plus CONTEXT lines around it.
function visibility(rows) {
  const keep = new Array(rows.length).fill(false);
  rows.forEach((r, i) => {
    if (r.type === 'ctx') return;
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(rows.length - 1, i + CONTEXT); k++) keep[k] = true;
  });
  return keep;
}

function gapHtml(count, from) {
  return `<div class="d-gap" data-from="${from}" data-count="${count}">
    <span>⋯</span><span>${count} ${count === 1 ? 'riga invariata' : 'righe invariate'}</span></div>`;
}

// Lines between two hunks that git didn't send (they can't be expanded).
const missingHtml = (count) =>
  `<div class="d-gap static"><span>⋯</span><span>${count} ${count === 1 ? 'riga non inclusa' : 'righe non incluse'}</span></div>`;

// Only the final newline changed: the side that has it shows ⏎, highlighted.
const EOL = '<span class="w ws" title="Cambia solo l\'a capo a fine file">⏎</span>';
function modPair(r) {
  if (r.whole) return [esc(r.l.t), esc(r.r.t)];
  const [a, b] = wordDiff(r.l.t, r.r.t);
  if (r.l.t !== r.r.t || !r.l.noEol === !r.r.noEol) return [a, b];
  return r.l.noEol ? [a, b + EOL] : [a + EOL, b];
}

function sideRow(r, idx) {
  if (r.type === 'gap') return missingHtml(r.count);
  let lt = r.l ? esc(r.l.t) : '';
  let rt = r.r ? esc(r.r.t) : '';
  if (r.type === 'mod') [lt, rt] = modPair(r);
  const change = r.type !== 'ctx' ? ' data-change' : '';
  return `<div class="d-row ${r.type}" data-i="${idx}"${change}>
    <span class="ln">${r.l?.n ?? ''}</span><span class="code l${r.l ? '' : ' blank'}">${lt || '&nbsp;'}</span>
    <span class="ln">${r.r?.n ?? ''}</span><span class="code r${r.r ? '' : ' blank'}">${rt || '&nbsp;'}</span></div>`;
}

function unifiedRows(r, idx) {
  if (r.type === 'gap') return missingHtml(r.count);
  const line = (cls, l, rr, sign, t) =>
    `<div class="u-row ${cls}" data-i="${idx}"${cls !== 'ctx' ? ' data-change' : ''}><span class="ln">${l ?? ''}</span><span class="ln">${rr ?? ''}</span><span class="sign">${sign}</span><span class="code">${t || '&nbsp;'}</span></div>`;
  if (r.type === 'ctx') return line('ctx', r.l.n, r.r.n, '', esc(r.l.t));
  if (r.type === 'mod') {
    const [a, b] = modPair(r);
    return line('del', r.l.n, null, '−', a) + line('add', null, r.r.n, '+', b);
  }
  if (r.type === 'del') return line('del', r.l.n, null, '−', esc(r.l.t));
  return line('add', null, r.r.n, '+', esc(r.r.t));
}

// Renders into `box`; returns a navigator for jumping between changes.
export function renderDiff(box, parsed, mode = 'side') {
  const { rows } = parsed;
  if (parsed.binary) {
    box.innerHTML = '<div class="d-empty">File binario: nessuna anteprima del contenuto.</div>';
    return { next() {}, prev() {}, count: 0 };
  }
  if (!rows.some((r) => r.type !== 'ctx' && r.type !== 'gap')) {
    let why = 'Nessuna differenza nel contenuto (solo rinomina o permessi).';
    if (parsed.created) why = 'File nuovo vuoto.';
    else if (parsed.deleted) why = 'File vuoto eliminato.';
    box.innerHTML = `<div class="d-empty">${why}</div>`;
    return { next() {}, prev() {}, count: 0 };
  }

  const keep = visibility(rows);
  const render = mode === 'side' ? sideRow : unifiedRows;
  const out = [];
  for (let i = 0; i < rows.length;) {
    if (keep[i] || rows[i].type === 'gap') {
      out.push(render(rows[i], i));
      i++;
      continue;
    }
    let j = i;
    while (j < rows.length && !keep[j] && rows[j].type !== 'gap') j++;
    out.push(gapHtml(j - i, i));
    i = j;
  }
  box.className = `diff ${mode}`;
  box.innerHTML = '';
  resetChunks(box);
  insertChunked(box, out, { className: 'd-chunk', place: (el) => box.append(el) });

  // Expand a collapsed run in place.
  box.onclick = (e) => {
    const gap = e.target.closest('.d-gap:not(.static)');
    if (!gap) return;
    const from = Number(gap.dataset.from);
    const count = Number(gap.dataset.count);
    const html = rows.slice(from, from + count).map((r, k) => render(r, from + k));
    insertChunked(box, html, { className: 'd-chunk', place: (el) => gap.replaceWith(el) });
  };

  // Change blocks = first row of each consecutive run of changed rows,
  // computed once from the data (rows may still be streaming into the DOM).
  const starts = changeStarts(rows);
  let cur = -1;
  const go = async (d) => {
    if (!starts.length) return;
    cur = (cur + d + starts.length) % starts.length;
    const el = box.querySelector(`[data-i="${starts[cur]}"]`);
    if (!el) return; // its block hasn't been inserted yet
    // Off-screen blocks have an estimated height until they are shown, so the
    // first jump can land a little off: re-center once the blocks around the
    // target have been laid out. The flash marks the row instead of a smooth scroll.
    let lastTop = null;
    for (let i = 0; i < 5; i++) {
      el.scrollIntoView({ block: 'center' });
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      const top = el.getBoundingClientRect().top;
      if (top === lastTop) break; // settled (or the scroll is at its end)
      lastTop = top;
    }
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  };
  return { next: () => go(1), prev: () => go(-1), count: starts.length };
}

const isChange = (r) => !!r && r.type !== 'ctx' && r.type !== 'gap';

export function changeStarts(rows) {
  const starts = [];
  for (let i = 0; i < rows.length; i++) if (isChange(rows[i]) && !isChange(rows[i - 1])) starts.push(i);
  return starts;
}

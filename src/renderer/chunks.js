// Inserts a long list of HTML rows in blocks: the first block paints right
// away, the rest follow between frames so a huge diff or file never blocks
// input, and off-screen blocks skip layout and paint (content-visibility).
const yieldToMain = () => (globalThis.scheduler?.yield ? globalThis.scheduler.yield() : new Promise((r) => setTimeout(r)));

// `owner._chunkToken` cancels a pending insertion when the owner re-renders.
// `place(el)` puts the first block in the document; the others follow it.
export async function insertChunked(owner, rows, { size = 400, className, place }) {
  const token = owner._chunkToken;
  let last = null;
  for (let i = 0; i < rows.length; i += size) {
    if (i) {
      await yieldToMain();
      if (owner._chunkToken !== token) return;
    }
    const block = document.createElement('div');
    block.className = className;
    block.innerHTML = rows.slice(i, i + size).join('');
    if (last) last.after(block);
    else place(block);
    last = block;
  }
}

export function resetChunks(owner) {
  owner._chunkToken = {};
}

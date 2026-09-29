// Copies the renderer's libraries next to it: Tauri only ships the files
// inside src/renderer, so ../../node_modules can't be reached from the page.
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'src/renderer/vendor');
const files = {
  'xterm.mjs': '@xterm/xterm/lib/xterm.mjs',
  'xterm.css': '@xterm/xterm/css/xterm.css',
  'addon-fit.mjs': '@xterm/addon-fit/lib/addon-fit.mjs',
  'addon-web-links.mjs': '@xterm/addon-web-links/lib/addon-web-links.mjs',
  'marked.esm.js': 'marked/lib/marked.esm.js',
  'purify.es.mjs': 'dompurify/dist/purify.es.mjs',
};

mkdirSync(out, { recursive: true });
for (const [name, src] of Object.entries(files)) cpSync(join(root, 'node_modules', src), join(out, name));

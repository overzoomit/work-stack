// Links in the Markdown preview: web and mail links open outside Work,
// relative ones open the file in the preview, anchors stay in the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers/renderer-env.mjs';

const { linkTarget } = await import('../src/renderer/preview.js');
const base = 'file:///home/u/app/docs/';

test('i link dell\'anteprima: web e mail fuori da Work, relativi nell\'anteprima, ancore nella pagina (regressione: mailto)', () => {
  assert.deepEqual(linkTarget('https://example.com/x', base), { external: 'https://example.com/x' });
  assert.deepEqual(linkTarget('mailto:anna@example.com', base), { external: 'mailto:anna@example.com' });
  assert.deepEqual(linkTarget('../README.md#install', base), { local: '/home/u/app/README.md' });
  assert.deepEqual(linkTarget('guida%20rapida.md', base), { local: '/home/u/app/docs/guida rapida.md' });
  assert.deepEqual(linkTarget('#sezione', base), { anchor: true });
});

// Sidebar accordion: pointer/keyboard toggle and reveal of hidden sections,
// on the shared fake renderer environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { El } from './helpers/renderer-env.mjs';

// document.querySelector is routed to a map the tests can pre-fill with the
// section elements app.js would find in index.html.
const nodes = new Map();
document.querySelector = (s) => nodes.get(s) ?? null;

const { initAccordion, bindAccordions, revealSection, setSection, toggleSection, sectionOpen } =
  await import('../src/renderer/accordion.js');

function makeSection(name, { open = false } = {}) {
  const sec = new El();
  sec.className = `acc${open ? ' open' : ''}`;
  sec.dataset.sec = name;
  const toggle = new El();
  toggle.dataset.sec = name;
  toggle.attrs = {};
  toggle.setAttribute = (k, v) => { toggle.attrs[k] = v; };
  sec.parts.set('.acc-toggle', toggle);
  nodes.set(`.acc[data-sec="${name}"]`, sec);
  return { sec, toggle };
}

test('accordion: click (anche Enter/Space su <button>) apre e chiude la sezione', () => {
  const { sec, toggle } = makeSection('project');
  bindAccordions([toggle]);
  assert.equal(typeof toggle.onclick, 'function', 'un <button> attiva onclick anche da tastiera');
  toggle.onclick();
  assert.ok(sec.classList.contains('open'));
  assert.equal(toggle.attrs['aria-expanded'], 'true');
  toggle.onclick();
  assert.equal(sec.classList.contains('open'), false);
  assert.equal(toggle.attrs['aria-expanded'], 'false');
});

test('accordion: aprire Graph o GitHub avvisa i pannelli che devono caricare', () => {
  const calls = [];
  initAccordion({ onExpand: (name, open) => calls.push([name, open]) });
  const { toggle } = makeSection('graph');
  bindAccordions([toggle]);
  toggle.onclick();
  toggle.onclick();
  assert.deepEqual(calls, [['graph', true], ['graph', false]]);
  assert.equal(sectionOpen('graph'), false);
});

test('accordion: revealSection riapre la sidebar nascosta prima della sezione Run', () => {
  const order = [];
  document.body.classList.add('sidebar-hidden');
  const { sec } = makeSection('run');
  initAccordion({
    openSidebar: () => {
      document.body.classList.remove('sidebar-hidden');
      order.push('sidebar');
    },
    onExpand: (name, open) => order.push(`${name}:${open}`),
  });
  assert.equal(revealSection('run'), true);
  assert.equal(document.body.classList.contains('sidebar-hidden'), false, 'sidebar tornata visibile');
  assert.ok(sec.classList.contains('open'), 'sezione Run aperta');
  assert.deepEqual(order, ['sidebar', 'run:true'], 'prima la sidebar, poi la sezione (dove si misura il console)');
});

test('accordion: una sezione inesistente non rompe il reveal', () => {
  let sidebar = 0;
  initAccordion({ openSidebar: () => sidebar++, onExpand: () => assert.fail('nessuna sezione: nessun hook') });
  assert.equal(setSection('missing', true), false);
  assert.equal(toggleSection('missing'), false);
  assert.equal(revealSection('missing'), false);
  assert.equal(sidebar, 1, 'la sidebar si riapre comunque');
});

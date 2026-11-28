import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const { AgentPortrait } = await import('../web/src/components/studio/AgentPortrait.tsx');
const portrait = (props) => createElement(AgentPortrait, props);
const render = (props) => renderToStaticMarkup(portrait(props));
const outline = (markup) => markup.match(/<clipPath[^>]*><path d="([^"]+)"/)?.[1];

test('renders a decorative square SVG at dock and stage sizes', () => {
  for (const size of [32, 112]) {
    const markup = render({ id: 'atlas', size });
    assert.match(markup, /^<svg\b[^>]*class="studio-portrait"/);
    assert.match(markup, new RegExp(`width="${size}" height="${size}"`));
    assert.match(markup, /viewBox="0 0 112 112"/);
    assert.match(markup, /aria-hidden="true"/);
    assert.match(markup, /focusable="false"/);
  }
});

test('selects stable, genuinely different pod outlines by agent id', () => {
  const ids = ['atlas', 'mira', 'lumen', 'aster', 'rowan', 'quinn', 'willow', 'orbit'];
  const outlines = ids.map((id) => outline(render({ id, size: 32 })));
  assert.ok(outlines.every(Boolean));
  assert.ok(new Set(outlines).size >= 3);
  assert.deepEqual(ids.map((id) => outline(render({ id, size: 112 }))), outlines);
});

test('multiple copies have local, unique SVG definitions', () => {
  const markup = renderToStaticMarkup(createElement('div', null,
    portrait({ id: 'atlas', size: 32 }), portrait({ id: 'atlas', size: 112 }),
  ));
  const svgs = markup.match(/<svg\b.*?<\/svg>/g);
  assert.equal(svgs.length, 2);
  const allIds = new Set();
  for (const svg of svgs) {
    const ids = [...svg.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    const refs = [...svg.matchAll(/url\(#([^)]+)\)/g)].map((match) => match[1]);
    assert.ok(ids.length >= 3 && refs.length >= 3);
    for (const id of ids) {
      assert.ok(!allIds.has(id), `duplicate definition: ${id}`);
      allIds.add(id);
    }
    assert.ok(refs.every((id) => ids.includes(id)), 'all references resolve within their own SVG');
    assert.doesNotMatch(svg, /<animate\b|<image\b|\bhref=/);
  }
});

test('caller-supplied states express different faces without changing identity', () => {
  const states = ['idle', 'working', 'waiting', 'offline'];
  const svgs = states.map((state) => render({ id: 'atlas', state }));
  assert.equal(render({ id: 'atlas' }), svgs[0], 'idle is the default');
  assert.ok(svgs.every((svg) => outline(svg) === outline(svgs[0])));
  const faces = svgs.map((svg) => svg.match(/<g[^>]*class="studio-portrait__face"[^>]*>(.*?)<\/g>/)?.[1]);
  assert.ok(faces.every(Boolean));
  assert.equal(new Set(faces).size, states.length);
});

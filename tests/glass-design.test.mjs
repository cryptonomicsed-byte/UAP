import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../web/src/styles/glass.css', import.meta.url), 'utf8');

test('glass.css is wired into main.tsx', () => {
  const main = readFileSync(new URL('../web/src/main.tsx', import.meta.url), 'utf8');
  assert.match(main, /glass\.css/);
});

test('every backdrop-filter rule has a reduced-transparency fallback in the file', () => {
  // Not a 1:1 per-rule pairing (several glass rules share one fallback block), but the file
  // must carry at least as many reduced-transparency blocks as distinct glass surfaces, and
  // every one of those surfaces' selector must appear inside some reduced-transparency block.
  const blurSelectors = [...css.matchAll(/^\.([a-zA-Z0-9_-]+)[^{]*\{[^}]*backdrop-filter:\s*blur/gm)].map((m) => m[1]);
  const fallbackBlocks = [...css.matchAll(/@media \(prefers-reduced-transparency: reduce\) \{([^]*?)\n\}\n/g)].map((m) => m[1]);
  const fallbackText = fallbackBlocks.join('\n');
  const uncovered = [...new Set(blurSelectors)].filter((sel) => !fallbackText.includes(`.${sel}`));
  assert.deepEqual(uncovered, [], `these glass selectors have no reduced-transparency fallback: ${uncovered.join(', ')}`);
});

test('every unconditional, time-driven animation in glass.css sits inside a reduced-motion gate', () => {
  // Scroll-linked animations (animation-timeline: scroll()/named) are driven 1:1 by the
  // user's own scroll position, not autoplaying motion — the real source (Codync's
  // sidebar-header.css) does not gate these behind prefers-reduced-motion either, only
  // behind prefers-reduced-transparency for the blur itself. Only a time-driven (duration-
  // based, autoplaying) animation needs the motion gate.
  function stripBraceBalanced(text, openMarker) {
    let out = '';
    let i = 0;
    while (i < text.length) {
      const idx = text.indexOf(openMarker, i);
      if (idx === -1) { out += text.slice(i); break; }
      out += text.slice(i, idx);
      let depth = 0;
      let j = idx;
      for (; j < text.length; j++) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') { depth--; if (depth === 0) { j++; break; } }
      }
      i = j;
    }
    return out;
  }
  const withoutGatedBlocks = stripBraceBalanced(css, '@media (prefers-reduced-motion: no-preference) ');
  const animationRules = [...withoutGatedBlocks.matchAll(/\{([^{}]*animation:\s*(?!none)[^{}]*)\}/g)];
  const timeDriven = animationRules.filter((m) => !/animation-timeline/.test(m[1]));
  assert.deepEqual(timeDriven.map((m) => m[1].trim()), [], 'a time-driven (non-scroll-linked) animation exists outside the reduced-motion gate');
});

test('scroll-timeline frost was removed after a real scroll bug — only the static baseline remains', () => {
  const codeOnly = css.replace(/\/\*[\s\S]*?\*\//g, ''); // strip comments; this checks real CSS, not prose about history
  assert.doesNotMatch(codeOnly, /animation-timeline/, 'scroll-timeline frost was removed on purpose; it must not come back silently');
  assert.doesNotMatch(codeOnly, /timeline-scope/);
  assert.match(codeOnly, /\.chat__header\s*\{[^}]*background:\s*var\(--glass-tint-strong\)/s);
});

test('glass surfaces are chrome-only: no transcript/bubble/board-card selector gets a blur', () => {
  const forbidden = ['.bubble', '.transcript__col', '.board-card', '.transcript ', '.chat__pill-name'];
  for (const sel of forbidden) {
    const re = new RegExp(`${sel.trim().replace('.', '\\.')}[^{]*\\{[^}]*backdrop-filter`);
    assert.doesNotMatch(css, re, `${sel} must stay an opaque content surface, not glass chrome`);
  }
});

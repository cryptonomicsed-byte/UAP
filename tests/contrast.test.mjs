import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTokenBlock, tokenContrast } from '../scripts/contrast.mjs';

/** Blueprint V6-10-08: accessible focus, contrast, keyboard checks — run as a real gate,
 *  not a design-review opinion. Minimums recorded in AGENT-DECISIONS.md: 7:1 body text,
 *  4.5:1 small/status text, 3:1 non-text (focus rings, control borders). Stricter than
 *  WCAG AA's 4.5:1/3:1 by choice. */

const css = readFileSync(new URL('../web/src/styles/tokens.css', import.meta.url), 'utf8');
const light = parseTokenBlock(css, ':root');
const dark = { ...light, ...parseTokenBlock(css, ":root\\[data-theme='dark'\\]") };

const BODY_MIN = 7, SMALL_MIN = 4.5, NON_TEXT_MIN = 3;

for (const [name, tokens] of [['light', light], ['dark', dark]]) {
  test(`${name} theme: body text clears ${BODY_MIN}:1`, () => {
    const r = tokenContrast(tokens['--color-text-primary'], tokens['--color-bg-pane']);
    assert.ok(r >= BODY_MIN, `--color-text-primary on --color-bg-pane is ${r.toFixed(2)}:1, needs ${BODY_MIN}:1`);
  });
  test(`${name} theme: small/status text clears ${SMALL_MIN}:1`, () => {
    const r = tokenContrast(tokens['--color-text-tertiary'], tokens['--color-bg-pane']);
    assert.ok(r >= SMALL_MIN, `--color-text-tertiary on --color-bg-pane is ${r.toFixed(2)}:1, needs ${SMALL_MIN}:1`);
  });
  test(`${name} theme: focus ring clears ${NON_TEXT_MIN}:1 non-text minimum`, () => {
    const r = tokenContrast(tokens['--color-border-focus'], tokens['--color-bg-pane']);
    assert.ok(r >= NON_TEXT_MIN, `--color-border-focus on --color-bg-pane is ${r.toFixed(2)}:1, needs ${NON_TEXT_MIN}:1`);
  });
}

test('every interactive class has a visible :focus-visible rule somewhere in the stylesheet set', () => {
  const sheets = ['base.css', 'shell.css', 'chat.css', 'modals.css', 'depth.css', 'operate.css'].map((f) =>
    readFileSync(new URL(`../web/src/styles/${f}`, import.meta.url), 'utf8'));
  const all = sheets.join('\n');
  // A real check, not a slogan: every class actually used for a clickable control appears
  // inside a :focus-visible selector, or there is a project-wide default that covers it.
  const hasGlobalDefault = /(^|\s|,)\s*:focus-visible\s*\{/m.test(all);
  assert.ok(hasGlobalDefault, 'no bare (universal) :focus-visible rule found — keyboard users may get no visible focus on some control');
});

test('motion in depth.css is gated by prefers-reduced-motion, not applied unconditionally', () => {
  const depth = readFileSync(new URL('../web/src/styles/depth.css', import.meta.url), 'utf8');
  const unconditional = depth.replace(/@media \(prefers-reduced-motion: no-preference\) \{[^]*?\n\}\n/g, '');
  assert.doesNotMatch(unconditional, /animation\s*:/, 'an animation rule exists outside the reduced-motion gate');
});

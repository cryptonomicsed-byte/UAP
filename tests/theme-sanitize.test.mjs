import test from 'node:test';
import assert from 'node:assert/strict';
import { themeValueLoads, sanitizeThemeTokens, renderThemeCss } from '../server/src/lib/theme-sanitize.ts';

test('any value that could load something is rejected', () => {
  assert.equal(themeValueLoads('url(https://evil.example/leak)'), true);
  assert.equal(themeValueLoads('@import "https://evil.example/x.css"'), true);
  assert.equal(themeValueLoads('#176c78'), false);
  assert.equal(themeValueLoads('14px'), false);
});

test('only custom properties on the allowed selector survive, nothing else', () => {
  const css = `
    :root { --color-primary: #ff00aa; color: red; }
    .evil { --color-primary: url(https://evil.example/x); }
    body { --color-primary: #000; }
  `;
  const tokens = sanitizeThemeTokens(css, ':root');
  assert.deepEqual(tokens, { '--color-primary': '#ff00aa' });
});

test('a url() token is dropped even inside the allowed selector', () => {
  const css = `:root { --bg-image: url(https://evil.example/x.png); --accent: teal; }`;
  const tokens = sanitizeThemeTokens(css, ':root');
  assert.deepEqual(tokens, { '--accent': 'teal' });
});

test('render round-trips sanitized tokens into a plain stylesheet', () => {
  const out = renderThemeCss({ '--accent': 'teal' }, '.sid-theme-abc');
  assert.match(out, /\.sid-theme-abc \{/);
  assert.match(out, /--accent: teal;/);
});

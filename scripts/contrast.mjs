/**
 * WCAG contrast math, pure functions, no DOM. Used by tests/contrast.test.mjs to hold
 * tokens.css to the numeric minimums this project already decided on (Nod/duskbot-derived
 * anti-slop rule, recorded in AGENT-DECISIONS.md): 7:1 body text, 4.5:1 small/status text,
 * 3:1 non-text contrast (focus rings, control borders). These are stricter than WCAG AA's
 * own 4.5:1/3:1 — a deliberate choice, not a typo.
 */

/** #RGB, #RRGGBB, or #RRGGBBAA (8-digit, alpha as the last byte). */
export function parseHex(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  const a = full.length >= 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1;
  return { r, g, b, a };
}

/** Composite a translucent foreground over an opaque background. */
export function flatten(fg, bg) {
  const a = fg.a;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
  };
}

function channel(c) {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function relativeLuminance({ r, g, b }) {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio, 1 (none) to 21 (max). Order of the two colors does not matter. */
export function contrastRatio(c1, c2) {
  const l1 = relativeLuminance(c1);
  const l2 = relativeLuminance(c2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Contrast of a token color (possibly translucent) against an opaque background token. */
export function tokenContrast(fgHex, bgHex) {
  const bg = parseHex(bgHex);
  const fg = flatten(parseHex(fgHex), bg);
  return contrastRatio(fg, bg);
}

/** Pull `--name: #hex;` pairs out of one CSS block (`:root { ... }` or `:root[data-theme='dark'] { ... }`). */
export function parseTokenBlock(css, blockSelector) {
  const re = new RegExp(`${blockSelector.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 's');
  const m = css.match(re);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(';')) {
    const mm = line.match(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})/);
    if (mm) out[`--${mm[1]}`] = mm[2];
  }
  return out;
}

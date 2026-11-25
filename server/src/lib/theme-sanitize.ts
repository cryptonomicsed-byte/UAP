/** Theme CSS sanitizer, adapted from OpenMausBot's approach: a theme can carry only values
 *  that cannot load anything from elsewhere. CSS can exfiltrate page state through
 *  attribute-selector + url() tricks, so every declaration value is checked, not just
 *  obvious url(...) calls. A blocked theme renders empty, never throws into the app shell. */

const LOADS = /url\s*\(|@import|-moz-binding|behavior\s*:/i;

/** True if a single CSS value could cause a network load (exfiltration vector). */
export function themeValueLoads(value: string): boolean {
  return LOADS.test(value);
}

export interface ThemeRule { selector: string; declarations: Record<string, string> }

/** Parse a small, trusted-shape subset: `selector { prop: value; ... }` blocks only.
 *  No @-rules, no nested selectors — those are exactly the vectors theme-css.ts guards
 *  against by walking the real CSSOM; here we simply never accept their syntax at all. */
export function parseThemeCss(css: string): ThemeRule[] {
  const rules: ThemeRule[] = [];
  const blockRe = /([^{}@]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(css))) {
    const selector = m[1].trim();
    if (!selector || selector.startsWith('@')) continue;
    const declarations: Record<string, string> = {};
    for (const decl of m[2].split(';')) {
      const [prop, ...rest] = decl.split(':');
      if (!prop || !rest.length) continue;
      const value = rest.join(':').trim();
      if (!value || themeValueLoads(value)) continue; // silently drop, never apply
      declarations[prop.trim()] = value;
    }
    if (Object.keys(declarations).length) rules.push({ selector, declarations });
  }
  return rules;
}

/** Only CSS custom properties on an allowed selector scope — a theme sets tokens, it does
 *  not restyle arbitrary elements. Scope is always ':root' or '.sid-theme-<id>'. */
export function sanitizeThemeTokens(css: string, allowedSelector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rule of parseThemeCss(css)) {
    if (rule.selector !== allowedSelector) continue;
    for (const [prop, value] of Object.entries(rule.declarations)) {
      if (!prop.startsWith('--')) continue; // custom properties only, never raw element styles
      out[prop] = value;
    }
  }
  return out;
}

/** Render sanitized tokens back to a stylesheet string the app can safely adopt. */
export function renderThemeCss(tokens: Record<string, string>, selector: string): string {
  const body = Object.entries(tokens).map(([k, v]) => `  ${k}: ${v};`).join('\n');
  return `${selector} {\n${body}\n}`;
}

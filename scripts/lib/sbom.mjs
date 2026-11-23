// CycloneDX SBOM construction + SPDX license-expression policy for the rights audit.
// Fail-closed by design: an unparseable/absent license is never treated as permitted.

const LICENSE_OPERATOR = /^(AND|OR|WITH)$/i;

const atomLicenses = value => {
  const inner = value?.licenses?.[0];
  return inner?.license?.id || inner?.expression || inner?.license?.name || '';
};

/**
 * Evaluate an SPDX license expression against an allowlist.
 * OR passes when any branch is allowed; AND requires all; WITH keeps the base
 * license's verdict (exceptions are recorded but not treated as new licenses).
 * Anything unparseable, missing, or a "SEE LICENSE IN ..." pointer returns false.
 */
export function isLicenseAllowed(expression, allow) {
  if (typeof expression !== 'string' || !expression.trim()) return false;
  const allowSet = new Set((allow || []).map(item => String(item).toLowerCase()));
  const tokens = expression.replace(/\(/g, ' ( ').replace(/\)/g, ' ) ').trim().split(/\s+/);
  let i = 0;
  const peek = () => tokens[i];
  const parseAtom = () => {
    if (peek() === '(') {
      i += 1;
      const value = parseOr();
      if (peek() !== ')') throw new Error('unbalanced parentheses');
      i += 1;
      return value;
    }
    const token = tokens[i];
    if (token === undefined) throw new Error('unexpected end of expression');
    if (LICENSE_OPERATOR.test(token)) throw new Error(`unexpected operator ${token}`);
    if (/^(SEE|LICENSE)$/i.test(token)) throw new Error('license pointer is not an SPDX id');
    i += 1;
    if (peek() && /^WITH$/i.test(peek())) {
      i += 1;
      if (!peek()) throw new Error('WITH without exception');
      i += 1;
    }
    return allowSet.has(token.toLowerCase());
  };
  const parseAnd = () => {
    let value = parseAtom();
    while (peek() && /^AND$/i.test(peek())) {
      i += 1;
      const right = parseAtom();
      value = value && right;
    }
    return value;
  };
  const parseOr = () => {
    let value = parseAnd();
    while (peek() && /^OR$/i.test(peek())) {
      i += 1;
      const right = parseAnd();
      value = value || right;
    }
    return value;
  };
  try {
    const verdict = parseOr();
    return i === tokens.length ? verdict : false;
  } catch {
    return false;
  }
}

const purlFor = (name, version) => `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;

const hashFromIntegrity = integrity => {
  const first = String(integrity || '').trim().split(/\s+/)[0];
  const match = /^(sha512|sha384|sha256|sha1)-(.+)$/.exec(first);
  if (!match) return [];
  const alg = { sha512: 'SHA-512', sha384: 'SHA-384', sha256: 'SHA-256', sha1: 'SHA-1' }[match[1]];
  return [{ alg, content: match[2] }];
};

const licenseBlock = value => {
  if (!value) return [];
  return /[\s()]/.test(value) ? [{ expression: value }] : [{ license: { id: value } }];
};

/**
 * Build a CycloneDX 1.5 SBOM from an npm lockfile (lockfileVersion 2/3).
 * Only external packages become components; workspace links and the root project
 * record are the subject, never third-party entries.
 */
export function buildSbom({ lock, subject, timestamp }) {
  const packages = lock?.packages || {};
  const rootEntry = packages[''] || {};
  const name = subject?.name || rootEntry.name || 'unknown';
  const version = subject?.version || rootEntry.version || '0.0.0';
  const components = [];
  for (const [key, entry] of Object.entries(packages)) {
    if (!key || !key.includes('node_modules/')) continue;
    if (!entry || entry.link || !entry.version) continue;
    const componentName = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    components.push({
      type: 'library',
      name: componentName,
      version: entry.version,
      'bom-ref': purlFor(componentName, entry.version),
      purl: purlFor(componentName, entry.version),
      scope: entry.dev || entry.devOptional ? 'optional' : 'required',
      licenses: licenseBlock(entry.license),
      ...(hashFromIntegrity(entry.integrity).length ? { hashes: hashFromIntegrity(entry.integrity) } : {}),
    });
  }
  components.sort((a, b) => a.purl.localeCompare(b.purl));
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${subject?.uuid || '00000000-0000-4000-8000-000000000000'}`,
    version: 1,
    metadata: {
      timestamp: timestamp || new Date().toISOString(),
      tools: [{ vendor: 'UAP', name: 'scripts/audit-rights.mjs', version: '1' }],
      component: { type: 'application', name, version, 'bom-ref': `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}` },
    },
    components,
  };
}

export function licenseSummary(components) {
  const counts = new Map();
  for (const component of components) {
    const license = atomLicenses(component) || 'unknown';
    counts.set(license, (counts.get(license) || 0) + 1);
  }
  return [...counts.entries()].map(([license, count]) => ({ license, count })).sort((a, b) => a.license.localeCompare(b.license));
}

/** Fail-closed license verdict for a component set. */
export function evaluateLicenses(components, policy) {
  const allow = policy?.allow || [];
  const violations = [];
  for (const component of components) {
    const license = atomLicenses(component);
    const name = component.name;
    const version = component.version;
    if (!license) {
      violations.push({ name, version, license: null, reason: 'missing-license' });
      continue;
    }
    if (!isLicenseAllowed(license, allow)) {
      violations.push({ name, version, license, reason: 'not-allowed' });
    }
  }
  return { ok: violations.length === 0, checked: components.length, violations, summary: licenseSummary(components) };
}

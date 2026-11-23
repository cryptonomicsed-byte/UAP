// Asset/font rights manifest enforcement: every bundled binary/media asset in the
// distribution must be registered with a hash, an origin and a license. Unregistered
// or tampered assets fail the audit; registry rows without files fail too, so the
// registry cannot rot into fiction.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const ASSET_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.svg', '.ico',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.wav', '.ogg', '.flac', '.mp4', '.webm', '.mov',
  '.glb', '.gltf', '.hdr', '.exr', '.pdf',
]);

const toPosix = value => value.split(path.sep).join('/');

/**
 * Recursively hash bundled asset files under the given roots.
 * @param {string[]} roots absolute or cwd-relative directories
 * @param {{root?: string, extensions?: Set<string>}} options root = base for relative paths
 */
export function scanAssets(roots, options = {}) {
  const base = options.root ? path.resolve(options.root) : process.cwd();
  const extensions = options.extensions || ASSET_EXTENSIONS;
  const found = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
        const bytes = readFileSync(full);
        found.push({
          path: toPosix(path.relative(base, full)),
          sha256: createHash('sha256').update(bytes).digest('hex'),
          bytes: statSync(full).size,
        });
      }
    }
  };
  for (const root of roots) {
    const resolved = path.isAbsolute(root) ? root : path.resolve(base, root);
    if (existsSync(resolved) && statSync(resolved).isDirectory()) walk(resolved);
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

/** Compare scanned assets against the checked-in rights registry. */
export function evaluateAssets(assets, registry) {
  const rows = (registry?.assets || []).filter(row => row && row.path);
  const byPath = new Map(rows.map(row => [toPosix(String(row.path)), row]));
  const seen = new Set();
  const violations = [];
  for (const asset of assets) {
    const row = byPath.get(asset.path);
    if (!row) {
      violations.push({ path: asset.path, reason: 'unregistered' });
      continue;
    }
    seen.add(asset.path);
    if (String(row.sha256 || '').toLowerCase() !== asset.sha256) {
      violations.push({ path: asset.path, reason: 'hash-mismatch' });
    } else if (!row.origin || !row.license) {
      violations.push({ path: asset.path, reason: 'incomplete-rights-row' });
    }
  }
  for (const row of rows) {
    if (!seen.has(toPosix(String(row.path)))) violations.push({ path: toPosix(String(row.path)), reason: 'registered-asset-missing' });
  }
  return { ok: violations.length === 0, checked: assets.length, registered: rows.length, violations };
}

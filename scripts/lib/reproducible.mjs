// Reproducible-build primitives: content manifests of a build output tree and a
// file-level comparator. A boolean "same/different" hides which artifact drifted, so
// the comparator names every difference.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const toPosix = value => value.split(path.sep).join('/');

/** Sorted [{ path, sha256, bytes }] for every regular file under dir (posix paths, relative). */
export function hashTree(dir) {
  const base = path.resolve(dir);
  if (!existsSync(base) || !statSync(base).isDirectory()) throw new Error(`output directory does not exist: ${dir}`);
  const entries = [];
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const bytes = readFileSync(full);
        entries.push({
          path: toPosix(path.relative(base, full)),
          sha256: createHash('sha256').update(bytes).digest('hex'),
          bytes: statSync(full).size,
        });
      }
    }
  };
  walk(base);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

/** File-level comparison of two manifests. */
export function compareTrees(first, second) {
  const a = new Map(first.map(entry => [entry.path, entry.sha256]));
  const b = new Map(second.map(entry => [entry.path, entry.sha256]));
  const changed = [];
  const onlyInFirst = [];
  const onlyInSecond = [];
  for (const [file, hash] of a) {
    if (!b.has(file)) onlyInFirst.push(file);
    else if (b.get(file) !== hash) changed.push(file);
  }
  for (const file of b.keys()) if (!a.has(file)) onlyInSecond.push(file);
  changed.sort();
  onlyInFirst.sort();
  onlyInSecond.sort();
  return {
    identical: changed.length === 0 && onlyInFirst.length === 0 && onlyInSecond.length === 0,
    changed,
    onlyInFirst,
    onlyInSecond,
    compared: a.size,
  };
}

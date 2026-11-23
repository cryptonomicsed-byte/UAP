// sid/0.1 historical-behaviour guard (V6-04-01). The neutral identity work must
// never move a legacy verdict: every vendored vector keeps its expected ok/error,
// and the fixtures keep the exact canonical hashes they shipped with.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  actingHashLegacy,
  canonicalSidJson,
  sidHashLegacy,
  verifySidLegacy,
} from '../server/src/identity/sid-legacy.ts';

const fixtures = path.join(import.meta.dirname, 'fixtures/sid-0.1');
const read = async name => JSON.parse(await readFile(path.join(fixtures, name), 'utf8'));

const minimal = await read('minimal-sid.json');
const full = await read('full-sid.json');
const { vectors } = await read('vectors.json');

/** Re-stamp exactly as the upstream conformance runner does: v1 defaults are
 *  filled only when absent, then acting_hash, then hash (which covers it). */
function restamp(cert) {
  const c = structuredClone(cert);
  if (c.version === 1) {
    if (c.previous_version === undefined) c.previous_version = null;
    if (c.previous_hash === undefined || c.previous_hash === null) c.previous_hash = 'none';
  }
  c.acting_hash = actingHashLegacy(c);
  c.hash = sidHashLegacy(c);
  return c;
}

test('the vendored fixtures still carry the hashes sid/0.1 shipped with', () => {
  for (const [name, cert] of [['minimal-sid.json', minimal], ['full-sid.json', full]]) {
    assert.equal(sidHashLegacy(cert), cert.hash, `${name}: canonical body no longer matches its hash`);
    assert.equal(actingHashLegacy(cert), cert.acting_hash, `${name}: acting keys no longer match acting_hash`);
    assert.deepEqual(verifySidLegacy(cert), { ok: true, errors: [] }, name);
  }
});

test('canonical JSON keeps the sid/0.1 byte contract (sorted keys, ASCII escapes, pruned empties)', () => {
  assert.equal(canonicalSidJson({ b: 1, a: 'é' }), '{"a":"\\u00e9","b":1}');
  assert.equal(canonicalSidJson({ a: [], b: {}, c: null }), '{"c":null}');
  assert.throws(() => canonicalSidJson({ a: Infinity }), /non-finite/);
});

for (const vector of vectors) {
  test(`sid/0.1 vector ${vector.name}: ${vector.ok ? 'verifies' : `refused (${vector.error})`}`, () => {
    const cert = structuredClone(vector.base === 'minimal' ? minimal : full);
    for (const op of vector.set) {
      const value = op[op.length - 1];
      const keys = op.slice(0, -1);
      let node = cert;
      for (const key of keys.slice(0, -1)) node = node[key];
      node[keys[keys.length - 1]] = value;
    }
    const result = verifySidLegacy(vector.restamp ? restamp(cert) : cert);
    assert.equal(result.ok, vector.ok, `${vector.name}: expected ok=${vector.ok}, got ${result.errors.join('; ')}`);
    if (vector.ok === false && vector.error) {
      assert.ok(
        result.errors.some(error => error.includes(vector.error)),
        `${vector.name}: expected "${vector.error}" in ${result.errors.join('; ')}`,
      );
    }
  });
}

test('a version-2 certificate links to the previous version it names', () => {
  const next = restamp({
    ...structuredClone(minimal),
    version: 2,
    previous_version: 1,
    previous_hash: minimal.hash,
    updated: '2026-11-12T00:00:00Z',
  });
  assert.equal(verifySidLegacy(next).ok, true);
  assert.equal(verifySidLegacy(next, minimal).ok, true);

  const wrongPredecessor = restamp({ ...next, previous_hash: 'f'.repeat(64) });
  const result = verifySidLegacy(wrongPredecessor, minimal);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.includes('previous_hash does not match')));
});

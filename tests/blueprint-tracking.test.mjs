import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = new URL('../', import.meta.url);

test('blueprint extraction captures all 1610 real checkbox items, zero dropped', () => {
  execSync('node scripts/extract-blueprint-checklist.mjs', { cwd: ROOT });
  const data = JSON.parse(readFileSync(new URL('docs/v6-blueprint/BLUEPRINT-ITEMS.json', ROOT), 'utf8'));
  const raw = readFileSync(new URL('docs/v6-blueprint/universal_agent_platform_master_blueprint_v6_sid_workforce1.md', ROOT), 'utf8');
  const rawCount = (raw.match(/^\s*-\s*\[([ x])\]/gm) || []).length;
  assert.equal(data.count, rawCount, 'extractor must capture every checkbox line, not a subset');
  assert.equal(new Set(data.items.map((i) => i.id)).size, data.count, 'every extracted id must be unique');
});

test('verify-tracking rejects an id that is not a real blueprint item', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'uap-tracking-'));
  const rootDir = new URL(ROOT).pathname;
  // Copy the two files verify-tracking.mjs reads, with a fabricated entry injected.
  const items = readFileSync(path.join(rootDir, 'docs/v6-blueprint/BLUEPRINT-ITEMS.json'), 'utf8');
  writeFileSync(path.join(dir, 'BLUEPRINT-ITEMS.json'), items);
  writeFileSync(path.join(dir, 'TRACKING.json'), JSON.stringify({ version: 1, evidence: { 'FAKE-DOES-NOT-EXIST': { commit: '0000000', file: 'nope.ts', note: 'fabricated' } } }));
  let failed = false;
  try {
    execFileSync('node', [path.join(rootDir, 'scripts/verify-tracking.mjs')], {
      cwd: dir,
      env: { ...process.env },
      stdio: 'pipe',
    });
  } catch { failed = true; }
  // verify-tracking.mjs resolves its paths relative to its own location (../docs/...), so this
  // asserts the real file instead — a fabricated entry added directly to the real TRACKING.json
  // must also fail, which is the actual guarantee that matters.
  const real = JSON.parse(readFileSync(path.join(rootDir, 'docs/v6-blueprint/TRACKING.json'), 'utf8'));
  const withFake = { ...real, evidence: { ...real.evidence, 'FAKE-DOES-NOT-EXIST': { commit: '0', file: 'nope.ts', note: 'x' } } };
  const backup = readFileSync(path.join(rootDir, 'docs/v6-blueprint/TRACKING.json'), 'utf8');
  writeFileSync(path.join(rootDir, 'docs/v6-blueprint/TRACKING.json'), JSON.stringify(withFake));
  let realFailed = false;
  try {
    execFileSync('node', [path.join(rootDir, 'scripts/verify-tracking.mjs')], { cwd: rootDir, stdio: 'pipe' });
  } catch { realFailed = true; }
  writeFileSync(path.join(rootDir, 'docs/v6-blueprint/TRACKING.json'), backup);
  rmSync(dir, { recursive: true, force: true });
  assert.ok(realFailed, 'verify-tracking.mjs must exit non-zero when an evidence entry cites a fabricated/missing file');
});

test('verify-tracking accepts the current real TRACKING.json (nothing fabricated is checked in)', () => {
  execSync('node scripts/verify-tracking.mjs', { cwd: ROOT });
});

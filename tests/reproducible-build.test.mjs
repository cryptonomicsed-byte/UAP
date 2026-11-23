// M0-02: a reproducible-build check that can actually fail.
// Spec for scripts/lib/reproducible.mjs + scripts/reproducible-build.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { compareTrees, hashTree } from '../scripts/lib/reproducible.mjs';

const root = path.resolve(import.meta.dirname, '..');
const cli = path.join(root, 'scripts', 'reproducible-build.mjs');
const scratch = () => mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'uap-repro-'));

const write = (file, content) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
};

test('hashTree: deterministic, sorted, path-relative manifest', () => {
  const dir = scratch();
  write(path.join(dir, 'dist', 'b.js'), 'bbb');
  write(path.join(dir, 'dist', 'nested', 'a.css'), 'aaa');
  const first = hashTree(path.join(dir, 'dist'));
  const second = hashTree(path.join(dir, 'dist'));
  assert.deepEqual(first, second);
  assert.deepEqual(first.map(entry => entry.path), ['b.js', 'nested/a.css']);
  assert.equal(first[0].bytes, 3);
  assert.match(first[0].sha256, /^[0-9a-f]{64}$/);
});

test('compareTrees: reports added, removed and changed files instead of a boolean', () => {
  const base = [{ path: 'a.js', sha256: 'aaa', bytes: 1 }, { path: 'gone.js', sha256: 'ggg', bytes: 1 }, { path: 'same.js', sha256: 'sss', bytes: 1 }];
  const next = [{ path: 'a.js', sha256: 'bbb', bytes: 2 }, { path: 'new.js', sha256: 'nnn', bytes: 1 }, { path: 'same.js', sha256: 'sss', bytes: 1 }];
  const verdict = compareTrees(base, next);
  assert.equal(verdict.identical, false);
  assert.deepEqual(verdict.changed, ['a.js']);
  assert.deepEqual(verdict.onlyInFirst, ['gone.js']);
  assert.deepEqual(verdict.onlyInSecond, ['new.js']);
  assert.equal(verdict.compared, 3);
  assert.equal(compareTrees(base, base).identical, true);
});

test('cli: a deterministic build passes and leaves both manifests as receipt', () => {
  const work = scratch();
  const build = 'node -e "const fs=require(\'fs\');fs.mkdirSync(\'dist\',{recursive:true});fs.writeFileSync(\'dist/app.js\',\'stable output\')"';
  const run = spawnSync('node', [cli, '--work', work, '--out', path.join(work, 'out'), '--build-cmd', build, '--output-dir', 'dist', '--no-source-copy'], { encoding: 'utf8' });
  assert.equal(run.status, 0, `expected reproducible pass: ${run.stdout}${run.stderr}`);
  const report = JSON.parse(readFileSync(path.join(work, 'out', 'reproducibility-report.json'), 'utf8'));
  assert.equal(report.identical, true);
  assert.equal(report.runs, 2);
  assert.deepEqual(report.manifests, ['manifest-run1.json', 'manifest-run2.json']);
  assert.ok(readFileSync(path.join(work, 'out', 'manifest-run1.json'), 'utf8').includes('dist/app.js'));
});

test('cli: a non-deterministic build fails with the differing path named', () => {
  const work = scratch();
  const build = 'node -e "const fs=require(\'fs\');fs.mkdirSync(\'dist\',{recursive:true});fs.writeFileSync(\'dist/app.js\',String(Date.now())+Math.random())"';
  const run = spawnSync('node', [cli, '--work', work, '--out', path.join(work, 'out'), '--build-cmd', build, '--output-dir', 'dist', '--no-source-copy'], { encoding: 'utf8' });
  assert.equal(run.status, 1, `expected reproducibility failure: ${run.stdout}${run.stderr}`);
  const report = JSON.parse(readFileSync(path.join(work, 'out', 'reproducibility-report.json'), 'utf8'));
  assert.equal(report.identical, false);
  assert.deepEqual(report.changed, ['dist/app.js']);
});

test('cli: a failing build command is a hard stop (exit 2), never a silent pass', () => {
  const work = scratch();
  const run = spawnSync('node', [cli, '--work', work, '--out', path.join(work, 'out'), '--build-cmd', 'node -e "process.exit(3)"', '--output-dir', 'dist', '--no-source-copy'], { encoding: 'utf8' });
  assert.equal(run.status, 2, `expected hard stop: ${run.stdout}${run.stderr}`);
  assert.match(`${run.stdout}${run.stderr}`, /build/i);
});

test('cli: missing output directory is a hard stop (exit 2), not an empty-tree pass', () => {
  const work = scratch();
  const run = spawnSync('node', [cli, '--work', work, '--out', path.join(work, 'out'), '--build-cmd', 'node -e "0"', '--output-dir', 'dist', '--no-source-copy'], { encoding: 'utf8' });
  assert.equal(run.status, 2, `expected hard stop: ${run.stdout}${run.stderr}`);
  assert.match(`${run.stdout}${run.stderr}`, /output/i);
});

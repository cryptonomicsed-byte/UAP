// V6-01-07 rights & supply-chain audit: SBOM, license policy, asset/font rights.
// These tests are the specification for scripts/lib/sbom.mjs, scripts/lib/asset-rights.mjs
// and the scripts/audit-rights.mjs CLI. Negative paths are tested first-class: an audit
// that cannot fail is not an audit.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildSbom, evaluateLicenses, isLicenseAllowed, licenseSummary } from '../scripts/lib/sbom.mjs';
import { evaluateAssets, scanAssets } from '../scripts/lib/asset-rights.mjs';

const root = path.resolve(import.meta.dirname, '..');
const cli = path.join(root, 'scripts', 'audit-rights.mjs');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const scratch = () => mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'uap-rights-'));

const ALLOW = ['MIT', 'Apache-2.0', 'ISC', 'BSD-3-Clause', 'MPL-2.0', 'Unlicense', '0BSD'];

const lockWith = packages => ({ lockfileVersion: 3, packages: { '': { name: 'fixture' }, ...packages } });
const lib = (name, version, license, extra = {}) => [`node_modules/${name}`, { version, license, resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`, integrity: 'sha512-AAAA', ...extra }];

test('sbom: every external lock entry becomes a component with purl, version and license', () => {
  const lock = lockWith(Object.fromEntries([
    lib('alpha', '1.0.0', 'MIT'),
    lib('@scope/beta', '2.3.4', 'Apache-2.0'),
  ]));
  const sbom = buildSbom({ lock, subject: { name: 'fixture', version: '0.0.1' }, timestamp: '2026-01-01T00:00:00.000Z' });
  assert.equal(sbom.bomFormat, 'CycloneDX');
  assert.equal(sbom.specVersion, '1.5');
  assert.equal(sbom.metadata.timestamp, '2026-01-01T00:00:00.000Z');
  assert.equal(sbom.components.length, 2);
  const alpha = sbom.components.find(c => c.name === 'alpha');
  assert.equal(alpha.purl, 'pkg:npm/alpha@1.0.0');
  assert.equal(alpha['bom-ref'], 'pkg:npm/alpha@1.0.0');
  assert.deepEqual(alpha.licenses, [{ license: { id: 'MIT' } }]);
  assert.deepEqual(alpha.hashes, [{ alg: 'SHA-512', content: 'AAAA' }]);
  const beta = sbom.components.find(c => c.name === '@scope/beta');
  assert.equal(beta.purl, 'pkg:npm/%40scope%2Fbeta@2.3.4');
});

test('sbom: workspace link entries are first-party, not third-party components', () => {
  const lock = lockWith(Object.fromEntries([
    lib('alpha', '1.0.0', 'MIT'),
    ['node_modules/@fixture/server', { link: true, resolved: 'server' }],
    ['server', {}],
  ]));
  const sbom = buildSbom({ lock, subject: { name: 'fixture', version: '0.0.1' }, timestamp: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(sbom.components.map(c => c.name), ['alpha']);
});

test('license expressions: OR/AND/WITH/parentheses resolve against the allowlist', () => {
  assert.equal(isLicenseAllowed('MIT', ALLOW), true);
  assert.equal(isLicenseAllowed('MIT OR GPL-3.0-only', ALLOW), true, 'a permitted alternative is enough for OR');
  assert.equal(isLicenseAllowed('MIT AND GPL-3.0-only', ALLOW), false, 'AND requires every operand');
  assert.equal(isLicenseAllowed('(MIT OR CC0-1.0)', ALLOW), true);
  assert.equal(isLicenseAllowed('Apache-2.0 WITH LLVM-exception', ALLOW), true);
  assert.equal(isLicenseAllowed('GPL-3.0-only', ALLOW), false);
  assert.equal(isLicenseAllowed('SEE LICENSE IN LICENSE.md', ALLOW), false, 'unknown must fail closed');
  assert.equal(isLicenseAllowed('', ALLOW), false, 'missing must fail closed');
});

test('evaluateLicenses: violations carry the offending component and reason', () => {
  const components = [
    { name: 'good', version: '1.0.0', licenses: [{ license: { id: 'MIT' } }] },
    { name: 'bad', version: '1.0.0', licenses: [{ license: { id: 'GPL-3.0-only' } }] },
    { name: 'mystery', version: '1.0.0', licenses: [] },
  ];
  const verdict = evaluateLicenses(components, { allow: ALLOW });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.violations.map(v => `${v.name}:${v.reason}`).sort(), ['bad:not-allowed', 'mystery:missing-license']);
  assert.equal(verdict.checked, 3);
  assert.deepEqual(licenseSummary(components), [{ license: 'GPL-3.0-only', count: 1 }, { license: 'MIT', count: 1 }, { license: 'unknown', count: 1 }]);
});

test('assets: unregistered asset files are violations, registered ones must match their recorded hash', () => {
  const dir = scratch();
  mkdirSync(path.join(dir, 'public'), { recursive: true });
  writeFileSync(path.join(dir, 'public', 'logo.svg'), '<svg>ok</svg>');
  writeFileSync(path.join(dir, 'public', 'stray.woff2'), 'bytes');
  const good = { path: 'public/logo.svg', sha256: sha256('<svg>ok</svg>'), origin: 'authored in-repo', license: 'MIT' };
  const assets = scanAssets([path.join(dir, 'public')], { root: dir });
  assert.deepEqual(assets.map(a => a.path).sort(), ['public/logo.svg', 'public/stray.woff2']);
  const verdict = evaluateAssets(assets, { assets: [good] });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.violations, [{ path: 'public/stray.woff2', reason: 'unregistered' }]);

  const tampered = evaluateAssets([{ ...assets[0], sha256: 'deadbeef' }], { assets: [good] });
  assert.deepEqual(tampered.violations, [{ path: 'public/logo.svg', reason: 'hash-mismatch' }]);

  const missing = evaluateAssets([], { assets: [good] });
  assert.deepEqual(missing.violations, [{ path: 'public/logo.svg', reason: 'registered-asset-missing' }]);
});

test('cli: a GPL dependency fails the audit with a non-zero exit and honest report', () => {
  const dir = scratch();
  writeFileSync(path.join(dir, 'lock.json'), JSON.stringify(lockWith(Object.fromEntries([lib('copyleft', '1.0.0', 'GPL-3.0-only')]))));
  writeFileSync(path.join(dir, 'policy.json'), JSON.stringify({ allow: ALLOW }));
  writeFileSync(path.join(dir, 'assets.json'), JSON.stringify({ assets: [] }));
  mkdirSync(path.join(dir, 'empty'));
  const run = spawnSync('node', [cli, '--lock', path.join(dir, 'lock.json'), '--out', path.join(dir, 'out'), '--policy', path.join(dir, 'policy.json'), '--asset-registry', path.join(dir, 'assets.json'), '--assets-root', path.join(dir, 'empty')], { encoding: 'utf8' });
  assert.equal(run.status, 1, `expected audit failure, got ${run.status}: ${run.stdout}${run.stderr}`);
  const report = JSON.parse(readFileSync(path.join(dir, 'out', 'rights-report.json'), 'utf8'));
  assert.equal(report.ok, false);
  assert.ok(report.licenses.violations.some(v => v.name === 'copyleft' && v.reason === 'not-allowed'));
});

test('cli: a clean lock passes and writes a CycloneDX SBOM plus asset manifest', () => {
  const dir = scratch();
  writeFileSync(path.join(dir, 'lock.json'), JSON.stringify(lockWith(Object.fromEntries([lib('alpha', '1.0.0', 'MIT')]))));
  writeFileSync(path.join(dir, 'policy.json'), JSON.stringify({ allow: ALLOW }));
  mkdirSync(path.join(dir, 'public'));
  writeFileSync(path.join(dir, 'public', 'mark.svg'), '<svg>m</svg>');
  writeFileSync(path.join(dir, 'assets.json'), JSON.stringify({ assets: [{ path: 'public/mark.svg', sha256: sha256('<svg>m</svg>'), origin: 'authored in-repo', license: 'MIT' }] }));
  const out = path.join(dir, 'out');
  const run = spawnSync('node', [cli, '--lock', path.join(dir, 'lock.json'), '--out', out, '--policy', path.join(dir, 'policy.json'), '--asset-registry', path.join(dir, 'assets.json'), '--assets-base', dir, '--assets-root', path.join(dir, 'public'), '--timestamp', '2026-01-01T00:00:00.000Z'], { encoding: 'utf8' });
  assert.equal(run.status, 0, `expected audit pass, got ${run.status}: ${run.stdout}${run.stderr}`);
  const sbom = JSON.parse(readFileSync(path.join(out, 'sbom.cdx.json'), 'utf8'));
  assert.equal(sbom.bomFormat, 'CycloneDX');
  assert.equal(sbom.metadata.timestamp, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(sbom.components.map(c => c.purl), ['pkg:npm/alpha@1.0.0']);
  const manifest = JSON.parse(readFileSync(path.join(out, 'asset-manifest.json'), 'utf8'));
  assert.deepEqual(manifest.assets.map(a => a.path), ['public/mark.svg']);
  assert.equal(JSON.parse(readFileSync(path.join(out, 'rights-report.json'), 'utf8')).ok, true);
});

test('cli: unreadable lock file fails closed (exit 2), never a silent pass', () => {
  const dir = scratch();
  writeFileSync(path.join(dir, 'lock.json'), '{ not json');
  const run = spawnSync('node', [cli, '--lock', path.join(dir, 'lock.json'), '--out', path.join(dir, 'out'), '--policy', path.join(dir, 'policy.json')], { encoding: 'utf8' });
  assert.equal(run.status, 2, `expected fail-closed exit 2: ${run.stdout}${run.stderr}`);
  assert.match(`${run.stdout}${run.stderr}`, /lock/i);
});

test('real repo: the shipped tree audits clean against the checked-in policy and registry', () => {
  const out = scratch();
  const run = spawnSync('node', [cli, '--out', out], { encoding: 'utf8', cwd: root });
  assert.equal(run.status, 0, `repository rights audit failed: ${run.stdout}${run.stderr}`);
  const sbom = JSON.parse(readFileSync(path.join(out, 'sbom.cdx.json'), 'utf8'));
  assert.ok(sbom.components.length > 200, `expected >200 third-party components, got ${sbom.components.length}`);
  assert.ok(sbom.components.every(c => c.purl && c.version && c.licenses.length > 0));
  assert.ok(sbom.components.every(c => !String(c.name).startsWith('@universal-agent-platform/')));
  const report = JSON.parse(readFileSync(path.join(out, 'rights-report.json'), 'utf8'));
  assert.equal(report.assets.checked >= 1, true, 'favicon must be registered');
  assert.deepEqual(report.assets.violations, []);
  assert.ok(existsSync(path.join(root, 'docs', 'rights', 'ASSET-RIGHTS.md')), 'human-readable rights doc must exist');
});

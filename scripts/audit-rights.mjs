// Rights & supply-chain audit (V6-01-07).
//
//   node scripts/audit-rights.mjs [--lock package-lock.json] [--out artifacts/rights]
//        [--policy docs/rights/LICENSE-POLICY.json]
//        [--asset-registry docs/rights/ASSET-RIGHTS.json]
//        [--assets-root web/public ...] [--timestamp ISO]
//
// Writes: sbom.cdx.json (CycloneDX 1.5), license-report.json, asset-manifest.json,
//         rights-report.json (aggregate verdict).
// Exit codes: 0 = audit clean, 1 = rights violations, 2 = audit could not run (fail closed).
// This is evidence generation, not legal clearance: docs/rights/ASSET-RIGHTS.md records
// that distinction.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { evaluateAssets, scanAssets } from './lib/asset-rights.mjs';
import { buildSbom, evaluateLicenses } from './lib/sbom.mjs';

const root = path.resolve(import.meta.dirname, '..');

const parseArgs = argv => {
  const options = {
    lock: path.join(root, 'package-lock.json'),
    out: path.join(root, 'artifacts', 'rights'),
    policy: path.join(root, 'docs', 'rights', 'LICENSE-POLICY.json'),
    registry: path.join(root, 'docs', 'rights', 'ASSET-RIGHTS.json'),
    assetBase: root,
    assetRoots: null,
    timestamp: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[i];
    };
    if (arg === '--lock') options.lock = path.resolve(next());
    else if (arg === '--out') options.out = path.resolve(next());
    else if (arg === '--policy') options.policy = path.resolve(next());
    else if (arg === '--asset-registry') options.registry = path.resolve(next());
    else if (arg === '--assets-base') options.assetBase = path.resolve(next());
    else if (arg === '--assets-root') {
      // The first explicit root replaces the default web roots; later ones append.
      options.assetRoots = options.assetRoots || [];
      options.assetRoots.push(path.resolve(next()));
    } else if (arg === '--timestamp') options.timestamp = next();
    else if (arg === '--no-assets') options.assetRoots = [];
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
};

const readJson = (file, label) => {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`cannot read ${label} at ${file}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} at ${file} is not valid JSON: ${error.message}`);
  }
};

const main = () => {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`rights-audit: ${error.message}`);
    return 2;
  }
  if (options.help) {
    console.log('usage: node scripts/audit-rights.mjs [--lock][--out][--policy][--asset-registry][--assets-root][--timestamp][--no-assets]');
    return 0;
  }

  let lock;
  let policy;
  let registry;
  const assetRoots = options.assetRoots ?? ['web/public', 'web/src/avatar'].map(rel => path.join(root, rel));
  try {
    lock = readJson(options.lock, 'lockfile');
    policy = readJson(options.policy, 'license policy');
    registry = assetRoots.length ? readJson(options.registry, 'asset registry') : { assets: [] };
  } catch (error) {
    console.error(`rights-audit: ${error.message}`);
    return 2;
  }
  if (!Array.isArray(policy.allow) || policy.allow.length === 0) {
    console.error(`rights-audit: license policy ${options.policy} has no allow list; refusing to pass by default`);
    return 2;
  }

  const sbom = buildSbom({ lock, timestamp: options.timestamp });
  const licenseVerdict = evaluateLicenses(sbom.components, policy);
  const assets = assetRoots.length ? scanAssets(assetRoots, { root: options.assetBase }) : [];
  const assetVerdict = evaluateAssets(assets, registry);
  const ok = licenseVerdict.ok && assetVerdict.ok;

  const rights = {
    generatedAt: sbom.metadata.timestamp,
    lock: path.relative(root, options.lock) || options.lock,
    lockSha256: createHash('sha256').update(readFileSync(options.lock)).digest('hex'),
    ok,
    licenses: {
      checked: licenseVerdict.checked,
      violations: licenseVerdict.violations,
      summary: licenseVerdict.summary,
      policy: policy.name || path.basename(options.policy),
    },
    assets: { checked: assetVerdict.checked, registered: assetVerdict.registered, violations: assetVerdict.violations },
  };

  mkdirSync(options.out, { recursive: true });
  writeFileSync(path.join(options.out, 'sbom.cdx.json'), `${JSON.stringify(sbom, null, 2)}\n`);
  writeFileSync(path.join(options.out, 'license-report.json'), `${JSON.stringify({ generatedAt: rights.generatedAt, ...licenseVerdict }, null, 2)}\n`);
  writeFileSync(path.join(options.out, 'asset-manifest.json'), `${JSON.stringify({ generatedAt: rights.generatedAt, assets }, null, 2)}\n`);
  writeFileSync(path.join(options.out, 'rights-report.json'), `${JSON.stringify(rights, null, 2)}\n`);

  const summary = `${licenseVerdict.checked} third-party components, ${assetVerdict.checked} bundled assets`;
  if (!ok) {
    console.error(`rights-audit: FAIL (${summary})`);
    for (const violation of licenseVerdict.violations) console.error(`  license  ${violation.name}@${violation.version}: ${violation.reason}${violation.license ? ` (${violation.license})` : ''}`);
    for (const violation of assetVerdict.violations) console.error(`  asset    ${violation.path}: ${violation.reason}`);
    console.error(`rights-audit: evidence written to ${path.relative(root, options.out) || options.out}`);
    return 1;
  }
  console.log(`rights-audit: PASS (${summary}); SBOM ${path.relative(root, path.join(options.out, 'sbom.cdx.json'))}`);
  return 0;
};

process.exitCode = main();

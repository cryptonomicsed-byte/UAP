// Reproducible-build check (V6-01-03 evidence).
//
//   node scripts/reproducible-build.mjs --build-cmd "npm run build" \
//        [--output-dir dist] [--runs 2] [--install-cmd "npm ci"] \
//        [--work DIR] [--out DIR] [--source <git-sha|HEAD>] [--no-source-copy]
//
// Builds the same tracked source N times in isolated directories and compares the
// output trees file by file. Exit 0 = byte-identical, 1 = divergence (paths named),
// 2 = the check could not run (build failed, output missing) — never a silent pass.
// Manifests and the report are written to --out as the receipt.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { compareTrees, hashTree } from './lib/reproducible.mjs';

const root = path.resolve(import.meta.dirname, '..');

const parseArgs = argv => {
  const options = {
    buildCmd: null,
    installCmd: null,
    outputDir: 'dist',
    runs: 2,
    work: null,
    out: null,
    source: 'HEAD',
    copySource: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[i];
    };
    if (arg === '--build-cmd') options.buildCmd = next();
    else if (arg === '--install-cmd') options.installCmd = next();
    else if (arg === '--output-dir') options.outputDir = next();
    else if (arg === '--runs') options.runs = Number(next());
    else if (arg === '--work') options.work = path.resolve(next());
    else if (arg === '--out') options.out = path.resolve(next());
    else if (arg === '--source') options.source = next();
    else if (arg === '--no-source-copy') options.copySource = false;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
};

const main = () => {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`reproducible-build: ${error.message}`);
    return 2;
  }
  if (options.help) {
    console.log('usage: node scripts/reproducible-build.mjs --build-cmd CMD [--output-dir DIR] [--runs N] [--install-cmd CMD] [--work DIR] [--out DIR] [--source REV] [--no-source-copy]');
    return 0;
  }
  if (!options.buildCmd) {
    console.error('reproducible-build: --build-cmd is required');
    return 2;
  }
  if (!Number.isInteger(options.runs) || options.runs < 2) {
    console.error('reproducible-build: --runs must be an integer >= 2');
    return 2;
  }

  const work = options.work || mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'uap-repro-'));
  const out = options.out || path.join(work, 'out');
  mkdirSync(out, { recursive: true });

  let sourceSha = null;
  if (options.copySource) {
    sourceSha = execFileSync('git', ['-C', root, 'rev-parse', options.source], { encoding: 'utf8' }).trim();
  }

  const manifests = [];
  for (let run = 1; run <= options.runs; run += 1) {
    const dir = path.join(work, `run${run}`);
    mkdirSync(dir, { recursive: true });
    if (options.copySource) {
      // git archive = exactly the tracked tree at that revision, no working-tree drift.
      const archive = execFileSync('git', ['-C', root, 'archive', '--format=tar', options.source], { maxBuffer: 512 * 1024 * 1024 });
      const untar = spawnSync('tar', ['-x', '-C', dir], { input: archive });
      if (untar.status !== 0) {
        console.error(`reproducible-build: source copy failed for run${run}: ${untar.stderr}`);
        return 2;
      }
    }
    for (const [label, cmd] of [['install', options.installCmd], ['build', options.buildCmd]]) {
      if (!cmd) continue;
      const result = spawnSync(cmd, { cwd: dir, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      if (result.status !== 0) {
        console.error(`reproducible-build: ${label} command failed in run${run} (exit ${result.status}): ${cmd}`);
        console.error((result.stdout || '').slice(-2000));
        console.error((result.stderr || '').slice(-2000));
        return 2;
      }
    }
    let manifest;
    try {
      const outputRoot = path.join(dir, options.outputDir);
      // Paths in the receipt are build-root relative ("dist/app.js") so a reader can
      // act on a reported difference without guessing which directory was hashed.
      const prefix = options.outputDir.replace(/\/+$/, '');
      manifest = hashTree(outputRoot).map(entry => ({ ...entry, path: prefix ? `${prefix}/${entry.path}` : entry.path }));
    } catch (error) {
      console.error(`reproducible-build: output check failed for run${run}: ${error.message}`);
      return 2;
    }
    if (manifest.length === 0) {
      console.error(`reproducible-build: output directory ${options.outputDir} is empty for run${run}; refusing to call that reproducible`);
      return 2;
    }
    manifests.push({ run, files: manifest });
    writeFileSync(path.join(out, `manifest-run${run}.json`), `${JSON.stringify({ run, outputDir: options.outputDir, files: manifest }, null, 1)}\n`);
  }

  let verdict = { identical: true, changed: [], onlyInFirst: [], onlyInSecond: [], compared: manifests[0].files.length };
  for (let i = 1; i < manifests.length; i += 1) {
    const pairwise = compareTrees(manifests[0].files, manifests[i].files);
    verdict = {
      identical: verdict.identical && pairwise.identical,
      changed: [...new Set([...verdict.changed, ...pairwise.changed])].sort(),
      onlyInFirst: [...new Set([...verdict.onlyInFirst, ...pairwise.onlyInFirst])].sort(),
      onlyInSecond: [...new Set([...verdict.onlyInSecond, ...pairwise.onlyInSecond])].sort(),
      compared: pairwise.compared,
    };
  }

  const report = {
    generatedAt: new Date().toISOString(),
    source: options.copySource ? { mode: 'git-archive', rev: options.source, sha: sourceSha } : { mode: 'in-place' },
    buildCmd: options.buildCmd,
    installCmd: options.installCmd,
    outputDir: options.outputDir,
    runs: options.runs,
    manifests: manifests.map((m, index) => `manifest-run${index + 1}.json`),
    files: manifests[0].files.length,
    ...verdict,
  };
  writeFileSync(path.join(out, 'reproducibility-report.json'), `${JSON.stringify(report, null, 1)}\n`);

  if (!report.identical) {
    console.error(`reproducible-build: FAIL — ${verdict.changed.length} changed, ${verdict.onlyInFirst.length} only-in-first, ${verdict.onlyInSecond.length} only-in-second of ${report.files} files`);
    for (const file of verdict.changed.slice(0, 20)) console.error(`  changed  ${file}`);
    for (const file of verdict.onlyInFirst.slice(0, 20)) console.error(`  missing  ${file}`);
    for (const file of verdict.onlyInSecond.slice(0, 20)) console.error(`  extra    ${file}`);
    console.error(`reproducible-build: evidence in ${out}`);
    return 1;
  }
  console.log(`reproducible-build: PASS — ${options.runs} builds of ${options.source}${sourceSha ? ` @ ${sourceSha.slice(0, 12)}` : ''} are byte-identical (${report.files} files in ${options.outputDir})`);
  return 0;
};

process.exitCode = main();

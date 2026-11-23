#!/usr/bin/env node
/**
 * B-21 / V6-02-07 operator entry point: scan a checked-out source before ingest.
 *
 *   node --import tsx scripts/source-quarantine.mjs <path...>
 *
 * Prints one JSON report (roots + redacted evidence) and exits 0 clean / 2 needs-review /
 * 3 quarantined / 1 usage or IO error, so a pipeline can gate on the exit code without
 * parsing prose. It never installs, executes or promotes anything it reads.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', 'target', '.next', 'coverage']);
const MAX_FILES = Number(process.env.UAP_SCAN_MAX_FILES ?? 20_000);
const MAX_FILE_BYTES = 1_048_576;

const roots = process.argv.slice(2);
if (roots.length === 0) {
  process.stderr.write('usage: source-quarantine <path...>\n');
  process.exit(1);
}

const { assessSourceBundle, assessmentDigest } = await import('../server/src/sources/quarantine.ts');

const files = [];
let truncated = false;

function walk(target) {
  const info = statSync(target);
  if (info.isDirectory()) {
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
      walk(path.join(target, entry.name));
    }
    return;
  }
  if (!info.isFile()) return;
  if (files.length >= MAX_FILES) {
    truncated = true;
    return;
  }
  if (info.size > MAX_FILE_BYTES) {
    files.push({ path: target, content: Buffer.alloc(0), declaredSize: info.size });
    return;
  }
  files.push({ path: target, content: readFileSync(target) });
}

try {
  for (const root of roots) walk(path.resolve(root));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

const assessment = assessSourceBundle(files);
const digest = assessmentDigest(assessment);
process.stdout.write(`${JSON.stringify({ roots: roots.map((root) => path.resolve(root)), truncated, digest, assessment }, null, 2)}\n`);
const outcome = assessment.decision === 'clean' ? 0 : assessment.decision === 'needs-review' ? 2 : 3;
// A capped walk did not see the whole source: it can never report "clean".
process.exit(truncated ? Math.max(outcome, 2) : outcome);

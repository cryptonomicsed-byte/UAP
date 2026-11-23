#!/usr/bin/env node
// Exports the reviewed built-in roster personas to docs/roles/<slug>.md.
//
// The roster module is the source of truth: `buildRoleTemplate` pins each persona's
// sha256, and the exported file is the same byte sequence a reviewer reads. Run this
// after editing `server/src/roles/builtin-roster.ts`; `npm test` fails when an export
// drifts from the roster, so a stale file cannot ship.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_ROSTER } from '../server/src/roles/builtin-roster.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

for (const role of BUILTIN_ROSTER) {
  const target = join(root, role.template.sourcePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, role.template.instructions, 'utf8');
}

console.log(`exported ${BUILTIN_ROSTER.length} personas to docs/roles/`);

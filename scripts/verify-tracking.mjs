#!/usr/bin/env node
/** Checks every TRACKING.json entry is real: the cited file exists, and the cited test
 *  string (if any) is actually present in it. Run before every merge-tracking.mjs; a failed
 *  entry means the checklist would lie. Exits non-zero on any failure. */
import { readFileSync, existsSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const tracking = JSON.parse(readFileSync(new URL('docs/v6-blueprint/TRACKING.json', root), 'utf8')).evidence;
const itemIds = new Set(JSON.parse(readFileSync(new URL('docs/v6-blueprint/BLUEPRINT-ITEMS.json', root), 'utf8')).items.map((i) => i.id));

let failures = 0;
for (const [id, ev] of Object.entries(tracking)) {
  if (!itemIds.has(id)) { console.error(`FAIL ${id}: not a real blueprint item id (re-run extract-blueprint-checklist.mjs?)`); failures++; continue; }
  if (!ev.commit || !ev.file || !ev.note) { console.error(`FAIL ${id}: missing commit/file/note`); failures++; continue; }
  const path = new URL(ev.file, root);
  if (!existsSync(path)) { console.error(`FAIL ${id}: file does not exist: ${ev.file}`); failures++; continue; }
  if (ev.test) {
    const content = readFileSync(path, 'utf8');
    if (!content.includes(ev.test)) { console.error(`FAIL ${id}: test string "${ev.test}" not found in ${ev.file}`); failures++; continue; }
  }
}
console.log(`${Object.keys(tracking).length} evidence entries checked, ${failures} failed.`);
if (failures > 0) process.exit(1);

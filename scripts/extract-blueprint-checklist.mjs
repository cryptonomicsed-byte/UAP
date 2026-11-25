#!/usr/bin/env node
/** Extracts every ID-prefixed checkbox item from the master blueprint into structured JSON.
 * Re-run any time the blueprint doc changes; this never writes checked/evidence state itself
 * — that lives in TRACKING.json and is merged in by merge-tracking.mjs, so re-extracting
 * never silently erases evidence someone recorded. */
import { readFileSync, writeFileSync } from 'node:fs';

const SRC = new URL('../docs/v6-blueprint/universal_agent_platform_master_blueprint_v6_sid_workforce1.md', import.meta.url);
const OUT = new URL('../docs/v6-blueprint/BLUEPRINT-ITEMS.json', import.meta.url);

const text = readFileSync(SRC, 'utf8');
const lines = text.split('\n');
let section = '(preamble)';
let anonInSection = 0;
const items = [];
for (const line of lines) {
  const h = line.match(/^#{2,3}\s+(.*)$/);
  if (h) { section = h[1].trim(); anonInSection = 0; continue; }
  const idMatch = line.match(/^\s*-\s*\[([ x])\]\s*\*\*([A-Z0-9-]+)\b[^*]*\*\*\s*(.*)$/);
  if (idMatch) {
    items.push({ id: idMatch[2], section, text: idMatch[3].trim(), shippedChecked: idMatch[1] === 'x' });
    continue;
  }
  // Items with no bold ID (plain prose bullets) still count toward the real total and still
  // need a stable, addressable id — derived from the section, not invented out of thin air.
  const plain = line.match(/^\s*-\s*\[([ x])\]\s*(?!\*\*)(.+\S)\s*$/);
  if (plain) {
    anonInSection += 1;
    const slug = section.replace(/^\d+(\.\d+)?\s*/, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).toUpperCase() || 'SEC';
    items.push({ id: `${slug}-${String(anonInSection).padStart(2, '0')}`, section, text: plain[2].trim(), shippedChecked: plain[1] === 'x' });
  }
}
writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), count: items.length, items }, null, 2) + '\n');
console.log(`Extracted ${items.length} items across ${new Set(items.map((i) => i.section)).size} sections -> ${OUT.pathname}`);

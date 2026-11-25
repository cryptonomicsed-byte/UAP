#!/usr/bin/env node
/**
 * Cross-reference every item OUTSIDE the original 245-item "7.x" blueprint section against
 * that original set for near-duplicate text. The blueprint document concatenates several
 * full redrafts (18.A-T, 19.*, 12.*, 13.*, 22.A-Z use new id prefixes for substantially the
 * same requirements as the original V6-01..V6-18/E2E set). This does NOT mark anything as
 * "done" — it only records a high-confidence textual match so the real distinct scope is
 * visible. A human (or a future careful pass) still decides whether a duplicate's own
 * evidence should be attached.
 *
 * Similarity: Jaccard on normalized significant words (lowercased, punctuation stripped,
 * stopwords removed, length >= 3). Threshold is deliberately high (0.55) to bias toward
 * missing real duplicates over inventing false ones — this is read by nothing automatic
 * that marks things complete, so a miss costs nothing and a false match would be worse.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const items = JSON.parse(readFileSync(new URL('docs/v6-blueprint/BLUEPRINT-ITEMS.json', root), 'utf8')).items;

const ORIGINAL_PREFIX = /^7\.\d+ /; // "7.1 A. Base and rights" .. "7.18 R. ..." and the acceptance-matrix subsections
const original = items.filter((it) => ORIGINAL_PREFIX.test(it.section) || /^(SID and lifecycle|Persona and skills|Design quality|Languages and contracts|Domain outputs|Platform Factory and SaaS)$/.test(it.section));
const candidates = items.filter((it) => !original.includes(it));

const STOP = new Set(['the','a','an','and','or','with','for','to','of','in','on','not','is','are','be','by','at','as','this','that','it','its','into','per','via','from','without','than','under','over']);
function words(text) {
  return new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w)));
}
function jaccard(a, b) {
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

const originalWords = original.map((it) => ({ it, w: words(it.text) }));
const THRESHOLD = 0.55;
const matches = [];
for (const c of candidates) {
  const cw = words(c.text);
  if (cw.size === 0) continue;
  let best = null;
  for (const o of originalWords) {
    const sim = jaccard(cw, o.w);
    if (!best || sim > best.sim) best = { id: o.it.id, sim, text: o.it.text };
  }
  if (best && best.sim >= THRESHOLD) matches.push({ id: c.id, section: c.section, text: c.text, duplicateOf: best.id, similarity: Math.round(best.sim * 100) / 100, duplicateText: best.text });
}

writeFileSync(new URL('docs/v6-blueprint/DEDUPE.json', root), JSON.stringify({
  generatedAt: new Date().toISOString(),
  threshold: THRESHOLD,
  originalSetSize: original.length,
  candidateSetSize: candidates.length,
  matchedCount: matches.length,
  matches,
}, null, 2) + '\n');

console.log(`${original.length} original items, ${candidates.length} candidates checked against them.`);
console.log(`${matches.length} matched at similarity >= ${THRESHOLD} (near-duplicates of the original 245-item set).`);
console.log(`${candidates.length - matches.length} candidates have NO strong match — likely genuinely new/distinct requirements.`);

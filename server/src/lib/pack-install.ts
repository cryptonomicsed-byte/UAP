/**
 * Real, per-bot engineering-pack installation. Makes good on the long-standing
 * "canPromote/installed is always false" limitation: when a SID template actually birth
 * an agent, its matching specialists' packs are now turned into real `skills` rows for that
 * bot, recorded in `pack_installs` so `installed` means something checkable, not a hardcoded
 * constant. NOASSERTION (no-SPDX) sources are refused outright, matching their own "no SPDX,
 * do not vendor" comments in engineering-pack.ts — this never silently relaxes that rule.
 *
 * What gets written is an ORIGINAL, authored skill instruction capturing the pack's stated
 * `use`, citing its real repo+sha+license — not vendored/copied source code. Same "adapt the
 * pattern, not the code" approach used everywhere else this session.
 */
import type Database from 'better-sqlite3';
import { newId } from './ids.js';
import { ENGINEERING_PACK, SPECIALISTS, type PackSource } from './engineering-pack.js';

export function ensurePackInstallSchema(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS pack_installs (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    repo TEXT NOT NULL,
    sha TEXT NOT NULL,
    specialist_id TEXT NOT NULL,
    skill_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS pack_installs_bot ON pack_installs(bot_id);`);
}

function skillBody(source: PackSource, specialistTitle: string): string {
  return [
    `As the ${specialistTitle} on this team, apply this when the task touches ${source.use}.`,
    '',
    `Guidance (adapted from the real pattern in ${source.repo}@${source.sha.slice(0, 12)}, ${source.license}; no source code was copied, only its stated approach):`,
    `${source.use}.`,
    '',
    'If the task is outside this area, defer to the right specialist instead of guessing.',
  ].join('\n');
}

export interface PackInstallResult {
  installedSkillIds: string[];
  skippedRefused: { repo: string; reason: string }[];
  alreadyInstalled: string[];
}

/** Install every real (non-NOASSERTION), not-yet-installed pack for the given specialist ids,
 *  as real skill rows on botId. Idempotent: re-running for an already-installed repo is a no-op. */
export function installPacksForSpecialists(db: Database.Database, botId: string, specialistIds: string[]): PackInstallResult {
  ensurePackInstallSchema(db);
  const result: PackInstallResult = { installedSkillIds: [], skippedRefused: [], alreadyInstalled: [] };
  const wantedRepos = new Set(
    SPECIALISTS.filter((s) => specialistIds.includes(s.id)).flatMap((s) => s.sources),
  );
  const already = new Set(
    (db.prepare('SELECT repo FROM pack_installs WHERE bot_id=?').all(botId) as { repo: string }[]).map((r) => r.repo),
  );
  const now = Date.now();
  for (const repo of wantedRepos) {
    if (already.has(repo)) { result.alreadyInstalled.push(repo); continue; }
    const source = ENGINEERING_PACK.find((p) => p.repo === repo);
    if (!source) continue;
    if (source.license === 'NOASSERTION') {
      result.skippedRefused.push({ repo, reason: 'no SPDX license on the source repo — refused, not vendored' });
      continue;
    }
    const specialist = SPECIALISTS.find((s) => s.sources.includes(repo));
    const skillId = newId('skl');
    const name = `${specialist?.title ?? 'Specialist'} pack: ${repo.split('/')[1]}`;
    db.prepare('INSERT INTO skills(id,bot_id,name,body,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(skillId, botId, name.slice(0, 120), skillBody(source, specialist?.title ?? 'specialist').slice(0, 20_000), `Installed from ${repo} (${source.license})`, now, now);
    db.prepare('INSERT INTO pack_installs(id,bot_id,repo,sha,specialist_id,skill_id,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(newId('pki'), botId, repo, source.sha, specialist?.id ?? '', skillId, now);
    result.installedSkillIds.push(skillId);
  }
  return result;
}

export function installedPacksFor(db: Database.Database, botId: string) {
  ensurePackInstallSchema(db);
  return db.prepare('SELECT repo, sha, specialist_id, skill_id, created_at FROM pack_installs WHERE bot_id=? ORDER BY created_at').all(botId) as
    { repo: string; sha: string; specialist_id: string; skill_id: string; created_at: number }[];
}

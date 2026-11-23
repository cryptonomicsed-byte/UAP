/**
 * Derived memory index (V6-04-10).
 *
 * Memory lives in the agent's Hermes home as `MEMORY.md` / `USER.md`; this table is a
 * projection over those entries so they can be searched without re-reading files. Because it
 * is *derived*, erasure must reach it: deleting a memory drops its terms, and a privacy
 * deletion leaves a content-hash tombstone so a later re-index of the same bytes is refused.
 * The index never becomes the source of truth — `listMemories` is.
 */
import { db, now } from '../db.js';
import { sha256 } from '../lib/ids.js';
import type { Memory } from '../types.js';

const MAX_TERM = 64;
const terms = (text: string): string[] => [...new Set(
  (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map((term) => term.slice(0, MAX_TERM)),
)];

/** Content is tombstoned per bot: identical bytes re-offered for the same agent stay erased. */
export function rememberTombstoneHash(
  botId: string,
  contentHash: string,
  meta: { requestId: string; sourceRef?: string },
): void {
  db.prepare(`INSERT INTO privacy_tombstones(bot_id,content_hash,request_id,source_ref,created_at)
    VALUES (?,?,?,?,?) ON CONFLICT(bot_id,content_hash) DO NOTHING`)
    .run(botId, contentHash, meta.requestId, meta.sourceRef ?? null, now());
}

export function rememberTombstone(botId: string, content: string, meta: { requestId: string; source?: string }): void {
  rememberTombstoneHash(botId, sha256(content), { requestId: meta.requestId, sourceRef: meta.source });
}

export function isTombstoned(botId: string, contentHash: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM privacy_tombstones WHERE bot_id=? AND content_hash=?').get(botId, contentHash));
}

function dropTerms(memoryId: string): void {
  db.prepare('DELETE FROM memory_index WHERE memory_id=?').run(memoryId);
}

export function removeMemoryFromIndex(memoryId: string): void {
  db.transaction(() => {
    dropTerms(memoryId);
    db.prepare('DELETE FROM memory_index_sources WHERE memory_id=?').run(memoryId);
  })();
}

/**
 * Reconcile the index with the current memory list: add new entries, refresh edited ones,
 * drop entries that no longer exist, and refuse tombstoned content. Idempotent.
 */
export function syncMemoryIndex(botId: string, memories: readonly Memory[]): void {
  const current = new Map(memories.map((memory) => [memory.id, memory]));
  db.transaction(() => {
    const sources = db.prepare('SELECT memory_id,content_hash FROM memory_index_sources WHERE bot_id=?').all(botId) as
      { memory_id: string; content_hash: string }[];
    for (const source of sources) {
      if (!current.has(source.memory_id)) {
        dropTerms(source.memory_id);
        db.prepare('DELETE FROM memory_index_sources WHERE memory_id=?').run(source.memory_id);
      }
    }
    const insertTerm = db.prepare('INSERT OR IGNORE INTO memory_index(memory_id,bot_id,term) VALUES (?,?,?)');
    const upsertSource = db.prepare(`INSERT INTO memory_index_sources(memory_id,bot_id,content_hash) VALUES (?,?,?)
      ON CONFLICT(memory_id) DO UPDATE SET bot_id=excluded.bot_id, content_hash=excluded.content_hash`);
    for (const memory of current.values()) {
      const hash = sha256(memory.text);
      const stored = db.prepare('SELECT content_hash FROM memory_index_sources WHERE memory_id=?').get(memory.id) as
        { content_hash: string } | undefined;
      if (stored?.content_hash === hash) continue;
      dropTerms(memory.id);
      if (isTombstoned(botId, hash)) {
        db.prepare('DELETE FROM memory_index_sources WHERE memory_id=?').run(memory.id);
        continue;
      }
      for (const term of terms(memory.text)) insertTerm.run(memory.id, botId, term);
      upsertSource.run(memory.id, botId, hash);
    }
  })();
}

/** Memory ids whose text contains every term in the query, scoped to one agent. */
export function searchMemory(botId: string, query: string): string[] {
  const wanted = terms(query);
  if (!wanted.length) return [];
  const placeholders = wanted.map(() => '?').join(',');
  const rows = db.prepare(`SELECT memory_id FROM memory_index
    WHERE bot_id=? AND term IN (${placeholders})
    GROUP BY memory_id HAVING COUNT(DISTINCT term)=?
    ORDER BY memory_id`)
    .all(botId, ...wanted, wanted.length) as { memory_id: string }[];
  return rows.map((row) => row.memory_id);
}

/** Index rows for one agent (used by the deletion planner to know what a purge must reach). */
export function indexedMemoryIds(botId: string): { memoryId: string; contentHash: string | null }[] {
  return db.prepare(`SELECT DISTINCT s.memory_id AS memoryId, s.content_hash AS contentHash
    FROM memory_index_sources s WHERE s.bot_id=?
    UNION
    SELECT DISTINCT i.memory_id AS memoryId, s2.content_hash AS contentHash
    FROM memory_index i LEFT JOIN memory_index_sources s2 ON s2.memory_id=i.memory_id
    WHERE i.bot_id=? AND s2.memory_id IS NULL`)
    .all(botId, botId) as { memoryId: string; contentHash: string | null }[];
}

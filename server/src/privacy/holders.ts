/**
 * Concrete data holders for deletion propagation (V6-04-10).
 *
 * A holder is the only thing that knows where a piece of an agent's data actually lives.
 * The deletion engine plans and verifies; holders discover targets and prove a purge (or an
 * evidence retention) happened. Adding a new place that stores agent data means adding a
 * holder — there is no generic "delete everything" path that could silently miss one.
 */
import { db } from '../db.js';
import { deleteMemory, listMemories } from '../engine-memory.js';
import { forgetLive, purgeConversation } from '../store.js';
import { sha256 } from '../lib/ids.js';
import { indexedMemoryIds, rememberTombstoneHash, removeMemoryFromIndex } from '../search/memory-index.js';

export interface DeletionSubject { tenantId: string; botId: string }

export interface TargetDraft {
  /** Stable reference inside the holder; the receipt commits to it. */
  ref: string;
  contentHash?: string | null;
  /** Presence makes the target an evidence-retention exception rather than a purge. */
  exceptionRule?: string | null;
  /** Human-auditable context, never personal content. */
  detail?: string | null;
}

export interface DeletionHolder {
  name: string;
  kind: 'content' | 'evidence';
  discover(subject: DeletionSubject): TargetDraft[] | Promise<TargetDraft[]>;
  purge?(target: TargetDraft, subject: DeletionSubject, context: { requestId: string }): Promise<'purged' | 'absent'> | ('purged' | 'absent');
  retain?(target: TargetDraft, subject: DeletionSubject): Promise<'retained' | 'absent'> | ('retained' | 'absent');
}

/** Agent memory and user-profile entries, read from the Hermes home that owns them. */
export const memoryHolder: DeletionHolder = {
  name: 'memory',
  kind: 'content',
  discover(subject) {
    return listMemories(subject.botId).map((memory) => ({
      ref: memory.id,
      contentHash: sha256(memory.text),
      detail: JSON.stringify({ source: memory.source ?? null }),
    }));
  },
  purge(target, subject) {
    const existed = listMemories(subject.botId).some((memory) => memory.id === target.ref);
    if (existed) deleteMemory(target.ref);
    if (listMemories(subject.botId).some((memory) => memory.id === target.ref)) {
      throw new Error(`memory ${target.ref} is still present after purge`);
    }
    return existed ? 'purged' : 'absent';
  },
};

/** Transcript rows, LLM input items and queued turns for every generation of the agent. */
export const conversationHolder: DeletionHolder = {
  name: 'conversation',
  kind: 'content',
  discover(subject) {
    const rows = (db.prepare('SELECT COUNT(*) n FROM rows WHERE bot_id=?').get(subject.botId) as { n: number }).n;
    const items = (db.prepare('SELECT COUNT(*) n FROM llm_items WHERE bot_id=?').get(subject.botId) as { n: number }).n;
    const pending = (db.prepare('SELECT COUNT(*) n FROM pending_turns WHERE bot_id=?').get(subject.botId) as { n: number }).n;
    if (!rows && !items && !pending) return [];
    return [{ ref: `history:${subject.botId}`, detail: JSON.stringify({ rows, items, pending }) }];
  },
  purge(_target, subject) {
    const before = (db.prepare('SELECT COUNT(*) n FROM rows WHERE bot_id=?').get(subject.botId) as { n: number }).n;
    purgeConversation(subject.botId);
    const left = db.prepare('SELECT (SELECT COUNT(*) FROM rows WHERE bot_id=?) + (SELECT COUNT(*) FROM llm_items WHERE bot_id=?) + (SELECT COUNT(*) FROM pending_turns WHERE bot_id=?) n')
      .get(subject.botId, subject.botId, subject.botId) as { n: number };
    if (left.n !== 0) throw new Error(`conversation for ${subject.botId} still has ${left.n} rows after purge`);
    return before ? 'purged' : 'absent';
  },
};

/** Cached runtime state (live activity/awaiting). Caches are disposable, but they are still data. */
export const cacheHolder: DeletionHolder = {
  name: 'cache',
  kind: 'content',
  discover(subject) {
    return [{ ref: `live:${subject.botId}` }];
  },
  purge(_target, subject) {
    return forgetLive(subject.botId) ? 'purged' : 'absent';
  },
};

/** The derived memory index; purging it also tombstones the content hash so it cannot come back. */
export const indexHolder: DeletionHolder = {
  name: 'index',
  kind: 'content',
  discover(subject) {
    return indexedMemoryIds(subject.botId).map((row) => ({
      ref: row.memoryId,
      contentHash: row.contentHash,
    }));
  },
  purge(target, subject, context) {
    const hadTerms = Boolean(db.prepare('SELECT 1 FROM memory_index WHERE memory_id=? LIMIT 1').get(target.ref));
    removeMemoryFromIndex(target.ref);
    if (target.contentHash) rememberTombstoneHash(subject.botId, target.contentHash, { requestId: context.requestId, sourceRef: target.ref });
    const left = db.prepare('SELECT 1 FROM memory_index WHERE memory_id=? LIMIT 1').get(target.ref);
    if (left) throw new Error(`index source ${target.ref} still has terms after purge`);
    if (target.contentHash && !db.prepare('SELECT 1 FROM privacy_tombstones WHERE bot_id=? AND content_hash=?').get(subject.botId, target.contentHash)) {
      throw new Error(`index source ${target.ref} was purged without a tombstone`);
    }
    return hadTerms ? 'purged' : 'absent';
  },
};

/**
 * Audit evidence (privileged-tool approval decisions). It records *that* a tool was approved,
 * never the message text or tool arguments, so erasure retains the row under an explicit rule
 * instead of destroying the audit trail. The rule is committed to in the receipt.
 */
export const evidenceHolder: DeletionHolder = {
  name: 'evidence',
  kind: 'evidence',
  discover(subject) {
    return (db.prepare('SELECT id, tool, status FROM approvals WHERE bot_id=? ORDER BY created_at, id').all(subject.botId) as
      { id: string; tool: string; status: string }[]).map((approval) => ({
      ref: approval.id,
      exceptionRule: 'audit:approval_history',
      detail: JSON.stringify({ tool: approval.tool, status: approval.status }),
    }));
  },
  retain(target, subject) {
    const row = db.prepare('SELECT 1 FROM approvals WHERE id=? AND bot_id=?').get(target.ref, subject.botId);
    if (!row) return 'absent';
    return 'retained';
  },
};

export const defaultHolders: readonly DeletionHolder[] = [
  memoryHolder, conversationHolder, cacheHolder, indexHolder, evidenceHolder,
];

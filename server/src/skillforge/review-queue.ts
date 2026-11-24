// SkillForge Review Queue - independent review, publish, rollback (I-31)
import { db } from '../db.js';
import { SkillForgeRegistry } from './registry.js';

export interface RollbackResult {
  success: boolean;
  revertedToVersion?: string;
  affectedTasks: string[];
  error?: string;
}

export interface ReviewQueueItem {
  id: string;
  candidateId: string;
  packId?: string;
  status: 'pending' | 'in-review' | 'approved' | 'rejected' | 'published' | 'revoked' | 'rolled-back';
  submittedAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
  reviewerRole?: string;
  reviewNotes?: string;
  approvalSignature?: string;
  independentReview: boolean;
}

export interface PublishRecord {
  packId: string;
  version: string;
  publishedAt: string;
  publishedBy: string;
  approvalSignature: string;
  previousVersion?: string;
}

export interface RollbackPlan {
  packId: string;
  fromVersion: string;
  toVersion: string;
  reason: string;
  affectedTasks: string[];
  strategy: 'wait-complete' | 'migrate' | 'cancel';
  deadline: string;
  approvedBy: string;
  approvalSignature: string;
}

export class SkillForgeReviewQueue {
  private static QUEUE_TABLE = 'skillforge_review_queue';
  private static PUBLISH_TABLE = 'skillforge_publish_history';
  private static ROLLBACK_TABLE = 'skillforge_rollbacks';

  static async init(): Promise<void> {
    await SkillForgeRegistry.init();
    await db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.QUEUE_TABLE} (
        id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL,
        pack_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        submitted_at TEXT NOT NULL,
        reviewed_at TEXT,
        reviewed_by TEXT,
        reviewer_role TEXT,
        review_notes TEXT,
        approval_signature TEXT,
        independent_review INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_queue_status ON ${this.QUEUE_TABLE}(status);
      CREATE INDEX IF NOT EXISTS idx_queue_candidate ON ${this.QUEUE_TABLE}(candidate_id);

      CREATE TABLE IF NOT EXISTS ${this.PUBLISH_TABLE} (
        id TEXT PRIMARY KEY,
        pack_id TEXT NOT NULL,
        version TEXT NOT NULL,
        published_at TEXT NOT NULL,
        published_by TEXT NOT NULL,
        approval_signature TEXT NOT NULL,
        previous_version TEXT
      );

      CREATE TABLE IF NOT EXISTS ${this.ROLLBACK_TABLE} (
        id TEXT PRIMARY KEY,
        pack_id TEXT NOT NULL,
        from_version TEXT NOT NULL,
        to_version TEXT NOT NULL,
        reason TEXT NOT NULL,
        affected_tasks TEXT NOT NULL,
        strategy TEXT NOT NULL,
        deadline TEXT NOT NULL,
        approved_by TEXT NOT NULL,
        approval_signature TEXT NOT NULL,
        executed_at TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
      );
    `);
  }

  static async submitForReview(candidateId: string, packId: string, submitter: string): Promise<any> {
    const id = `review_${Date.now()}_${Math.random().toString(36).slice(2,9)}`;
    const now = new Date().toISOString();
    const item = { id, candidateId, packId, status: 'pending', submittedAt: now, independentReview: true };
    await db.prepare(`INSERT INTO ${this.QUEUE_TABLE} VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      item.id, item.candidateId, item.packId, item.status, item.submittedAt,
      null, null, null, null, null, 1
    );
    return item;
  }

  static async assignReviewer(itemId: string, reviewer: string, reviewerRole: string): Promise<void> {
    const now = new Date().toISOString();
    await db.prepare(`UPDATE ${this.QUEUE_TABLE} SET status='in-review', reviewed_at=?, reviewed_by=?, reviewer_role=? WHERE id=?`).run(now, reviewer, reviewerRole, itemId);
  }

  static async approve(itemId: string, reviewer: string, signature: string, notes?: string): Promise<void> {
    const now = new Date().toISOString();
    await db.prepare(`UPDATE ${this.QUEUE_TABLE} SET status='approved', reviewed_at=?, reviewed_by=?, approval_signature=?, review_notes=? WHERE id=?`).run(now, reviewer, signature, notes ?? null, itemId);
  }

  static async reject(itemId: string, reviewer: string, notes?: string): Promise<void> {
    const now = new Date().toISOString();
    await db.prepare(`UPDATE ${this.QUEUE_TABLE} SET status='rejected', reviewed_at=?, reviewed_by=?, review_notes=? WHERE id=?`).run(now, reviewer, notes ?? null, itemId);
  }

  static async publish(packId: string, version: string, publisher: string, approvalSignature: string, previousVersion?: string): Promise<any> {
    const id = `publish_${Date.now()}_${Math.random().toString(36).slice(2,9)}`;
    const now = new Date().toISOString();
    await db.prepare(`INSERT INTO ${this.PUBLISH_TABLE} VALUES (?,?,?,?,?,?,?)`).run(id, packId, version, now, publisher, approvalSignature, previousVersion ?? null);
    return { packId, version, publishedAt: now, publishedBy: publisher, approvalSignature, previousVersion };
  }

  static async rollback(plan: any): Promise<any> {
    const id = `rollback_${Date.now()}_${Math.random().toString(36).slice(2,9)}`;
    const now = new Date().toISOString();
    
    await db.prepare(`INSERT INTO ${this.ROLLBACK_TABLE} VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, plan.packId, plan.fromVersion, plan.toVersion, plan.reason,
      JSON.stringify(plan.affectedTasks), plan.strategy, plan.deadline,
      plan.approvedBy, plan.approvalSignature, null, 'pending'
    );

    const packs = await SkillForgeRegistry.listPacks();
    const targetPack = packs.find(p => p.id === plan.packId && p.version === plan.toVersion);
    if (!targetPack) {
      return { success: false, error: `Version ${plan.toVersion} not found`, affectedTasks: plan.affectedTasks };
    }

    await db.prepare(`UPDATE ${this.ROLLBACK_TABLE} SET status='executed', executed_at=? WHERE id=?`).run(new Date().toISOString(), id);

    return { success: true, revertedToVersion: plan.toVersion, affectedTasks: plan.affectedTasks };
  }

  static async getQueue(status?: string): Promise<any[]> {
    if (status) {
      return db.prepare(`SELECT * FROM ${this.QUEUE_TABLE} WHERE status=? ORDER BY submitted_at DESC`).all(status);
    }
    return db.prepare(`SELECT * FROM ${this.QUEUE_TABLE} ORDER BY submitted_at DESC`).all();
  }

  static async getPublishHistory(packId?: string): Promise<any[]> {
    if (packId) {
      return db.prepare(`SELECT * FROM ${this.PUBLISH_TABLE} WHERE pack_id=? ORDER BY published_at DESC`).all(packId);
    }
    return db.prepare(`SELECT * FROM ${this.PUBLISH_TABLE} ORDER BY published_at DESC`).all();
  }

  static async getRollbackHistory(packId?: string): Promise<any[]> {
    if (packId) {
      return db.prepare(`SELECT * FROM ${this.ROLLBACK_TABLE} WHERE pack_id=? ORDER BY executed_at DESC`).all(packId);
    }
    return db.prepare(`SELECT * FROM ${this.ROLLBACK_TABLE} ORDER BY executed_at DESC`).all();
  }
}
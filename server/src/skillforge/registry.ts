// SkillForge Registry - stores and serves signed capability packs
import { db } from '../db.js';
import { SkillPackVersion, SkillCandidate, SignedCapabilityPack, SkillPackVersion as SPV } from './types.js';

export class SkillForgeRegistry {
  private static CANDIDATES_TABLE = 'skillforge_candidates';
  private static PACKS_TABLE = 'skillforge_packs';
  private static GRANTS_TABLE = 'skillforge_grants';

  static async init(): Promise<void> {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.CANDIDATES_TABLE} (
        id TEXT PRIMARY KEY,
        source_url TEXT NOT NULL,
        source_sha TEXT NOT NULL,
        proposed_by TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        submitted_at TEXT NOT NULL,
        reviewed_at TEXT,
        reviewed_by TEXT,
        review_notes TEXT,
        skill_pack TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_candidates_status ON ${this.CANDIDATES_TABLE}(status);
      CREATE INDEX IF NOT EXISTS idx_candidates_proposed ON ${this.CANDIDATES_TABLE}(proposed_by);

      CREATE TABLE IF NOT EXISTS ${this.PACKS_TABLE} (
        id TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        name TEXT NOT NULL,
        publisher TEXT NOT NULL,
        license TEXT NOT NULL,
        source_sha TEXT NOT NULL,
        source_url TEXT NOT NULL,
        tools TEXT NOT NULL,
        dependencies TEXT NOT NULL,
        grants TEXT NOT NULL,
        compatible_roles TEXT NOT NULL,
        min_hermes_version TEXT NOT NULL,
        max_hermes_version TEXT,
        signed_at TEXT NOT NULL,
        signed_by TEXT NOT NULL,
        signature TEXT NOT NULL,
        capability_pack TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_packs_publisher ON ${this.PACKS_TABLE}(publisher);
      CREATE INDEX IF NOT EXISTS idx_packs_name ON ${this.PACKS_TABLE}(name, version);

      CREATE TABLE IF NOT EXISTS ${this.GRANTS_TABLE} (
        grant_id TEXT PRIMARY KEY,
        skill_pack_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        effect_class TEXT NOT NULL,
        budget TEXT NOT NULL,
        conditions TEXT NOT NULL,
        FOREIGN KEY (skill_pack_id) REFERENCES ${this.PACKS_TABLE}(id)
      );
    `);
  }

  static async submitCandidate(candidate: Omit<SkillCandidate, 'id' | 'status' | 'submittedAt'>): Promise<SkillCandidate> {
    const id = `skillforge_${Date.now()}_${Math.random().toString(36).slice(2,9)}`;
    const now = new Date().toISOString();
    const c: SkillCandidate = { ...candidate, id, status: 'pending', submittedAt: now };
    await db.prepare(`INSERT INTO ${this.CANDIDATES_TABLE} VALUES (?,?,?,?,?,?,?,?,?)`).run(
      c.id, c.sourceUrl, c.sourceSha, c.proposedBy, c.status, c.submittedAt,
      c.reviewedAt ?? null, c.reviewedBy ?? null, c.reviewNotes ?? null,
      c.skillPack ? JSON.stringify(c.skillPack) : null
    );
    return c;
  }

  static async listCandidates(status?: SkillCandidate['status']): Promise<SkillCandidate[]> {
    if (status) {
      return db.prepare(`SELECT * FROM ${this.CANDIDATES_TABLE} WHERE status=? ORDER BY submitted_at DESC`).all(status) as SkillCandidate[];
    }
    return db.prepare(`SELECT * FROM ${this.CANDIDATES_TABLE} ORDER BY submitted_at DESC`).all() as SkillCandidate[];
  }

  static async reviewCandidate(id: string, reviewer: string, status: 'approved' | 'rejected', notes?: string): Promise<void> {
    const now = new Date().toISOString();
    db.prepare(`UPDATE ${this.CANDIDATES_TABLE} SET status=?, reviewed_at=?, reviewed_by=?, review_notes=? WHERE id=?`).run(status, now, reviewer, notes ?? null, id);
  }

  static async publishPack(pack: SkillPackVersion, capabilityPack: any): Promise<void> {
    await db.prepare(`INSERT INTO ${this.PACKS_TABLE} VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      pack.id, pack.version, pack.name, pack.publisher, pack.license,
      pack.sourceSha, pack.sourceUrl, JSON.stringify(pack.tools),
      JSON.stringify(pack.dependencies), JSON.stringify(pack.grants),
      JSON.stringify(pack.compatibleRoles), pack.minHermesVersion,
      pack.maxHermesVersion ?? null, pack.signedAt, pack.signedBy, pack.signature,
      JSON.stringify(capabilityPack)
    );
  }

  static async getPack(id: string): Promise<SkillPackVersion | null> {
    const row = db.prepare(`SELECT * FROM ${this.PACKS_TABLE} WHERE id=?`).get(id) as any;
    if (!row) return null;
    return {
      ...row,
      tools: JSON.parse(row.tools),
      dependencies: JSON.parse(row.dependencies),
      grants: JSON.parse(row.grants),
      compatibleRoles: JSON.parse(row.compatible_roles)
    };
  }

  static async listPacks(publisher?: string): Promise<SkillPackVersion[]> {
    if (publisher) {
      return db.prepare(`SELECT * FROM ${this.PACKS_TABLE} WHERE publisher=? ORDER BY name, version`).all(publisher) as SkillPackVersion[];
    }
    return db.prepare(`SELECT * FROM ${this.PACKS_TABLE} ORDER BY name, version`).all() as SkillPackVersion[];
  }

  static async getCapabilityPack(id: string): Promise<any | null> {
    const row = db.prepare(`SELECT capability_pack FROM ${this.PACKS_TABLE} WHERE id=?`).get(id) as any;
    return row ? JSON.parse(row.capability_pack) : null;
  }

  static async revokePack(id: string, reason: string): Promise<void> {
    await db.prepare(`DELETE FROM ${this.PACKS_TABLE} WHERE id=?`).run(id);
    await db.prepare(`DELETE FROM ${this.GRANTS_TABLE} WHERE skill_pack_id=?`).run(id);
  }
}

export const skillForgeRegistry = new SkillForgeRegistry();
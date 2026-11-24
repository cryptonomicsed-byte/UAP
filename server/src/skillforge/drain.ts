// SkillForge skill-drain + end-to-end invocation (I-32 / V6-09-09..10)
// Drain in-flight tasks off a pack version; invoke a tool through the pack under policy.

import { db } from '../db.js';
import { SkillForgeRegistry } from './registry.js';
import { SkillForgeLoader } from './loader.js';

export type DrainStrategy = 'wait-complete' | 'migrate' | 'cancel';

export interface SkillDrainPlan {
  id: string;
  packId: string;
  fromVersion: string;
  toVersion: string;
  strategy: DrainStrategy;
  affectedTasks: string[];
  deadline: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  createdAt: string;
  completedAt?: string;
  error?: string;
}

export interface InvocationResult {
  ok: boolean;
  tool: string;
  packId: string;
  packVersion: string;
  output?: unknown;
  error?: string;
  code?: string;
  durationMs: number;
}

export class SkillForgeDrain {
  private static DRAIN_TABLE = 'skillforge_drains';
  private static INVOCATION_TABLE = 'skillforge_invocations';

  static async init(): Promise<void> {
    await SkillForgeRegistry.init();
    await db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.DRAIN_TABLE} (
        id TEXT PRIMARY KEY,
        pack_id TEXT NOT NULL,
        from_version TEXT NOT NULL,
        to_version TEXT NOT NULL,
        strategy TEXT NOT NULL,
        affected_tasks TEXT NOT NULL,
        deadline TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_drains_pack ON ${this.DRAIN_TABLE}(pack_id, status);

      CREATE TABLE IF NOT EXISTS ${this.INVOCATION_TABLE} (
        id TEXT PRIMARY KEY,
        pack_id TEXT NOT NULL,
        pack_version TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        role_id TEXT,
        sid TEXT,
        ok INTEGER NOT NULL,
        code TEXT,
        duration_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_invocations_pack ON ${this.INVOCATION_TABLE}(pack_id);
    `);
  }

  /** List task IDs that still reference pack@fromVersion (best-effort from jobs table if present). */
  static listAffectedTasks(packId: string, fromVersion: string): string[] {
    try {
      const rows = db.prepare(
        `SELECT id FROM jobs WHERE payload LIKE ? OR payload LIKE ? LIMIT 500`,
      ).all(`%${packId}%`, `%${fromVersion}%`) as Array<{ id: string }>;
      return rows.map((r) => r.id);
    } catch {
      return [];
    }
  }

  static async planDrain(input: {
    packId: string;
    fromVersion: string;
    toVersion: string;
    strategy: DrainStrategy;
    deadlineHours?: number;
  }): Promise<SkillDrainPlan> {
    const packs = await SkillForgeRegistry.listPacks();
    const target = packs.find((p) => p.id === input.packId && p.version === input.toVersion);
    if (!target) {
      throw Object.assign(new Error(`target version ${input.toVersion} not found`), { code: 'drain_target_missing' });
    }
    if (input.fromVersion === input.toVersion) {
      throw Object.assign(new Error('from and to versions must differ'), { code: 'drain_same_version' });
    }

    const id = `drain_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const now = new Date();
    const deadline = new Date(now.getTime() + (input.deadlineHours ?? 24) * 3600_000).toISOString();
    const affected = this.listAffectedTasks(input.packId, input.fromVersion);
    const plan: SkillDrainPlan = {
      id,
      packId: input.packId,
      fromVersion: input.fromVersion,
      toVersion: input.toVersion,
      strategy: input.strategy,
      affectedTasks: affected,
      deadline,
      status: 'pending',
      createdAt: now.toISOString(),
    };
    await db.prepare(
      `INSERT INTO ${this.DRAIN_TABLE} VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      plan.id, plan.packId, plan.fromVersion, plan.toVersion, plan.strategy,
      JSON.stringify(plan.affectedTasks), plan.deadline, plan.status, plan.createdAt, null, null,
    );
    return plan;
  }

  static async executeDrain(drainId: string): Promise<SkillDrainPlan> {
    const row = db.prepare(`SELECT * FROM ${this.DRAIN_TABLE} WHERE id=?`).get(drainId) as any;
    if (!row) throw Object.assign(new Error('drain not found'), { code: 'drain_missing' });
    if (row.status === 'completed') {
      return this.rowToPlan(row);
    }

    db.prepare(`UPDATE ${this.DRAIN_TABLE} SET status='running' WHERE id=?`).run(drainId);

    try {
      const affected: string[] = JSON.parse(row.affected_tasks || '[]');
      if (row.strategy === 'cancel') {
        for (const taskId of affected) {
          try {
            db.prepare(`UPDATE jobs SET status='cancelled' WHERE id=? AND status IN ('queued','running')`).run(taskId);
          } catch { /* jobs table may not have status column in all modes */ }
        }
      } else if (row.strategy === 'migrate') {
        // Rewrite payload pack version markers when present
        for (const taskId of affected) {
          try {
            const job = db.prepare(`SELECT payload FROM jobs WHERE id=?`).get(taskId) as any;
            if (job?.payload && typeof job.payload === 'string') {
              const next = job.payload.replaceAll(row.from_version, row.to_version);
              db.prepare(`UPDATE jobs SET payload=? WHERE id=?`).run(next, taskId);
            }
          } catch { /* best-effort */ }
        }
      }
      // wait-complete: just mark completed; callers poll affected until empty

      const completedAt = new Date().toISOString();
      db.prepare(`UPDATE ${this.DRAIN_TABLE} SET status='completed', completed_at=? WHERE id=?`).run(completedAt, drainId);
      return this.rowToPlan({ ...row, status: 'completed', completed_at: completedAt });
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      db.prepare(`UPDATE ${this.DRAIN_TABLE} SET status='failed', error=? WHERE id=?`).run(msg, drainId);
      throw e;
    }
  }

  static getDrain(id: string): SkillDrainPlan | null {
    const row = db.prepare(`SELECT * FROM ${this.DRAIN_TABLE} WHERE id=?`).get(id) as any;
    return row ? this.rowToPlan(row) : null;
  }

  static listDrains(packId?: string): SkillDrainPlan[] {
    const rows = packId
      ? db.prepare(`SELECT * FROM ${this.DRAIN_TABLE} WHERE pack_id=? ORDER BY created_at DESC`).all(packId)
      : db.prepare(`SELECT * FROM ${this.DRAIN_TABLE} ORDER BY created_at DESC`).all();
    return (rows as any[]).map((r) => this.rowToPlan(r));
  }

  /**
   * End-to-end invocation proof: load pack for role, find tool, run a local
   * no-side-effect validator path (schema check only) and record the receipt.
   * Real side-effectful tools still go through policy MCP; this proves the pack path.
   */
  static async invoke(input: {
    packId: string;
    toolName: string;
    args: unknown;
    roleId?: string;
    sid?: string;
  }): Promise<InvocationResult> {
    const t0 = Date.now();
    const pack = await SkillForgeRegistry.getPack(input.packId);
    if (!pack) {
      return this.recordInvocation({
        packId: input.packId, packVersion: '?', toolName: input.toolName,
        roleId: input.roleId, sid: input.sid, ok: false, code: 'pack_missing', durationMs: Date.now() - t0,
      });
    }

    if (!SkillForgeLoader.verifySignature(pack)) {
      return this.recordInvocation({
        packId: pack.id, packVersion: pack.version, toolName: input.toolName,
        roleId: input.roleId, sid: input.sid, ok: false, code: 'invalid_signature', durationMs: Date.now() - t0,
      });
    }

    const tool = (pack.tools || []).find((t: any) => t.name === input.toolName);
    if (!tool) {
      return this.recordInvocation({
        packId: pack.id, packVersion: pack.version, toolName: input.toolName,
        roleId: input.roleId, sid: input.sid, ok: false, code: 'tool_missing', durationMs: Date.now() - t0,
      });
    }

    // Schema presence check (full JSON Schema validation is H-28 territory)
    if (!tool.inputSchema || typeof tool.inputSchema !== 'object') {
      return this.recordInvocation({
        packId: pack.id, packVersion: pack.version, toolName: input.toolName,
        roleId: input.roleId, sid: input.sid, ok: false, code: 'tool_schema_missing', durationMs: Date.now() - t0,
      });
    }

    if (input.args === undefined || input.args === null) {
      return this.recordInvocation({
        packId: pack.id, packVersion: pack.version, toolName: input.toolName,
        roleId: input.roleId, sid: input.sid, ok: false, code: 'args_required', durationMs: Date.now() - t0,
      });
    }

    // Successful path: echo validated envelope (no external side effects here)
    const durationMs = Date.now() - t0;
    return this.recordInvocation({
      packId: pack.id,
      packVersion: pack.version,
      toolName: input.toolName,
      roleId: input.roleId,
      sid: input.sid,
      ok: true,
      durationMs,
      output: {
        tool: tool.name,
        pack: `${pack.id}@${pack.version}`,
        argsAccepted: true,
        grants: pack.grants ?? [],
      },
    });
  }

  private static recordInvocation(r: {
    packId: string; packVersion: string; toolName: string;
    roleId?: string; sid?: string; ok: boolean; code?: string;
    durationMs: number; output?: unknown;
  }): InvocationResult {
    const id = `inv_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const now = new Date().toISOString();
    try {
      db.prepare(
        `INSERT INTO ${this.INVOCATION_TABLE} VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(id, r.packId, r.packVersion, r.toolName, r.roleId ?? null, r.sid ?? null, r.ok ? 1 : 0, r.code ?? null, r.durationMs, now);
    } catch {
      // table may not exist until init
    }
    return {
      ok: r.ok,
      tool: r.toolName,
      packId: r.packId,
      packVersion: r.packVersion,
      output: r.output,
      error: r.ok ? undefined : r.code,
      code: r.code,
      durationMs: r.durationMs,
    };
  }

  private static rowToPlan(row: any): SkillDrainPlan {
    return {
      id: row.id,
      packId: row.pack_id,
      fromVersion: row.from_version,
      toVersion: row.to_version,
      strategy: row.strategy,
      affectedTasks: typeof row.affected_tasks === 'string' ? JSON.parse(row.affected_tasks) : (row.affected_tasks || []),
      deadline: row.deadline,
      status: row.status,
      createdAt: row.created_at,
      completedAt: row.completed_at ?? undefined,
      error: row.error ?? undefined,
    };
  }
}

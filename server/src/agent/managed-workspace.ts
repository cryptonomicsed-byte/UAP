import type Database from 'better-sqlite3';
import { ensureOmokodaSchema } from '../lib/omokoda-birth.js';
import { authorizeModelToolCall } from '../policy/tool-authority.js';

interface Command {
  botId: string;
  userId: string;
  text: string;
  fromUser: boolean;
  signal?: AbortSignal;
}

type Result = { status: 'ok' | 'denied' | 'unsupported'; text: string };

/** One user-invoked local read. Neither model output nor a scheduled/peer turn can dispatch it. */
export async function managedWorkspaceCommand(db: Database.Database, input: Command): Promise<Result | null> {
  const text = input.text.trim();
  if (!input.fromUser || !/^\/workspace(?:\s|$)/.test(text)) return null;
  ensureOmokodaSchema(db);
  const owned = db.prepare(`SELECT b.id FROM bots b
    JOIN omokoda_births o ON o.bot_id=b.id JOIN omokoda_managed_runtime m ON m.bot_id=b.id
    WHERE b.id=? AND b.user_id=? AND m.kernel_sid<>''`).get(input.botId, input.userId);
  if (!owned) return null;
  if (text !== '/workspace routines') return { status: 'unsupported', text: 'Available workspace command: /workspace routines' };

  input.signal?.throwIfAborted();
  const verdict = await authorizeModelToolCall({ botId: input.botId, userId: input.userId, toolName: 'list_routines', args: {} });
  input.signal?.throwIfAborted();
  if (!verdict.allowed || verdict.effect !== 'read' || verdict.permit?.effect !== 'read' || !(verdict.permit.expiresAtMs > Date.now())) {
    return { status: 'denied', text: `Workspace read refused (${verdict.allowed ? 'no-current-read-permit' : verdict.code}).` };
  }
  // A fixed, tenant-scoped projection; don't disclose prompt content or forward it to inference.
  const rows = db.prepare(`SELECT substr(r.name,1,120) AS name, r.enabled FROM routines r JOIN bots b ON b.id=r.bot_id
    WHERE b.id=? AND b.user_id=? ORDER BY r.created_at,r.id LIMIT 21`).all(input.botId, input.userId) as { name: string; enabled: number }[];
  if (!rows.length) return { status: 'ok', text: 'No routines are scheduled for this agent.' };
  const lines = rows.slice(0, 20).map((row) => `• ${row.name.replace(/\s+/g, ' ').trim()} — ${row.enabled ? 'enabled' : 'paused'}`);
  if (rows.length > 20) lines.push('More routines are available in the workspace.');
  return { status: 'ok', text: lines.join('\n') };
}

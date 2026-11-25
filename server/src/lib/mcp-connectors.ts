/**
 * Real, per-bot custom MCP server connectors. Fixes the "connectors are generic" gap:
 * previously the only options were Composio's toolkit catalog and one global
 * EXTRA_MCP_SERVERS env var applied identically to every bot. A bot owner can now add any
 * real MCP server (stdio is deliberately out of scope here — a managed bot's home runs
 * server-side, not on the owner's machine, so only remote HTTP/StreamableHTTP servers are
 * exposed through this UI, exactly the transport Hermes's native MCP client documents).
 *
 * Header values (API keys, bearer tokens) are stored as-is in the local sqlite db (same trust
 * boundary as everything else in data/platform.db) and are never returned by the read routes —
 * only a redacted "set" boolean per header name, so a key pasted once is never re-displayed.
 */
import type Database from 'better-sqlite3';
import { newId } from './ids.js';

export interface BotMcpServerRow {
  id: string;
  bot_id: string;
  name: string;
  url: string;
  headers_json: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export interface BotMcpServerPublic {
  id: string;
  name: string;
  url: string;
  headerNames: string[];
  enabled: boolean;
  createdAt: number;
}

const NAME_RE = /^[a-z][a-z0-9_]{1,30}$/;

export function listMcpServers(db: Database.Database, botId: string): BotMcpServerPublic[] {
  const rows = db.prepare('SELECT * FROM bot_mcp_servers WHERE bot_id=? ORDER BY created_at').all(botId) as BotMcpServerRow[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    url: r.url,
    headerNames: Object.keys(JSON.parse(r.headers_json || '{}')),
    enabled: !!r.enabled,
    createdAt: r.created_at,
  }));
}

export class McpConnectorError extends Error {}

export function addMcpServer(db: Database.Database, botId: string, input: { name: string; url: string; headers?: Record<string, string> }): BotMcpServerPublic {
  const name = input.name.trim().toLowerCase();
  if (!NAME_RE.test(name)) throw new McpConnectorError('Name must be lowercase letters/numbers/underscore, starting with a letter (it becomes the mcp_<name>_* tool prefix).');
  let url: URL;
  try { url = new URL(input.url); } catch { throw new McpConnectorError('That is not a valid URL.'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'))) {
    throw new McpConnectorError('MCP server URL must be https:// (or http://localhost for local testing).');
  }
  const existing = db.prepare('SELECT id FROM bot_mcp_servers WHERE bot_id=? AND name=?').get(botId, name);
  if (existing) throw new McpConnectorError(`This bot already has an MCP server named "${name}". Remove it first or pick a different name.`);
  const id = newId('mcp');
  const now = Date.now();
  db.prepare('INSERT INTO bot_mcp_servers(id,bot_id,name,url,headers_json,enabled,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)')
    .run(id, botId, name, url.toString(), JSON.stringify(input.headers ?? {}), now, now);
  return { id, name, url: url.toString(), headerNames: Object.keys(input.headers ?? {}), enabled: true, createdAt: now };
}

export function removeMcpServer(db: Database.Database, botId: string, id: string): boolean {
  return db.prepare('DELETE FROM bot_mcp_servers WHERE bot_id=? AND id=?').run(botId, id).changes > 0;
}

export function setMcpServerEnabled(db: Database.Database, botId: string, id: string, enabled: boolean): boolean {
  return db.prepare('UPDATE bot_mcp_servers SET enabled=?, updated_at=? WHERE bot_id=? AND id=?').run(enabled ? 1 : 0, Date.now(), botId, id).changes > 0;
}

/** What engine.ts merges into this bot's config.yaml mcp_servers, in Hermes's own
 *  { url, headers, timeout, connect_timeout } shape. Disabled rows are omitted entirely
 *  rather than sent with some "off" flag Hermes wouldn't understand. */
export function mcpServersFor(db: Database.Database, botId: string): Record<string, { url: string; headers: Record<string, string>; timeout: number; connect_timeout: number }> {
  const rows = db.prepare('SELECT * FROM bot_mcp_servers WHERE bot_id=? AND enabled=1').all(botId) as BotMcpServerRow[];
  const out: Record<string, { url: string; headers: Record<string, string>; timeout: number; connect_timeout: number }> = {};
  for (const r of rows) {
    out[r.name] = { url: r.url, headers: JSON.parse(r.headers_json || '{}'), timeout: 120, connect_timeout: 30 };
  }
  return out;
}

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
import { isDeepStrictEqual } from 'node:util';
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
// Disabled (0) can be re-enabled; deleted (-1) is a credential-free tombstone so a
// later engine restart can remove an already-materialized entry from config.yaml.
const REMOVED = -1;

export function listMcpServers(db: Database.Database, botId: string): BotMcpServerPublic[] {
  const rows = db.prepare('SELECT * FROM bot_mcp_servers WHERE bot_id=? AND enabled<>? ORDER BY created_at').all(botId, REMOVED) as BotMcpServerRow[];
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

// Connector fields are literal, not references to credentials from the Hermes home.
function assertLiteralConnector(url: string, headers: Record<string, unknown>) {
  if (/\$|%24/i.test(url) || Object.entries(headers).some(([key, value]) =>
    key.includes('$') || typeof value !== 'string' || value.includes('$'))) {
    throw new McpConnectorError('Connector URLs and headers must not contain environment references.');
  }
}

export function addMcpServer(db: Database.Database, botId: string, input: { name: string; url: string; headers?: Record<string, string> }): BotMcpServerPublic {
  const name = input.name.trim().toLowerCase();
  if (!NAME_RE.test(name)) throw new McpConnectorError('Name must be lowercase letters/numbers/underscore, starting with a letter (it becomes the mcp_<name>_* tool prefix).');
  if (name === 'hq' || name === 'constructor') throw new McpConnectorError('This connector name is reserved.');
  let url: URL;
  try { url = new URL(input.url); } catch { throw new McpConnectorError('That is not a valid URL.'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'))) {
    throw new McpConnectorError('MCP server URL must be https:// (or http://localhost for local testing).');
  }
  if (url.username || url.password) throw new McpConnectorError('Put credentials in headers, not in the server URL.');
  if (input.headers !== undefined && (!input.headers || typeof input.headers !== 'object' || Array.isArray(input.headers) ||
      Object.entries(input.headers).some(([key, value]) => !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(key) || typeof value !== 'string' || /[^\x20-\x7e]/.test(value)))) {
    throw new McpConnectorError('Use valid HTTP header names and single-line values.');
  }
  assertLiteralConnector(url.toString(), input.headers ?? {});
  const id = newId('mcp');
  const now = Date.now();
  db.transaction(() => {
    if (db.prepare('SELECT id FROM bot_mcp_servers WHERE bot_id=? AND name=? AND enabled<>?').get(botId, name, REMOVED)) {
      throw new McpConnectorError(`This bot already has an MCP server named "${name}". Remove it first or pick a different name.`);
    }
    db.prepare('DELETE FROM bot_mcp_servers WHERE bot_id=? AND name=? AND enabled=?').run(botId, name, REMOVED);
    db.prepare('INSERT INTO bot_mcp_servers(id,bot_id,name,url,headers_json,enabled,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)')
      .run(id, botId, name, url.toString(), JSON.stringify(input.headers ?? {}), now, now);
  }).immediate();
  return { id, name, url: url.toString(), headerNames: Object.keys(input.headers ?? {}), enabled: true, createdAt: now };
}

export function removeMcpServer(db: Database.Database, botId: string, id: string): boolean {
  return db.prepare("UPDATE bot_mcp_servers SET enabled=?, url='', headers_json='{}', updated_at=? WHERE bot_id=? AND id=? AND enabled<>?")
    .run(REMOVED, Date.now(), botId, id, REMOVED).changes > 0;
}

export function setMcpServerEnabled(db: Database.Database, botId: string, id: string, enabled: boolean): boolean {
  return db.prepare('UPDATE bot_mcp_servers SET enabled=?, updated_at=? WHERE bot_id=? AND id=? AND enabled<>?').run(enabled ? 1 : 0, Date.now(), botId, id, REMOVED).changes > 0;
}

/** What engine.ts merges into this bot's config.yaml mcp_servers, in Hermes's own
 *  { url, headers, timeout, connect_timeout } shape. Disabled rows are omitted entirely
 *  rather than sent with some "off" flag Hermes wouldn't understand. */
export function mcpServersFor(db: Database.Database, botId: string): Record<string, { url: string; headers: Record<string, string>; timeout: number; connect_timeout: number; sampling: { enabled: false } }> {
  const rows = db.prepare('SELECT * FROM bot_mcp_servers WHERE bot_id=? AND enabled=1').all(botId) as BotMcpServerRow[];
  const out: Record<string, { url: string; headers: Record<string, string>; timeout: number; connect_timeout: number; sampling: { enabled: false } }> = {};
  for (const r of rows) {
    const headers = parseHeaders(r.headers_json);
    if (!headers) continue;
    try { assertLiteralConnector(r.url, headers); } catch { continue; }
    out[r.name] = { url: r.url, headers, timeout: 120, connect_timeout: 30, sampling: { enabled: false } };
  }
  return out;
}

function parseHeaders(json: string): Record<string, string> | null {
  try {
    const value = JSON.parse(json || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

/** Reconcile entries we explicitly wrote, or exact matches to the previous generated shape.
 * Previously deleted entries without either proof must be reviewed by the operator. */
export function reconcileMcpServers(db: Database.Database, botId: string, existing: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) {
  const manual = { ...existing };
  for (const [name, entry] of Object.entries(manual)) {
    if (entry && typeof entry === 'object' && '_uap_connector' in entry && entry._uap_connector === botId) delete manual[name];
  }
  const rows = db.prepare('SELECT * FROM bot_mcp_servers WHERE bot_id=? AND enabled<>?').all(botId, REMOVED) as BotMcpServerRow[];
  for (const row of rows) {
    const headers = parseHeaders(row.headers_json);
    if (headers && isDeepStrictEqual(manual[row.name], { url: row.url, headers, timeout: 120, connect_timeout: 30 })) delete manual[row.name];
  }
  const resolved = { ...manual, ...extra };
  for (const [name, entry] of Object.entries(mcpServersFor(db, botId))) {
    if (Object.hasOwn(resolved, name)) throw new McpConnectorError(`Connector ${name} conflicts with an operator-configured server. Rename or remove the UAP connector.`);
    resolved[name] = { ...entry, _uap_connector: botId };
  }
  return resolved;
}

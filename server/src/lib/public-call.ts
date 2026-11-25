/**
 * Public, no-login voice chat: a QR code -- like the other HelixMain repos' /call/<slug>
 * orb pattern -- lets anyone who scans it talk to one specific bot, with no UAP account.
 * Always uses the real local TTS/STT stack (never xAI), regardless of this server's own
 * provider config, so the scanned experience never depends on a paid key being present.
 */
import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import type Database from 'better-sqlite3';

export function publicCallUrl(token: string, origin: string): string {
  return `${origin.replace(/\/+$/, '')}/call/${token}`;
}

export function ensurePublicCallToken(db: Database.Database, botId: string): string {
  const row = db.prepare('SELECT public_call_token FROM bots WHERE id = ?').get(botId) as { public_call_token: string | null } | undefined;
  if (row?.public_call_token) return row.public_call_token;
  const token = randomBytes(18).toString('base64url');
  db.prepare('UPDATE bots SET public_call_token = ? WHERE id = ?').run(token, botId);
  return token;
}

export function regeneratePublicCallToken(db: Database.Database, botId: string): string {
  const token = randomBytes(18).toString('base64url');
  db.prepare('UPDATE bots SET public_call_token = ? WHERE id = ?').run(token, botId);
  return token;
}

export function botIdForPublicToken(db: Database.Database, token: string): { id: string; name: string; avatarColor: string; avatarShape: string } | null {
  if (!token || token.length < 10) return null;
  const row = db.prepare('SELECT id, name, avatar_color, avatar_shape FROM bots WHERE public_call_token = ?').get(token) as any;
  if (!row) return null;
  return { id: row.id, name: row.name, avatarColor: row.avatar_color, avatarShape: row.avatar_shape };
}

export async function qrCodeDataUrl(url: string): Promise<string> {
  return QRCode.toDataURL(url, { margin: 1, width: 320 });
}

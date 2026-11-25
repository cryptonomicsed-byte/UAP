/** Ticket board: a shared list humans and bots both work from (Rakazo's pattern).
 *  Operate surface — action affordances and status, never a hero. */
import type Database from 'better-sqlite3';
import { newId } from './ids.js';

export const TICKET_STATUSES = ['todo', 'in_progress', 'in_review', 'blocked', 'done', 'wont_do'] as const;
export type TicketStatus = typeof TICKET_STATUSES[number];

export interface Ticket {
  id: string; title: string; description: string; ownerBotId: string | null;
  status: TicketStatus; priority: 'low' | 'normal' | 'high';
  comments: { at: number; author: string; text: string }[];
  createdAt: number; updatedAt: number;
}

export function ensureTicketSchema(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS tickets (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    owner_bot_id TEXT, status TEXT NOT NULL DEFAULT 'todo', priority TEXT NOT NULL DEFAULT 'normal',
    comments TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
}

function row(r: any): Ticket {
  return { id: r.id, title: r.title, description: r.description, ownerBotId: r.owner_bot_id, status: r.status, priority: r.priority, comments: JSON.parse(r.comments), createdAt: r.created_at, updatedAt: r.updated_at };
}

export function createTicket(db: Database.Database, userId: string, input: { title: string; description?: string; ownerBotId?: string | null; priority?: Ticket['priority'] }): Ticket {
  ensureTicketSchema(db);
  const id = newId('tkt');
  const now = Date.now();
  db.prepare(`INSERT INTO tickets(id,user_id,title,description,owner_bot_id,status,priority,comments,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, userId, input.title, input.description ?? '', input.ownerBotId ?? null, 'todo', input.priority ?? 'normal', '[]', now, now);
  return row(db.prepare('SELECT * FROM tickets WHERE id=?').get(id));
}

export function listTickets(db: Database.Database, userId: string): Ticket[] {
  ensureTicketSchema(db);
  return (db.prepare('SELECT * FROM tickets WHERE user_id=? ORDER BY updated_at DESC').all(userId) as any[]).map(row);
}

export function updateTicket(db: Database.Database, userId: string, id: string, patch: { status?: TicketStatus; description?: string; priority?: Ticket['priority']; ownerBotId?: string | null }): Ticket | null {
  ensureTicketSchema(db);
  const existing = db.prepare('SELECT * FROM tickets WHERE id=? AND user_id=?').get(id, userId) as any;
  if (!existing) return null;
  if (patch.status && !TICKET_STATUSES.includes(patch.status)) throw new Error(`unknown status ${patch.status}`);
  const next = {
    status: patch.status ?? existing.status,
    description: patch.description ?? existing.description,
    priority: patch.priority ?? existing.priority,
    owner_bot_id: patch.ownerBotId !== undefined ? patch.ownerBotId : existing.owner_bot_id,
  };
  db.prepare('UPDATE tickets SET status=?, description=?, priority=?, owner_bot_id=?, updated_at=? WHERE id=?')
    .run(next.status, next.description, next.priority, next.owner_bot_id, Date.now(), id);
  return row(db.prepare('SELECT * FROM tickets WHERE id=?').get(id));
}

export function commentTicket(db: Database.Database, userId: string, id: string, author: string, text: string): Ticket | null {
  ensureTicketSchema(db);
  const existing = db.prepare('SELECT * FROM tickets WHERE id=? AND user_id=?').get(id, userId) as any;
  if (!existing) return null;
  const comments = JSON.parse(existing.comments);
  comments.push({ at: Date.now(), author, text: text.slice(0, 2000) });
  db.prepare('UPDATE tickets SET comments=?, updated_at=? WHERE id=?').run(JSON.stringify(comments), Date.now(), id);
  return row(db.prepare('SELECT * FROM tickets WHERE id=?').get(id));
}

import type Database from 'better-sqlite3';
import { LOCAL_SCREEN_IDS } from './local-desktop.js';
import { ensureWorkforceSchema } from './workforce-runtime.js';
import { ensureSidTemplateSchema } from './sid-templates.js';

export function boardSnapshot(db: Database.Database) {
  ensureWorkforceSchema(db);
  ensureSidTemplateSchema(db);
  const tasks = db.prepare('SELECT task_id, sid, status, intent, risk_class, worker_id, uncertain_reason, updated_at FROM workforce_tasks ORDER BY updated_at DESC LIMIT 50').all();
  const identities = db.prepare('SELECT sid, template_slug, kind, parent_sid, status, created_at FROM sid_agents ORDER BY created_at DESC LIMIT 50').all();
  const screens = db.prepare('SELECT bot_id, screen_id FROM screens').all();
  return { tasks, identities, screens, screensAllowed: LOCAL_SCREEN_IDS };
}

// Built Chromium → UAP → isolated SQLite. No production session or model is used.
import assert from 'node:assert/strict';
import { randomBytes, createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';

const temp = await mkdtemp(path.join(os.tmpdir(), 'uap-mcp-browser-'));
const secret = randomBytes(32).toString('hex');
const dbPath = path.join(temp, 'db.sqlite');
const env = { ...process.env, PORT: '0', APP_URL: 'http://localhost', SESSION_SECRET: secret,
  DB_PATH: dbPath, UAP_NO_SCHEDULER: '1', DEV_LOGIN: '0', HQ_LOCAL: '0', HERMES_INHERIT_PRIMARY_CREDENTIALS: '0',
  HERMES_URL: 'http://127.0.0.1:1', HERMES_HOME_PRIMARY: path.join(temp, 'primary'), ENGINES_DIR: path.join(temp, 'agents') };
for (const key of ['COMPOSIO_API_KEY', 'ORGO_API_KEY', 'XAI_API_KEY']) { delete env[key]; delete env[`${key}_FILE`]; }
const child = spawn(process.execPath, ['server/dist/index.js'], { cwd: path.resolve(import.meta.dirname, '..'), env });
const ended = new Promise((resolve) => child.once('close', resolve));
let browser;
try {
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('UAP startup timed out')), 30_000);
    let output = '';
    child.stderr.resume();
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/server on (http:\/\/localhost:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
    child.once('close', (code) => { clearTimeout(timer); reject(new Error(`UAP stopped (${code})`)); });
  });
  const login = await fetch(`${base}/api/auth/owner`, { method: 'POST', headers: {
    authorization: `Bearer ${createHmac('sha256', secret).update('owner-login').digest('hex')}`, 'content-type': 'application/json',
  }, body: JSON.stringify({ email: 'fixture@example.invalid', link: true }), signal: AbortSignal.timeout(10_000) });
  assert.equal(login.status, 200);
  const db = new Database(dbPath);
  try {
    const owner = db.prepare('SELECT id FROM users').get();
    assert.ok(owner);
    db.prepare("INSERT INTO bots (id,user_id,name,engine,created_at,updated_at) VALUES (?,?,'Connector QA','managed',1,1)").run('bot_qa', owner.id);
  } finally { db.close(); }
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}${new URL((await login.json()).url).pathname}`);
  await page.getByText('Connector QA', { exact: true }).first().click();
  const panel = page.getByRole('complementary', { name: 'Conversation details' });
  if (!await panel.isVisible()) await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await panel.getByRole('button', { name: 'Desk', exact: true }).click();
  const section = panel.getByRole('region', { name: 'MCP connectors' });
  const search = section.getByRole('searchbox', { name: 'Search MCP catalog' });
  await search.fill('Notion');
  await section.getByText('OAuth required', { exact: false }).waitFor();
  assert.equal(await section.getByRole('button', { name: 'Add Notion' }).count(), 0);
  await search.fill('DeepWiki');
  await section.getByRole('button', { name: 'Add DeepWiki' }).click();
  await section.getByRole('button', { name: 'Disable deepwiki' }).click();
  await section.getByText('Disabled in settings', { exact: true }).waitFor();
  const saved = await page.evaluate(async () => (await fetch('/api/v6/bots/bot_qa/mcp-servers')).json());
  assert.deepEqual(saved.servers.map(({ name, enabled }) => ({ name, enabled })), [{ name: 'deepwiki', enabled: false }]);
  await section.getByRole('button', { name: 'Remove deepwiki' }).click();
  await section.getByText('No MCP servers saved.').waitFor();
  await section.getByRole('button', { name: 'Add DeepWiki' }).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS: searchable catalog, OAuth gate, and add/disable/remove persist via the real browser and API');
} finally {
  await browser?.close();
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await ended;
  await rm(temp, { recursive: true, force: true });
}

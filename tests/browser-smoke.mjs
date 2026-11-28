// Real local browser → API → SQLite verification; no model or paid-provider calls.
// Build first. CHROMIUM_PATH selects an installed Chromium; defaults to /usr/bin/chromium.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'tests/out/foundation');
const dir = await mkdtemp(path.join(os.tmpdir(), 'uap-browser-'));
const secret = crypto.randomBytes(32).toString('hex');
const primary = path.join(dir, 'primary');
await mkdir(primary);
const sentinel = path.join(primary, 'config.yaml');
await writeFile(sentinel, '# External primary remains unchanged\n');
await mkdir(output, { recursive: true });
const env = { ...process.env, PORT: '0', APP_URL: 'http://localhost:8787', SESSION_SECRET: secret, DEV_LOGIN: '0', UAP_NO_SCHEDULER: '1',
  DB_PATH: path.join(dir, 'app.sqlite'), ENGINES_DIR: path.join(dir, 'engines'), HERMES_HOME_PRIMARY: primary, HERMES_URL: 'http://127.0.0.1:1',
  ALLOWED_EMAILS: '', ORGO_COMPUTER_ID: '', HQ_LOCAL: '0', HERMES_INHERIT_PRIMARY_CREDENTIALS: '0' };
for (const key of ['XAI_API_KEY', 'ORGO_API_KEY', 'COMPOSIO_API_KEY']) { delete env[key]; delete env[`${key}_FILE`]; }
const child = spawn(process.execPath, ['server/dist/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
let serverOutput = '';
const report = { story: 'Owner sign-in link → authenticated UI → persistent agent identity; unconfigured providers remain unavailable.', checks: [], errors: [] };
try {
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${serverOutput}`)), 10000);
    child.stderr.on('data', part => { serverOutput += part; });
    child.stdout.on('data', part => {
      serverOutput += part;
      const match = serverOutput.match(/server on (http:\/\/localhost:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${serverOutput}`)); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const missingAssets = [];
  const providerRequests = [];
  page.on('request', request => { if (/\/api\/(?:voice\/options|apps(?:\?|$))/.test(request.url())) providerRequests.push(request.url()); });
  page.on('response', response => { if (response.status() === 404 && /\.(?:svg|png|js|css)(?:\?|$)/.test(response.url())) missingAssets.push(response.url()); });
  await page.goto(base);
  await page.getByRole('heading', { name: 'Sign in to the console' }).waitFor();
  await page.getByText('Ask your operator for a sign-in link to this workspace.').waitFor();
  assert.equal(await page.getByRole('link', { name: 'Sign in with Google' }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Continue with email' }).count(), 0);
  await page.screenshot({ path: path.join(output, 'signin.png'), fullPage: true });
  report.checks.push('Built UI renders original identity and owner-link instructions; unavailable login providers absent.');
  const key = crypto.createHmac('sha256', secret).update('owner-login').digest('hex');
  const login = await fetch(`${base}/api/auth/owner`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.test', link: true }) });
  assert.equal(login.status, 200);
  const link = new URL((await login.json()).url);
  await page.goto(`${base}${link.pathname}`);
  await page.getByLabel(`Message Doug`, { exact: true }).or(page.getByPlaceholder(/Message Doug/)).first().waitFor({ timeout: 10000 });
  assert.equal(await page.locator('.bot-avatar[data-asset-version="1"]').count() > 0, true);
  const providers = await page.evaluate(async () => (await (await fetch('/api/auth/me')).json()).providers);
  for (const id of ['orgo', 'xai', 'composio']) assert.equal(providers[id].status, 'unconfigured');
  // Calls and dictation must not be selectable without configured xAI.
  assert.equal(await page.getByRole('button', { name: 'Dictate', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Start voice chat with Doug', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('combobox', { name: 'Voice', exact: true }).count(), 0);
  const details = page.getByRole('complementary', { name: 'Conversation details' });
  if (!await details.isVisible()) await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await details.getByRole('button', { name: 'Activity', exact: true }).click();
  await details.getByText('This gateway is managed in Hermes.', { exact: true }).or(details.getByText('Engine unavailable', { exact: true })).first().waitFor();
  assert.equal(await details.getByRole('combobox', { name: 'Provider', exact: true }).count(), 0);
  assert.equal(await details.getByRole('button', { name: 'Restart agent', exact: true }).count(), 0);
  report.checks.push('The primary gateway stays read-only, even when unavailable.');
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  const localCatalog = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/apps');
  await page.getByText('App connection settings', { exact: true }).click();
  await page.getByRole('dialog', { name: 'Connect Apps' }).getByLabel('Search apps').waitFor();
  const apps = await (await localCatalog).json();
  assert.equal(apps.provider, 'local');
  assert.equal(apps.paidFallback, false);
  assert.ok(apps.apps.length > 0, 'the offline connector catalog must contain real entries');
  assert.ok(providerRequests.every((url) => !url.includes('/api/voice/options')), 'Unconfigured voice must not request provider options');
  await page.keyboard.press('Escape');
  report.checks.push('Voice/dictation controls are disabled; the app modal uses the real local catalog without paid fallback.');
  const db = new Database(env.DB_PATH, { readonly: true });
  const before = db.prepare('SELECT id,user_id,engine FROM bots').all();
  assert.equal(before.length, 1);
  assert.equal(before[0].engine, 'primary');
  assert.equal(db.prepare('SELECT owner_user_id FROM deployment_binding').get().owner_user_id, before[0].user_id);
  await page.screenshot({ path: path.join(output, 'owner-workspace.png'), fullPage: true });
  await page.reload();
  await page.getByPlaceholder(/Message Doug/).first().waitFor();
  assert.deepEqual(db.prepare('SELECT id,user_id,engine FROM bots').all(), before);
  db.close();
  report.checks.push('Single-use owner link establishes session and actual SQLite owner/primary profile; reload preserves identity.');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(output, 'owner-mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Mobile layout has horizontal overflow');
  report.checks.push('390px viewport has no document horizontal overflow.');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('.account__btn').click();
  await page.getByText('Use Living Workspace', { exact: true }).click();
  const roster = page.getByRole('complementary', { name: 'Workspace roster' });
  const facets = page.getByRole('navigation', { name: 'Agent workspace' });
  await facets.waitFor();
  assert.equal(await page.locator('aside.sidebar').count(), 1);
  await page.getByRole('heading', { name: 'Doug', exact: true }).waitFor();
  assert.equal(await page.locator('.empty-chat .studio-portrait').count(), 1);
  await page.screenshot({ path: path.join(output, 'living-workspace-desktop.png') });
  await roster.getByRole('textbox', { name: 'Filter agents' }).fill('no fixture matches this');
  await roster.getByText('No agents match that name.').waitFor();
  await roster.getByRole('textbox', { name: 'Filter agents' }).clear();
  await facets.getByRole('button', { name: 'Work' }).click();
  await page.getByRole('heading', { name: 'Work', exact: true }).waitFor();
  await page.getByText(/No tasks yet/).waitFor();
  await facets.getByRole('button', { name: 'Files', exact: true }).click();
  await page.getByRole('heading', { name: 'Files', exact: true }).waitFor();
  await page.getByText(/computer is asleep/).waitFor();
  await facets.getByRole('button', { name: 'Activity', exact: true }).click();
  await page.getByText('No recent activity.').waitFor();
  // Seed a scheduler-disabled routine and an existing transcript event behind the real API.
  const studioDb = new Database(env.DB_PATH);
  const agent = studioDb.prepare('SELECT id,generation FROM bots WHERE id = ?').get(before[0].id);
  const ts = Date.now();
  studioDb.prepare('INSERT INTO routines (id,bot_id,name,prompt,schedule,timezone,enabled,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('studio-fixture-routine', agent.id, 'Workspace digest', 'Private fixture prompt', '0 8 * * *', 'UTC', 1, ts);
  const notice = { type: 'notice', code: 'provider_auth', tone: 'error', text: 'Private fixture notice' };
  studioDb.prepare('INSERT INTO rows (bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(agent.id, agent.generation, 1, 1, 'notice', JSON.stringify(notice), ts);
  studioDb.close();
  await facets.getByRole('button', { name: 'Automations' }).click();
  await page.getByRole('button', { name: 'Pause Workspace digest' }).click();
  await page.getByRole('button', { name: 'Resume Workspace digest' }).waitFor();
  const afterPause = new Database(env.DB_PATH, { readonly: true });
  assert.equal(afterPause.prepare('SELECT enabled FROM routines WHERE id=?').get('studio-fixture-routine').enabled, 0);
  afterPause.close();
  assert.equal(await page.getByText('Private fixture prompt').count(), 0);
  await facets.getByRole('button', { name: 'Chat' }).click();
  await page.getByPlaceholder(/Message Doug/).first().waitFor();
  await page.reload();
  await facets.waitFor();
  assert.equal(await details.getByRole('button', { name: 'Operate', exact: true }).getAttribute('aria-pressed'), 'true');
  await facets.getByRole('button', { name: 'Automations' }).click();
  await page.getByRole('button', { name: 'Resume Workspace digest' }).waitFor();
  await facets.getByRole('button', { name: 'Activity', exact: true }).click();
  await page.getByText('Provider authentication failed', { exact: true }).waitFor();
  assert.equal(await page.getByText('Private fixture notice').count(), 0);
  await facets.getByRole('button', { name: 'Chat' }).click();
  for (const width of [360, 390, 768, 1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByPlaceholder(/Message Doug/).first().waitFor();
    const stage = (await page.locator('.app--studio .chat').boundingBox());
    const header = (await page.locator('.app--studio .chat__header-right').boundingBox());
    assert.ok(stage && stage.width > 0 && stage.x + stage.width <= width + 1, `Stage clipped at ${width}px`);
    assert.ok(header && header.x + header.width <= width + 1, `Header actions clipped at ${width}px`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Document overflow at ${width}px`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  // An open desktop inspector becomes a modal sheet at this width.
  if (await details.isVisible()) await details.getByRole('button', { name: 'Close details', exact: true }).click();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await roster.getByRole('textbox', { name: 'Filter agents' }).waitFor();
  await roster.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.locator('.tasks-view').waitFor();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await roster.getByRole('textbox', { name: 'Filter agents' }).waitFor();
  await roster.getByRole('button', { name: /Doug/ }).click();
  await facets.waitFor();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.keyboard.press('Escape');
  await roster.getByRole('textbox', { name: 'Filter agents' }).waitFor({ state: 'hidden' });
  await page.screenshot({ path: path.join(output, 'living-workspace-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('.account__btn').click();
  await page.getByText('Use classic layout', { exact: true }).click();
  await facets.waitFor({ state: 'hidden' });
  await page.getByPlaceholder(/Message Doug/).first().waitFor();
  report.checks.push('Studio and classic operate: roster filter, Work, Files, original plush, safe Activity projection, real routine pause and reload, and six viewport widths.');
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(missingAssets, []);
  assert.equal(await readFile(sentinel, 'utf8'), '# External primary remains unchanged\n');
  report.checks.push('No browser runtime exceptions or missing bundled assets; external primary configuration unchanged.');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.errors.push(error.message); process.exitCode = 1;
} finally {
  await browser?.close();
  if (child.exitCode === null && !child.signalCode) {
    const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await exited;
  }
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await rm(dir, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
}

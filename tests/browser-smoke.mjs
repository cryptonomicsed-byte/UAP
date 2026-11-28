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

// J-34 UI QA screenshot harness — multi-viewport × theme captures with evidence manifest.
// Unit: node --import tsx --test tests/ui-qa-harness.mjs
// Full browser: npm run test:ui-qa  (needs build + chromium)

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const outRoot = path.join(root, 'tests/out/ui-qa');

export const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
];

export const THEMES = ['light', 'dark'];

export function shotName(viewport, theme, label = 'signin') {
  return `${viewport}__${theme}__${label}.png`;
}

export function buildManifest(entries, meta = {}) {
  return {
    generatedAt: new Date().toISOString(),
    harness: 'j34-ui-qa',
    ...meta,
    shots: entries,
    viewports: VIEWPORTS.map((v) => v.name),
    themes: [...THEMES],
  };
}

export function validateManifest(m) {
  assert.equal(m.harness, 'j34-ui-qa');
  assert.ok(Array.isArray(m.shots));
  assert.ok(m.shots.length >= VIEWPORTS.length * THEMES.length, 'expected 6+ shots');
  for (const s of m.shots) {
    assert.ok(s.file && s.viewport && s.theme);
    assert.ok(s.bytes > 0);
    assert.ok(VIEWPORTS.some((v) => v.name === s.viewport));
    assert.ok(THEMES.includes(s.theme));
  }
}

test('J-34 shotName + manifest shape', () => {
  assert.equal(shotName('mobile', 'dark'), 'mobile__dark__signin.png');
  const m = buildManifest(
    VIEWPORTS.flatMap((v) => THEMES.map((t) => ({
      file: shotName(v.name, t),
      viewport: v.name,
      theme: t,
      bytes: 10,
      width: v.width,
      height: v.height,
    }))),
    { mode: 'unit' },
  );
  validateManifest(m);
  assert.equal(m.shots.length, 6);
});

test('J-34 validateManifest rejects incomplete shot sets', () => {
  assert.throws(() => validateManifest({ harness: 'j34-ui-qa', shots: [] }));
});

export async function runBrowserHarness() {
  const { chromium } = await import('playwright');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uap-uiqa-'));
  const secret = crypto.randomBytes(32).toString('hex');
  const primary = path.join(dir, 'primary');
  await mkdir(primary);
  await writeFile(path.join(primary, 'config.yaml'), '# fixture\n');
  await mkdir(outRoot, { recursive: true });

  const serverDist = path.join(root, 'server/dist/index.js');
  assert.ok(existsSync(serverDist), 'server/dist missing — run npm run build first');

  const env = {
    ...process.env,
    PORT: '0',
    APP_URL: 'http://localhost:8787',
    SESSION_SECRET: secret,
    DEV_LOGIN: '0',
    UAP_NO_SCHEDULER: '1',
    DB_PATH: path.join(dir, 'app.sqlite'),
    ENGINES_DIR: path.join(dir, 'engines'),
    HERMES_HOME_PRIMARY: primary,
    HERMES_URL: 'http://127.0.0.1:1',
    ALLOWED_EMAILS: '',
    ORGO_COMPUTER_ID: '',
    HQ_LOCAL: '0',
  };
  for (const key of ['XAI_API_KEY', 'ORGO_API_KEY', 'COMPOSIO_API_KEY']) {
    delete env[key];
    delete env[`${key}_FILE`];
  }

  const child = spawn(process.execPath, [serverDist], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverOutput = '';
  let browser;
  try {
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`startup timeout: ${serverOutput}`)), 15000);
      child.stderr.on('data', (p) => { serverOutput += p; });
      child.stdout.on('data', (p) => {
        serverOutput += p;
        const m = serverOutput.match(/server on (http:\/\/localhost:\d+)/);
        if (m) { clearTimeout(timer); resolve(m[1]); }
      });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`exit ${code}: ${serverOutput}`)); });
    });

    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
      headless: true,
      args: ['--no-sandbox'],
    });

    const entries = [];
    for (const vp of VIEWPORTS) {
      for (const theme of THEMES) {
        const context = await browser.newContext({
          viewport: { width: vp.width, height: vp.height },
          colorScheme: theme === 'dark' ? 'dark' : 'light',
          reducedMotion: 'reduce',
        });
        const page = await context.newPage();
        const pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(e.message));

        await page.goto(base, { waitUntil: 'networkidle' });
        await page.evaluate((t) => {
          document.documentElement.setAttribute('data-theme', t);
        }, theme);

        await page.getByRole('heading', { name: 'Universal Agent Platform' }).waitFor({ timeout: 10000 });

        const file = shotName(vp.name, theme, 'signin');
        const dest = path.join(outRoot, file);
        await page.screenshot({ path: dest, fullPage: true });
        const buf = await readFile(dest);

        const a11y = await page.evaluate(() => {
          const h = document.querySelector('h1, [role="heading"]');
          const buttons = [...document.querySelectorAll('button, a, [role="button"]')];
          const tiny = buttons.filter((b) => {
            const r = b.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && (r.width < 24 || r.height < 24);
          }).length;
          return { hasHeading: !!h, controlCount: buttons.length, tinyTargets: tiny };
        });

        assert.equal(pageErrors.length, 0, `page errors on ${vp.name}/${theme}: ${pageErrors.join('; ')}`);
        assert.ok(a11y.hasHeading, 'missing heading');
        assert.ok(buf.length > 500, 'screenshot too small');

        entries.push({
          file,
          viewport: vp.name,
          theme,
          width: vp.width,
          height: vp.height,
          bytes: buf.length,
          sha256: crypto.createHash('sha256').update(buf).digest('hex'),
          a11y,
        });
        await context.close();
      }
    }

    const manifest = buildManifest(entries, {
      mode: 'browser',
      baseUrlHost: new URL(base).host,
      reducedMotion: true,
    });
    validateManifest(manifest);
    await writeFile(path.join(outRoot, 'manifest.json'), JSON.stringify(manifest, null, 2));
    return { ok: true, shots: entries.length, out: outRoot, manifest };
  } finally {
    await browser?.close().catch(() => {});
    child.kill('SIGTERM');
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.env.UI_QA_BROWSER === '1') {
  runBrowserHarness()
    .then((r) => { console.log(JSON.stringify(r)); })
    .catch((e) => { console.error(e); process.exit(1); });
}

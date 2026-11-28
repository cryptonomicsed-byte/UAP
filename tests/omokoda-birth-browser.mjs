// Browser regression for the public handoff URL. API calls are fixture-only.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const resolveWeb = createRequire(new URL('../web/package.json', import.meta.url));
const { createServer } = await import(pathToFileURL(resolveWeb.resolve('vite')).href);

const vite = await createServer({ root: 'web', server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
let browser;
try {
  await vite.listen();
  const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  const requests = [];
  let signedIn = false;
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (p === '/api/auth/me') return route.fulfill({ json: { user: signedIn ? { id: 'qa', email: 'qa@example.invalid', name: 'QA' } : null, devLogin: false, googleLogin: false, providers: {} } });
    if (p === '/api/bots') return route.fulfill({ json: { bots: [], live: [] } });
    if (p === '/api/v6/sid/omokoda/birth') {
      requests.push([req.headers()['idempotency-key'], req.postDataJSON()]);
      if (requests.length === 1) return route.fulfill({ status: 503, json: { error: 'Birth unconfirmed' } });
      return route.fulfill({ json: { botId: 'bot_qa', sid: 'sid_test', vantage: { status: 'failed' } } });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto(`${base}/?birth=omokoda`);
  await page.getByRole('heading', { name: 'Sign in to the console' }).waitFor();
  const dialog = page.getByRole('dialog', { name: 'Create an Omokoda agent' });
  assert.equal(await dialog.count(), 0);
  assert.equal(requests.length, 0);
  signedIn = true;
  // The OAuth/link callback redirects to the root without the original query.
  await page.goto(base);
  await dialog.getByLabel('Agent name').fill('QA Agent');
  assert.equal(requests.length, 0);
  await dialog.getByRole('button', { name: 'Create agent' }).click();
  await dialog.getByRole('alert').filter({ hasText: 'Birth unconfirmed' }).waitFor();
  await page.reload();
  await dialog.getByRole('button', { name: 'Check same request' }).click();
  await dialog.getByText('Agent created in this UAP workspace.').waitFor();
  await dialog.getByText(/Vantage registration could not be confirmed/).waitFor();
  assert.equal(requests.length, 2);
  assert.match(requests[0][0], /^[0-9a-f-]{36}$/);
  assert.deepEqual(requests[0], requests[1]);
  assert.deepEqual(requests[1][1], { name: 'QA Agent', register: true });
  await dialog.getByRole('button', { name: 'Done' }).click();
  assert.equal(new URL(page.url()).searchParams.has('birth'), false);
  await page.reload();
  await page.getByRole('button', { name: 'Create a Bot', exact: false }).waitFor();
  assert.equal(await dialog.count(), 0);
  console.log('Chromium: sign-in redirect, explicit creation, retry after reload, and dismissed handoff passed');
} finally {
  await browser?.close();
  await vite.close();
}

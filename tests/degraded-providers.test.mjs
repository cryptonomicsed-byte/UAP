import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

/**
 * V6-07-10: a degraded model/tool provider must fail honestly.
 *  - no implicit retry and no other provider/model is tried (one request, no fallback),
 *  - the failure reaches the transcript as a classified notice (code + whether retrying helps),
 *  - provider detail is sanitized: no credentials, no raw HTML bodies,
 *  - a tool provider failure rejects the tool call instead of pretending it succeeded.
 */
async function scenario(script) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uap-degraded-provider-'));
  const env = {
    ...process.env, SESSION_SECRET: 'degraded-provider-test-only', DB_PATH: path.join(dir, 'app.sqlite'),
    HERMES_HOME_PRIMARY: path.join(dir, 'primary'), ENGINES_DIR: path.join(dir, 'managed'),
    HQ_LOCAL: '0', ORGO_COMPUTER_ID: '', HERMES_KEY: '', FIXTURE_ROOT: dir,
  };
  for (const key of ['XAI_API_KEY', 'COMPOSIO_API_KEY', 'ORGO_API_KEY']) {
    delete env[key]; delete env[`${key}_FILE`];
  }
  const preamble = `
    import assert from 'node:assert/strict';
    import { createServer } from 'node:http';
    import { once } from 'node:events';
    import { db } from './server/src/db.ts';
    import { env } from './server/src/env.ts';
    db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('owner', 'owner@example.test', 'Owner', 1);
    db.prepare('INSERT INTO bots(id,user_id,name,engine,model,provider,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run('bot_primary', 'owner', 'Owner Agent', 'primary', null, null, 1, 1);
    const engine = await import('./server/src/engine.ts');
    const loop = await import('./server/src/agent/loop.ts');
    const NL = String.fromCharCode(10);
    let mode = 'ok';
    const requests = [];
    const gateway = createServer(async (req, res) => {
      if (req.url === '/health') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ status: 'ok', version: 'fixture-version' })); return; }
      if (req.url === '/api/model/options') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ model: 'fixture-model', provider: 'fixture-provider', providers: [] })); return; }
      if (req.url === '/v1/responses' && req.method === 'POST') {
        let raw = ''; for await (const chunk of req) raw += chunk;
        requests.push({ body: JSON.parse(raw), mode });
        if (mode === 'rate') {
          res.statusCode = 429; res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: { code: 'provider_rate_limited', message: 'xai: rate limit reached; retry after 20s' } })); return;
        }
        if (mode === 'auth') {
          res.statusCode = 401; res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'the api key provided is invalid' })); return;
        }
        if (mode === 'html') {
          res.statusCode = 502; res.setHeader('content-type', 'text/html');
          res.end('<html><body>bad gateway upstream LEAKMARK123</body></html>'); return;
        }
        res.setHeader('content-type', 'text/event-stream');
        if (mode === 'stream-fail') {
          res.end(['event: response.failed', 'data: ' + JSON.stringify({ response: { error: { code: 'provider_unavailable', message: 'xai upstream 500 key=LEAKMARK123' } } }), '', ''].join(NL)); return;
        }
        if (mode === 'context') {
          res.end(['event: error', 'data: ' + JSON.stringify({ error: { code: 'context_length_exceeded', message: 'maximum context length is 128000 tokens' } }), '', ''].join(NL)); return;
        }
        res.end(['event: response.output_text.delta', 'data: ' + JSON.stringify({ delta: 'fixture answer' }), '', ''].join(NL));
        return;
      }
      res.statusCode = 404; res.end();
    });
    gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
    env.hermesUrl = 'http://127.0.0.1:' + gateway.address().port;
    const notices = () => db.prepare("SELECT body FROM rows WHERE bot_id=? AND kind='notice' ORDER BY seq").all('bot_primary').map(r => JSON.parse(r.body));
    const turn = async (text) => { loop.enqueue('bot_primary', { type: 'user', text }); await loop.runInBotQueue('bot_primary', async () => {}); };
    try {
  `;
  const suffix = `
    } finally { gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); }
  `;
  try {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', preamble + script + suffix], {
      cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    assert.equal(code, 0, output);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('model provider failures become classified notices; one request, no fallback, no leaked detail', { timeout: 40000 }, async () => {
  await scenario(`
    mode = 'rate';
    await turn('rate limited request'); mode = 'auth';
    await turn('unauthorized request'); mode = 'html';
    await turn('bad gateway request'); mode = 'stream-fail';
    await turn('stream failure request'); mode = 'context';
    await turn('context overflow request'); mode = 'ok';
    await turn('healthy request');

    assert.equal(requests.length, 6, 'one engine request per turn: no retry, no second provider');
    for (const request of requests) {
      assert.equal(request.body.model, 'hermes-agent');
      assert.equal(Object.hasOwn(request.body, 'provider'), false);
    }

    const list = notices();
    assert.equal(list.length, 5, JSON.stringify(list));
    const byCode = Object.fromEntries(list.map(n => [n.code, n]));
    assert.deepEqual(Object.keys(byCode).sort(), ['context_length', 'engine_auth', 'provider_rate_limited', 'provider_unavailable'].sort());
    for (const notice of list) {
      assert.equal(notice.tone, 'error');
      assert.equal(typeof notice.retryable, 'boolean');
      assert.ok(notice.text.length > 20 && notice.text.length <= 320, notice.text);
      assert.ok(!/LEAKMARK123|<html|error\\\\?:/i.test(notice.text), 'raw provider detail must not reach the notice: ' + notice.text);
      assert.ok(!/Something went wrong/i.test(notice.text), 'a classified failure is named, not generic');
    }
    assert.equal(byCode.provider_rate_limited.retryable, true);
    assert.match(byCode.provider_rate_limited.text, /rate limit/i);
    assert.equal(byCode.engine_auth.retryable, false);
    assert.match(byCode.engine_auth.text, /key|credential/i);
    assert.equal(byCode.provider_unavailable.retryable, true);
    assert.match(byCode.provider_unavailable.text, /provider|unavailable|failed/i);
    assert.equal(byCode.context_length.retryable, false);
    assert.match(byCode.context_length.text, /context|too long/i);
  `);
});

test('an unreachable gateway is reported as such instead of a generic turn failure', { timeout: 30000 }, async () => {
  await scenario(`
    gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve));
    env.hermesUrl = 'http://127.0.0.1:1';
    await turn('gateway is down');
    const list = notices();
    assert.equal(list.length, 1, JSON.stringify(list));
    assert.equal(list[0].code, 'engine_unreachable');
    assert.equal(list[0].retryable, true);
    assert.match(list[0].text, /gateway|not reachable|not answering/i);
    assert.ok(!/ECONNREFUSED|127\\\\.0\\\\.0\\\\.1:1/.test(list[0].text), 'no raw socket detail: ' + list[0].text);
  `);
});

test('a configured tool provider that fails rejects the call with a sanitized, actionable error and no fallback', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uap-tool-failure-'));
  try {
    const script = `
      import assert from 'node:assert/strict';
      const calls = [];
      globalThis.fetch = async (url) => {
        calls.push(String(url));
        return new Response('upstream exploded key=LEAKMARK123 <html>', { status: 500 });
      };
      const { toolMap } = await import('./server/src/agent/tools.ts');
      const error = await toolMap.get('x_search').impl({ query: 'anything' }, {}).then(() => null, e => e);
      assert.ok(error, 'a failed provider call must reject, never return a made-up answer');
      assert.match(error.message, /HTTP 500|500/);
      assert.ok(!/LEAKMARK123|<html/.test(error.message), 'provider detail must be sanitized: ' + error.message);
      assert.equal(calls.length, 1, 'exactly one provider attempt: no implicit retry or fallback');
      globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
      const down = await toolMap.get('x_search').impl({ query: 'anything' }, {}).then(() => null, e => e);
      assert.ok(down, 'a network failure must reject');
      assert.match(down.message, /xAI|X search|reach|respond|network/i);
      assert.ok(!/fetch failed/.test(down.message), 'the raw fetch error is not the user-facing message');
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: root, env: {
        ...process.env, SESSION_SECRET: 'tool-failure-test-only', DB_PATH: path.join(dir, 'app.sqlite'),
        HERMES_HOME_PRIMARY: path.join(dir, 'hermes'), HQ_LOCAL: '0', XAI_API_KEY: 'configured-fixture-key',
      }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000,
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    assert.equal(code, 0, output);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the UI maps every failure code to a truthful hint and never a generic apology', async () => {
  const { noticeView } = await import('../web/src/lib/notices.ts');
  const retryable = ['engine_unreachable', 'provider_rate_limited', 'provider_unavailable', 'timeout'];
  const notRetryable = ['engine_auth', 'provider_auth', 'provider_billing', 'model_unavailable', 'context_length', 'run_failed'];
  for (const code of [...retryable, ...notRetryable]) {
    const body = { type: 'notice', text: 'The provider failed.', tone: 'error', code, retryable: retryable.includes(code) };
    const view = noticeView(body);
    assert.equal(view.tone, 'error');
    assert.equal(view.code, code);
    assert.equal(view.text, 'The provider failed.', 'the server-owned explanation is shown verbatim');
    assert.ok(!/Something went wrong/i.test(view.text));
    if (retryable.includes(code)) assert.match(view.hint, /try again/i, code);
    else assert.equal(view.hint, null, code + ' must not promise that retrying helps');
  }
  for (const code of ['engine_auth', 'provider_billing', 'model_unavailable', 'context_length']) {
    const view = noticeView({ type: 'notice', text: 'x', tone: 'error', code, retryable: true });
    assert.equal(view.hint, null, code + ' is not fixed by retrying, whatever the flag says');
  }
  const plain = noticeView({ type: 'notice', text: 'Stopped.', tone: 'info' });
  assert.deepEqual(plain, { tone: 'info', text: 'Stopped.', code: null, hint: null });
});

// The deletion request is only real if the HTTP surface enforces ownership and reports honest states.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, before, after } from 'node:test';
import Database from 'better-sqlite3';

const root = path.resolve(import.meta.dirname, '..');
const dir = await mkdtemp(path.join(os.tmpdir(), 'uap-privacy-api-'));
const secret = 'privacy-api-secret';
const ownerKey = crypto.createHmac('sha256', secret).update('owner-login').digest('hex');
const env = () => {
  const variables = {
    ...process.env, SESSION_SECRET: secret, PORT: '0', UAP_NO_SCHEDULER: '1', GROKBOT_NO_SCHEDULER: '1',
    DB_PATH: path.join(dir, 'app.sqlite'), ENGINES_DIR: path.join(dir, 'engines'),
    HERMES_HOME_PRIMARY: path.join(dir, 'primary'), DEV_LOGIN: '0', ALLOWED_EMAILS: '',
  };
  for (const key of ['XAI_API_KEY', 'ORGO_API_KEY', 'COMPOSIO_API_KEY']) { delete variables[key]; delete variables[`${key}_FILE`]; }
  return variables;
};

let server;
let base;
let cookie;
let botId;

before(async () => {
  await mkdir(path.join(dir, 'primary', 'memories'), { recursive: true });
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], { cwd: root, env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  base = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`server startup timed out: ${output}`)), 30000);
    const onData = (part) => {
      output += part;
      const match = output.match(/server on (http:\/\/localhost:\d+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`server exited ${code}: ${output}`)); });
  });
  server = child;

  const login = await fetch(`${base}/api/auth/owner`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.test' }),
  });
  assert.equal(login.status, 200, await login.text());
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  assert.match(cookie, /^[^=]+=/);

  const roster = await (await fetch(`${base}/api/bots`, { headers: { cookie } })).json();
  botId = roster.bots[0].id;

  // Real content in the agent's memory home, transcript and approval audit trail.
  await writeFile(path.join(dir, 'primary', 'memories', 'MEMORY.md'), 'Prefers oat milk\n');
  const db = new Database(env().DB_PATH);
  db.pragma('journal_mode = WAL');
  db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(botId, 1, 1, 1, 'message', JSON.stringify({ type: 'message', role: 'user', text: 'call me Aino' }), 10);
  db.prepare('INSERT INTO approvals(id,bot_id,row_seq,call_id,tool,status,created_at) VALUES (?,?,?,?,?,?,?)')
    .run('apr-api', botId, 1, 'call-api', 'composio.gmail.send', 'allowed', 11);
  db.close();
});

after(async () => {
  if (server && server.exitCode === null && !server.signalCode) {
    const ended = new Promise((resolve) => server.once('exit', resolve));
    server.kill('SIGTERM');
    await ended;
  }
  await rm(dir, { recursive: true, force: true });
});

const call = (pathname, init = {}) => fetch(`${base}/api${pathname}`, {
  ...init, headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) },
});

test('memory search is served from the derived index and a single delete propagates into it', async () => {
  const found = await (await call(`/bots/${botId}/memories?q=oat`)).json();
  assert.equal(found.memories.length, 1);
  assert.match(found.memories[0].text, /oat/i);

  await writeFile(path.join(dir, 'primary', 'memories', 'MEMORY.md'), 'Prefers oat milk\n§\nOwns a red kayak\n');
  const all = await (await call(`/bots/${botId}/memories`)).json();
  const kayak = all.memories.find((memory) => /kayak/.test(memory.text));
  assert.ok(kayak);
  assert.equal((await call(`/memories/${encodeURIComponent(kayak.id)}`, { method: 'DELETE' })).status, 200);
  const gone = await (await call(`/bots/${botId}/memories?q=kayak`)).json();
  assert.deepEqual(gone.memories, []);
});

test('POST /privacy/deletions runs the propagation and GET verifies the receipt', async () => {
  const created = await call('/privacy/deletions', {
    method: 'POST', body: JSON.stringify({ botId, basis: 'user_request', requestKey: 'api-request-1' }),
  });
  const body = await created.json();
  assert.equal(created.status, 200, JSON.stringify(body));
  assert.equal(body.request.state, 'completed');
  assert.ok(body.request.targets.some((target) => target.holder === 'memory' && target.state === 'done'));
  assert.ok(body.request.targets.some((target) => target.holder === 'evidence' && target.state === 'retained'));

  const one = await (await call(`/privacy/deletions/${body.request.id}`)).json();
  assert.equal(one.request.id, body.request.id);
  assert.equal(one.receiptVerified, true);
  assert.deepEqual(one.request.targets.filter((target) => target.holder === 'evidence').map((target) => target.exceptionRule),
    one.request.targets.filter((target) => target.holder === 'evidence').map(() => 'audit:approval_history'));

  const after = await (await call(`/bots/${botId}/memories?q=oat`)).json();
  assert.deepEqual(after.memories, [], 'memory search cannot return erased content');

  const listed = await (await call(`/privacy/deletions?botId=${botId}`)).json();
  assert.ok(listed.requests.some((request) => request.id === body.request.id));

  const repeated = await call('/privacy/deletions', {
    method: 'POST', body: JSON.stringify({ botId, basis: 'user_request', requestKey: 'api-request-1' }),
  });
  assert.equal((await repeated.json()).request.id, body.request.id, 'idempotency key returns the same request');
});

test('the API rejects a bad basis, a missing subject and a request key reused for another subject', async () => {
  const badBasis = await call('/privacy/deletions', { method: 'POST', body: JSON.stringify({ botId, basis: 'curiosity' }) });
  assert.equal(badBasis.status, 400);

  const missing = await call('/privacy/deletions', { method: 'POST', body: JSON.stringify({ botId: 'bot_nope', basis: 'user_request' }) });
  assert.equal(missing.status, 404);

  const created = await call('/bots', { method: 'POST', body: JSON.stringify({ name: 'Second agent' }) });
  const second = (await created.json()).bot;
  assert.ok(second?.id, JSON.stringify(second));
  const conflict = await call('/privacy/deletions', {
    method: 'POST', body: JSON.stringify({ botId: second.id, basis: 'user_request', requestKey: 'api-request-1' }),
  });
  assert.equal(conflict.status, 409);

  const unknown = await call('/privacy/deletions/privacy_missing');
  assert.equal(unknown.status, 404);
});

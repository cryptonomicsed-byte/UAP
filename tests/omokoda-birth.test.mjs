import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureSidTemplateSchema } from '../server/src/lib/sid-templates.ts';
import { actingHashLegacy, sidHashLegacy, verifySidLegacy } from '../server/src/identity/sid-legacy.ts';
import {
  birthAndRegister,
  birthOmokodaGuest,
  getOmokodaBirth,
  thinkOmokodaGuest,
  OmokodaBirthError,
} from '../server/src/lib/omokoda-birth.ts';

const KERNEL_KEY = 'KERNEL-SECRET-7f3a9c2e';
const VANTAGE_KEY = 'VANTAGE-SECRET-91bd44ef';

function serve(handler, { managed = true } = {}) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/v1/health') return res.end(JSON.stringify({ ok: true, ...(managed ? { uap_managed_birth: 1 } : {}) }));
      return handler(req, res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

function nativeSid() {
  const sid = {
    format: 'sid/0.1', id: 'sid_guest-ada-01', status: 'cast', version: 1, previous_version: null, previous_hash: 'none',
    born_at: '2026-11-28T12:00:00Z',
    identity: { name: 'Ada', type: 'agent', odu_primary: 7, odu_secondary: 11, odu_link: 1803 },
    appendix: { agent_id: 'guest-ada-01' },
  };
  sid.acting_hash = actingHashLegacy(sid);
  sid.hash = sidHashLegacy(sid);
  return sid;
}

function kernelHandler(status = 200) {
  return (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      kernelHandler.last = { url: req.url, method: req.method, body: JSON.parse(body || '{}') };
      if (status !== 200) {
        res.writeHead(status, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'refused' }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ managed: true, agent_id: 'guest-ada-01', agent_key: KERNEL_KEY, sid_document: nativeSid() }));
    });
  };
}

function db() {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE bots (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, label TEXT, description TEXT,
      instructions TEXT, avatar_shape TEXT, avatar_color TEXT, mode TEXT, is_primary INTEGER,
      effort TEXT, parent_bot_id TEXT, hidden INTEGER, sid TEXT, kind TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  ensureSidTemplateSchema(database);
  return database;
}

function fresh(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omk-birth-'));
  process.env.OMOKODA_KEY_DIR = dir;
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.OMOKODA_URL;
    delete process.env.VANTAGE_URL;
    delete process.env.OMOKODA_KEY_DIR;
  });
  return dir;
}

test('birth mints a verified SID and stores the kernel key only as a 0600 file', async (t) => {
  const dir = fresh(t);
  const { server, url } = await serve(kernelHandler());
  t.after(() => server.close());
  process.env.OMOKODA_URL = url;
  const database = db();

  const born = await birthOmokodaGuest(database, { userId: 'tenant-a', name: 'Ada' });

  assert.equal(kernelHandler.last.url, '/v1/birth');
  assert.equal(kernelHandler.last.body.name, 'Ada');
  assert.match(born.sid, /^sid_omokoda-guest-[0-9a-f]{6}$/);
  assert.equal(born.kernelAgentId, 'guest-ada-01');
  assert.equal(database.prepare('SELECT name FROM bots WHERE id=?').get(born.botId).name, 'Ada');
  assert.match(born.genesisHash, /^[0-9a-f]{64}$/);

  const row = database.prepare('SELECT sid, document_json FROM sid_agents WHERE sid=?').get(born.sid);
  assert.ok(row, 'SID row written');
  const document = JSON.parse(row.document_json);
  assert.equal(verifySidLegacy(document).ok, true, 'SID certificate verifies');
  assert.equal(document.provenance.omokoda_birth_hash, born.genesisHash);
  document.provenance.omokoda_birth_hash = 'f'.repeat(64);
  assert.equal(verifySidLegacy(document).ok, false, 'certificate hash covers the birth commitment');

  const keyFile = path.join(dir, `${born.botId}.omokoda.key`);
  assert.equal(fs.readFileSync(keyFile, 'utf8').trim(), KERNEL_KEY);
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
});

test('the kernel key never appears in the database, the SID document, or the API read', async (t) => {
  fresh(t);
  const { server, url } = await serve(kernelHandler());
  t.after(() => server.close());
  process.env.OMOKODA_URL = url;
  const database = db();

  const result = await birthAndRegister(database, { userId: 'tenant-a', name: 'Ada', register: false });
  const everything = [
    JSON.stringify(result),
    JSON.stringify(database.prepare('SELECT * FROM bots').all()),
    JSON.stringify(database.prepare('SELECT * FROM sid_agents').all()),
    JSON.stringify(database.prepare('SELECT * FROM omokoda_births').all()),
    JSON.stringify(getOmokodaBirth(database, result.botId, 'tenant-a')),
  ].join('\n');
  assert.equal(everything.includes(KERNEL_KEY), false, 'kernel key leaked');
  assert.deepEqual(getOmokodaBirth(database, result.botId, 'tenant-a').secrets, { omokoda: true, vantage: false });
  assert.equal(getOmokodaBirth(database, result.botId, 'tenant-b'), null, 'another tenant cannot read this birth');
  database.prepare('DELETE FROM bots WHERE id=?').run(result.botId);
  assert.equal(getOmokodaBirth(database, result.botId, 'tenant-a'), null, 'orphaned birth is not addressable');
});

test('an unreachable kernel fails closed: no bot and no SID are created', async (t) => {
  fresh(t);
  process.env.OMOKODA_URL = 'http://127.0.0.1:1';
  const database = db();
  await assert.rejects(
    birthOmokodaGuest(database, { userId: 'tenant-a', name: 'Ada' }),
    (e) => e instanceof OmokodaBirthError && e.code === 'kernel-unreachable',
  );
  assert.equal(database.prepare('SELECT COUNT(*) n FROM bots').get().n, 0);
  assert.equal(database.prepare('SELECT COUNT(*) n FROM sid_agents').get().n, 0);
});

test('a kernel refusal is reported with its status and mints nothing', async (t) => {
  fresh(t);
  const { server, url } = await serve(kernelHandler(403));
  t.after(() => server.close());
  process.env.OMOKODA_URL = url;
  const database = db();
  await assert.rejects(
    birthOmokodaGuest(database, { userId: 'tenant-a', name: 'Ada' }),
    (e) => e.code === 'kernel-rejected' && /HTTP 403/.test(e.message),
  );
  assert.equal(database.prepare('SELECT COUNT(*) n FROM bots').get().n, 0);
});

test('a malformed kernel response is refused rather than half-accepted', async (t) => {
  fresh(t);
  const { server, url } = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'born' }));
  });
  t.after(() => server.close());
  process.env.OMOKODA_URL = url;
  await assert.rejects(
    birthOmokodaGuest(db(), { userId: 'tenant-a', name: 'Ada' }),
    (e) => e.code === 'kernel-malformed',
  );
});

test('a name outside 1-64 characters is rejected before any call is made', async (t) => {
  fresh(t);
  await assert.rejects(birthOmokodaGuest(db(), { userId: 'tenant-a', name: '   ' }), (e) => e.code === 'name');
});

test('Vantage registration stores its key as a file and records the result', async (t) => {
  const dir = fresh(t);
  const kernel = await serve(kernelHandler());
  t.after(() => kernel.server.close());
  const vantage = await serve((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      vantage.last = { url: req.url, body: JSON.parse(body) };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ api_key: VANTAGE_KEY, agent_id: 42 }));
    });
  });
  t.after(() => vantage.server.close());
  process.env.OMOKODA_URL = kernel.url;
  process.env.VANTAGE_URL = vantage.url;
  const database = db();

  const result = await birthAndRegister(database, { userId: 'tenant-a', name: 'Ada' });

  assert.equal(vantage.last.url, '/api/agents/register');
  assert.equal(vantage.last.body.name, 'Ada');
  assert.deepEqual(result.vantage, { status: 'registered', vantageAgentId: '42' });
  assert.equal(fs.readFileSync(path.join(dir, `${result.botId}.vantage.key`), 'utf8').trim(), VANTAGE_KEY);
  const row = database.prepare('SELECT vantage_status, vantage_agent_id FROM omokoda_births WHERE bot_id=?').get(result.botId);
  assert.deepEqual({ ...row }, { vantage_status: 'registered', vantage_agent_id: '42' });
  assert.equal(JSON.stringify(row).includes(VANTAGE_KEY), false);
});

test('a Vantage failure is reported and the birth still stands', async (t) => {
  fresh(t);
  const kernel = await serve(kernelHandler());
  t.after(() => kernel.server.close());
  process.env.OMOKODA_URL = kernel.url;
  process.env.VANTAGE_URL = 'http://127.0.0.1:1';
  const database = db();
  const result = await birthAndRegister(database, { userId: 'tenant-a', name: 'Ada' });
  assert.equal(result.vantage.status, 'failed');
  assert.equal(database.prepare('SELECT COUNT(*) n FROM sid_agents').get().n, 1);
});

test('a request key is tenant scoped, rejects conflicting input, and replays a completed birth', async (t) => {
  fresh(t);
  let kernelCalls = 0;
  const kernel = await serve((req, res) => {
    kernelCalls++;
    kernelHandler()(req, res);
  });
  t.after(() => kernel.server.close());
  process.env.OMOKODA_URL = kernel.url;
  const database = db();
  const input = { userId: 'tenant-a', name: 'Ada', register: false, requestKey: 'create-ada-1' };
  const pending = birthAndRegister(database, input);
  await assert.rejects(birthAndRegister(database, input), (e) => e.code === 'birth-unresolved');
  const first = await pending;
  const replay = await birthAndRegister(database, input);
  assert.deepEqual(replay, first);
  await assert.rejects(birthAndRegister(database, { ...input, name: 'Other' }), (e) => e.code === 'birth-conflict');
  assert.equal(kernelCalls, 1);
  assert.notEqual((await birthAndRegister(database, { ...input, userId: 'tenant-b' })).botId, first.botId);
  assert.equal(kernelCalls, 2);
});

test('an ambiguous kernel response does not allow a second birth with the same key', async (t) => {
  fresh(t);
  let kernelCalls = 0;
  const kernel = await serve((_req, res) => {
    kernelCalls++;
    res.end('{}');
  });
  t.after(() => kernel.server.close());
  process.env.OMOKODA_URL = kernel.url;
  const database = db();
  const input = { userId: 'tenant-a', name: 'Ada', requestKey: 'ambiguous-ada-1' };
  await assert.rejects(birthAndRegister(database, input), (e) => e.code === 'kernel-malformed');
  await assert.rejects(birthAndRegister(database, input), (e) => e.code === 'birth-unresolved');
  assert.equal(kernelCalls, 1);
});

test('old kernels are refused before posting a birth', async (t) => {
  fresh(t);
  let writes = 0;
  const kernel = await serve((_req, res) => { writes++; res.end(); }, { managed: false });
  t.after(() => kernel.server.close());
  process.env.OMOKODA_URL = kernel.url;
  await assert.rejects(birthOmokodaGuest(db(), { userId: 'tenant-a', name: 'Ada' }), (e) => e.code === 'kernel-not-managed');
  assert.equal(writes, 0);
});

test('a confirmed preflight refusal permits the same request after upgrade', async (t) => {
  fresh(t);
  const old = await serve(() => assert.fail('old kernel received a birth'), { managed: false });
  const current = await serve(kernelHandler());
  t.after(() => { old.server.close(); current.server.close(); });
  const database = db();
  const input = { userId: 'tenant-a', name: 'Ada', register: false, requestKey: 'preflight-ada' };
  process.env.OMOKODA_URL = old.url;
  await assert.rejects(birthAndRegister(database, input), (e) => e.code === 'kernel-not-managed');
  process.env.OMOKODA_URL = current.url;
  const born = await birthAndRegister(database, input);
  assert.deepEqual(await birthAndRegister(database, input), born);
});

test('credential persistence failure cannot publish a bot with no managed binding', async (t) => {
  const dir = fresh(t);
  const kernel = await serve(kernelHandler());
  t.after(() => kernel.server.close());
  process.env.OMOKODA_URL = kernel.url;
  process.env.OMOKODA_KEY_DIR = path.join(dir, 'not-a-directory');
  fs.writeFileSync(process.env.OMOKODA_KEY_DIR, 'fixture');
  const database = db();
  await assert.rejects(birthOmokodaGuest(database, { userId: 'tenant-a', name: 'Ada' }));
  for (const table of ['bots', 'sid_agents', 'omokoda_births', 'omokoda_managed_runtime']) {
    assert.equal(database.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0, table);
  }
});

test('managed workspace turns send only authenticated non-agentic cognition', async (t) => {
  fresh(t);
  const kernel = await serve((req, res) => {
    if (req.url === '/v1/birth') return kernelHandler()(req, res);
    assert.equal(req.url, '/v1/think');
    assert.equal(req.headers['x-agent-key'], KERNEL_KEY);
    assert.equal(req.headers['x-agent-id'], 'guest-ada-01');
    let body = '';
    req.on('data', (part) => { body += part; });
    req.on('end', () => {
      assert.deepEqual(JSON.parse(body), { prompt: 'Hello', agentic: false });
      res.end(JSON.stringify({ tool_output: 'Hello from the kernel' }));
    });
  });
  t.after(() => kernel.server.close());
  process.env.OMOKODA_URL = kernel.url;
  const database = db();
  const born = await birthOmokodaGuest(database, { userId: 'tenant-a', name: 'Ada' });
  const row = getOmokodaBirth(database, born.botId, 'tenant-a');
  assert.equal(row.kernel_sid_hash, nativeSid().hash);
  assert.equal(await thinkOmokodaGuest(database, { botId: born.botId, userId: 'tenant-b', prompt: 'Hello' }), null);
  assert.equal(await thinkOmokodaGuest(database, { botId: born.botId, userId: 'tenant-a', prompt: 'Hello' }), 'Hello from the kernel');
  database.prepare('DELETE FROM omokoda_managed_runtime').run();
  await assert.rejects(thinkOmokodaGuest(database, { botId: born.botId, userId: 'tenant-a', prompt: 'Hello' }), /not bound/);
});

test('registration is skipped when VANTAGE_URL is unset', async (t) => {
  fresh(t);
  const kernel = await serve(kernelHandler());
  t.after(() => kernel.server.close());
  process.env.OMOKODA_URL = kernel.url;
  const result = await birthAndRegister(db(), { userId: 'tenant-a', name: 'Ada' });
  assert.deepEqual(result.vantage, { status: 'skipped', reason: 'VANTAGE_URL not set' });
});

// G-24 (V6-07-03): every model-proposed tool intent is authorized by the Rust policy
// kernel before the tool runs — not by the model, and not by the app's own opinion.
//
// The gate is exercised through the real binary (`cargo build -p agentos-policy
// --bin authorize --bin mint`), in child processes with their own SQLite file and key
// directory, because importing the server opens the database at import time.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

/** Build the kernel binaries once for the whole file. */
function buildKernel() {
  const run = spawnSync('cargo', ['build', '--locked', '-p', 'agentos-policy', '--bin', 'authorize', '--bin', 'mint'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 300_000,
  });
  assert.equal(run.status, 0, `kernel build failed:\n${run.stdout}\n${run.stderr}`);
  return path.join(root, 'target', 'debug', 'authorize');
}

const BIN = buildKernel();

async function fixture(script, extraEnv = {}) {
  const dir = await mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'uap-policy-'));
  const preamble = `
    import Database from 'better-sqlite3';
    import path from 'node:path';
    const out = (value) => process.stdout.write(JSON.stringify(value));
    ${script}
  `;
  try {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', preamble], {
      cwd: root,
      env: {
        ...process.env,
        SESSION_SECRET: 'policy-gate-test-only',
        DB_PATH: path.join(dir, 'app.sqlite'),
        HQ_LOCAL: '0',
        HERMES_HOME_PRIMARY: path.join(dir, 'primary'),
        ENGINES_DIR: path.join(dir, 'managed'),
        POLICY_AUTHORITY_DIR: path.join(dir, 'authority'),
        AGENTOS_POLICY_BIN: BIN,
        HERMES_KEY: '',
        XAI_API_KEY: '',
        COMPOSIO_API_KEY: '',
        ORGO_API_KEY: '',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => {
      child.once('exit', resolve);
      child.once('error', reject);
    });
    assert.equal(code, 0, `fixture failed (${code})\nstdout: ${stdout}\nstderr: ${stderr}`);
    return { dir, result: JSON.parse(stdout) };
  } finally {
    // Caller reads what it needs from `result`; the temp tree is removed below by the
    // individual test when it needs to inspect files first.
  }
}

/** Seed one owner and one bot; returns the ids the gate will act for. */
const SEED = `
  const { db } = await import('./server/src/db.ts');
  const now = Date.now();
  db.prepare('INSERT INTO users (id,email,name,created_at) VALUES (?,?,?,?)').run('usr_policy', 'p@example.com', 'P', now);
  db.prepare('INSERT INTO bots (id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run('bot_policy', 'usr_policy', 'Ops', now, now);
`;

test('managed workspace reads need an explicit user command and a real policy permit', async () => {
  const { dir, result } = await fixture(`
    ${SEED}
    const { ensureOmokodaSchema } = await import('./server/src/lib/omokoda-birth.ts');
    const { managedWorkspaceCommand } = await import('./server/src/agent/managed-workspace.ts');
    ensureOmokodaSchema(db);
    db.prepare('INSERT INTO omokoda_births(bot_id,sid,kernel_agent_id,kernel_url,genesis_hash,vantage_status,created_at) VALUES (?,?,?,?,?,?,?)')
      .run('bot_policy', 'sid_fixture', 'agent_fixture', 'http://127.0.0.1:1', 'fixture', 'skipped', now);
    db.prepare('INSERT INTO omokoda_managed_runtime(bot_id,kernel_sid,kernel_sid_hash) VALUES (?,?,?)').run('bot_policy','sid_kernel','fixture');
    const input = { botId: 'bot_policy', userId: 'usr_policy', text: '/workspace routines', fromUser: true };
    const bot = await managedWorkspaceCommand(db, { ...input, fromUser:false });
    const wrong = await managedWorkspaceCommand(db, { ...input, userId:'usr_other' });
    const unknown = await managedWorkspaceCommand(db, { ...input, text:'/workspace routines extra' });
    const ok = await managedWorkspaceCommand(db, input);
    const { api } = await import('./server/src/routes.ts');
    const msg = (cookie) => api.request('/bots/bot_policy/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ text: input.text }),
    });
    const unauthenticated = (await msg('')).status;
    db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (?,?,?,?)')
      .run('policy-fixture-session','usr_policy',now,now + 60000);
    db.prepare('INSERT INTO routines(id,bot_id,name,prompt,schedule,created_at) VALUES (?,?,?,?,?,?)')
      .run('routine_fixture','bot_policy','Morning review','Private routine prompt','0 8 * * *',now);
    const cookie = 'grokbot_session=policy-fixture-session';
    const accepted = (await msg(cookie)).status;
    let assistant = '';
    for (let i=0; i<100 && !assistant; i++) {
      const reply = await api.request('/bots/bot_policy/rows', { headers: { cookie } });
      if (!reply.ok) throw new Error('could not read conversation: ' + reply.status);
      assistant = (await reply.json()).rows.find((row) => row.body.role === 'assistant')?.body.text ?? '';
      if (!assistant) await new Promise((resolve) => setTimeout(resolve, 30));
    }
    db.prepare("INSERT INTO policies(user_id,tool,mode) VALUES (?,?,'blocked')").run('usr_policy','list_routines');
    const blocked = await managedWorkspaceCommand(db, input);
    out({bot,wrong,unknown,ok,unauthenticated,accepted,assistant,blocked,rows:db.prepare('SELECT tool,decision,permit_id FROM policy_decisions WHERE bot_id=? ORDER BY rowid').all('bot_policy')});
  `);
  try {
    assert.equal(result.bot, null);
    assert.equal(result.wrong, null);
    assert.equal(result.unknown.status, 'unsupported');
    assert.equal(result.ok.status, 'ok');
    assert.equal(result.ok.text, 'No routines are scheduled for this agent.');
    assert.equal(result.unauthenticated, 401);
    assert.equal(result.accepted, 200);
    assert.equal(result.assistant, '• Morning review — enabled');
    assert.equal(result.blocked.status, 'denied');
    assert.deepEqual(result.rows.map((row) => [row.tool, row.decision, !!row.permit_id]), [['list_routines','allow',true],['list_routines','allow',true],['list_routines','deny',false]]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('classification is a property of the tool, not of the arguments', async () => {
  const { classifyTool } = await import('../server/src/policy/tool-intents.ts');
  assert.deepEqual(classifyTool('list_routines'), { effect: 'read', risk: 'low' });
  assert.deepEqual(classifyTool('save_file'), { effect: 'write', risk: 'medium' });
  assert.deepEqual(classifyTool('send_to_bot'), { effect: 'external_message', risk: 'medium' });
  assert.deepEqual(classifyTool('x_search'), { effect: 'compute', risk: 'medium' });
  // An unknown name (a hallucinated tool) is never assumed harmless.
  assert.deepEqual(classifyTool('totally.made.up'), { effect: 'write', risk: 'medium' });
});

test('an allowed intent returns a one-use permit and is recorded with its argument digest', async () => {
  const { dir, result } = await fixture(`
    ${SEED}
    const { authorizeModelToolCall } = await import('./server/src/policy/tool-authority.ts');
    const { createHash } = await import('node:crypto');
    const args = { when: 'daily', prompt: 'status' };
    const decision = await authorizeModelToolCall({
      botId: 'bot_policy', userId: 'usr_policy', toolName: 'list_routines',
      args,
    });
    const rows = db.prepare('SELECT * FROM policy_decisions WHERE bot_id=? ORDER BY at_ms').all('bot_policy');
    out({ decision, rows, argsDigest: createHash('sha256').update('{"prompt":"status","when":"daily"}').digest('hex') });
  `);
  assert.equal(result.decision.allowed, true, JSON.stringify(result.decision));
  assert.equal(result.decision.code, 'allow');
  assert.match(result.decision.permit.intentId, /^int_/);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].decision, 'allow');
  assert.equal(result.rows[0].tool, 'list_routines');
  assert.equal(result.rows[0].effect, 'read');
  assert.equal(result.rows[0].params_digest, result.argsDigest);
  const mode = (await stat(path.join(dir, 'authority', 'issuer.json'))).mode & 0o777;
  assert.equal(mode, 0o600, 'the issuer seed must not be group/world readable');
  await rm(dir, { recursive: true, force: true });
});

test('a tool the owner blocked is not in the grant and is refused by the kernel', async () => {
  const { result } = await fixture(`
    ${SEED}
    db.prepare('INSERT INTO policies (user_id,tool,mode) VALUES (?,?,?)').run('usr_policy', 'delete_routine', 'blocked');
    const { authorizeModelToolCall } = await import('./server/src/policy/tool-authority.ts');
    const ok = await authorizeModelToolCall({
      botId: 'bot_policy', userId: 'usr_policy', toolName: 'list_routines', args: {},
    });
    const denied = await authorizeModelToolCall({
      botId: 'bot_policy', userId: 'usr_policy', toolName: 'delete_routine', args: { name: 'x' },
    });
    const rows = db.prepare('SELECT decision,code,tool FROM policy_decisions ORDER BY at_ms').all();
    out({ ok, denied, rows });
  `);
  assert.equal(result.ok.allowed, true, JSON.stringify(result.ok));
  assert.equal(result.denied.allowed, false, JSON.stringify(result.denied));
  assert.equal(result.denied.code, 'tool-not-granted');
  assert.deepEqual(result.rows.at(-1), { decision: 'deny', code: 'tool-not-granted', tool: 'delete_routine' });
});

test('a tool schema that changed after the grant was pinned is refused until re-issued', async () => {
  const { result } = await fixture(`
    ${SEED}
    const { authorizeModelToolCall } = await import('./server/src/policy/tool-authority.ts');
    // First call uses the registry's own schema; the second one claims a schema the
    // grant never pinned (a provider quietly widening a tool's arguments).
    const first = await authorizeModelToolCall({
      botId: 'bot_policy', userId: 'usr_policy', toolName: 'list_routines', args: {},
    });
    const changed = await authorizeModelToolCall({
      botId: 'bot_policy', userId: 'usr_policy', toolName: 'list_routines', args: {},
      schema: { type: 'object', properties: { extra: { type: 'number' } } },
    });
    out({ first, changed });
  `);
  assert.equal(result.first.allowed, true, JSON.stringify(result.first));
  assert.equal(result.changed.allowed, false, JSON.stringify(result.changed));
  assert.equal(result.changed.code, 'tool-schema-changed');
});

test('a missing kernel fails closed with policy-unavailable, never with an allow', async () => {
  const { result } = await fixture(`
    ${SEED}
    const { authorizeModelToolCall } = await import('./server/src/policy/tool-authority.ts');
    const decision = await authorizeModelToolCall({
      botId: 'bot_policy', userId: 'usr_policy', toolName: 'list_routines', args: {},
    });
    const row = db.prepare('SELECT decision,code FROM policy_decisions').get();
    out({ decision, row });
  `, { AGENTOS_POLICY_BIN: path.join(root, 'target', 'debug', 'does-not-exist') });
  assert.equal(result.decision.allowed, false);
  assert.equal(result.decision.code, 'policy-unavailable');
  assert.deepEqual(result.row, { decision: 'deny', code: 'policy-unavailable' });
});

test('the model cannot widen its own authority: the bundle it would have to forge is signed', async () => {
  // The intent is built by the gate from the registry and the exact arguments, so the
  // only way a model influences the outcome is through the arguments it proposes — and
  // the kernel pins their digest. This case proves the gate ignores an intent-shaped
  // field in the arguments and still authorizes the tool's own effect class.
  const { result } = await fixture(`
    ${SEED}
    const { authorizeModelToolCall } = await import('./server/src/policy/tool-authority.ts');
    const decision = await authorizeModelToolCall({
      botId: 'bot_policy', userId: 'usr_policy', toolName: 'save_file',
      args: { path: 'notes.txt', content: 'x', effect: 'read', risk: 'low', policy_allow: true },
    });
    const row = db.prepare('SELECT effect,risk FROM policy_decisions').get();
    out({ decision, row });
  `);
  // save_file is a write: the model's embedded "effect: read" changed nothing.
  assert.equal(result.decision.allowed, true, JSON.stringify(result.decision));
  assert.equal(result.decision.effect, 'write');
  assert.deepEqual(result.row, { effect: 'write', risk: 'medium' });
});

test('an MCP tool call is refused at the door and the tool never runs', async () => {
  // The chokepoint the app actually serves: JSON-RPC `tools/call` over the MCP route. A
  // blocked tool must come back as an error to the model AND must not have run — asserted
  // by the tool's own side effect (a routine row) being absent.
  const { result } = await fixture(`
    ${SEED}
    db.prepare('INSERT INTO policies (user_id,tool,mode) VALUES (?,?,?)').run('usr_policy', 'create_routine', 'blocked');
    const { mcpApi } = await import('./server/src/mcp.ts');
    const { mcpToken } = await import('./server/src/engine.ts');
    const ask = (tool, args) => mcpApi.request('/bot_policy', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + mcpToken('bot_policy'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
    });
    const denied = await (await ask('create_routine', { name: 'x', prompt: 'y', schedule: 'daily' })).json();
    const allowed = await (await ask('list_routines', {})).json();
    const routines = db.prepare('SELECT COUNT(*) AS n FROM routines').get();
    out({ denied, allowed, routines });
  `);
  assert.equal(result.denied.result.isError, true, JSON.stringify(result.denied));
  assert.match(result.denied.result.content[0].text, /^Policy refused this action \(tool-not-granted/);
  assert.equal(result.allowed.result.isError, undefined, JSON.stringify(result.allowed));
  assert.equal(result.routines.n, 0, 'a refused tool must not have run');
});

test('the authority key is generated once and reused across processes', async () => {
  const first = await fixture(`
    ${SEED}
    const { authorityFingerprint } = await import('./server/src/policy/tool-authority.ts');
    out({ fingerprint: authorityFingerprint() });
  `);
  const keyFile = await readFile(path.join(first.dir, 'authority', 'issuer.json'), 'utf8');
  await rm(first.dir, { recursive: true, force: true });
  assert.ok(JSON.parse(keyFile).d, 'issuer key file carries a seed');

  // A second fixture with the same authority dir would keep the fingerprint; a fresh
  // one must not, or every install would share a signing key.
  const b = await fixture(`
    ${SEED}
    const { authorityFingerprint } = await import('./server/src/policy/tool-authority.ts');
    out({ fingerprint: authorityFingerprint() });
  `);
  await rm(b.dir, { recursive: true, force: true });
  assert.notEqual(first.result.fingerprint, b.result.fingerprint);
  assert.match(first.result.fingerprint, /^[0-9a-f]{64}$/);
});

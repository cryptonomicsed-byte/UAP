// Hermes adapter mapping and conversation lifecycle (V6-07-01, V6-07-07).
//
// Two claims are pinned here:
//  1. The adapter surface this app actually uses is the Hermes gateway's, and every
//     entry names the file and token that prove it. A mapping that drifts from the
//     code (an endpoint we stopped calling, a session feature we never had) fails.
//  2. A conversation thread belongs to the SID that owns the agent, not to a process,
//     a model or a chat generation alone. A model swap in the gateway and a runtime
//     restart must both leave each SID's thread intact and must never hand one SID's
//     thread to another.
//
// Every case runs in a child process with its own SQLite file and Hermes home, because
// importing the server opens the database and reads the environment at import time.
// The restart case uses the SAME database in two separate processes, so "restart"
// means a new process with empty module state — not a cleared Map.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';

const root = path.resolve(import.meta.dirname, '..');

function isolatedEnv(dir, extra = {}) {
  const env = {
    ...process.env,
    SESSION_SECRET: 'hermes-adapter-test-only',
    DB_PATH: path.join(dir, 'app.sqlite'),
    HERMES_HOME_PRIMARY: path.join(dir, 'primary'),
    ENGINES_DIR: path.join(dir, 'managed'),
    HQ_LOCAL: '0',
    ORGO_COMPUTER_ID: '',
    HERMES_KEY: '',
    ...extra,
  };
  for (const key of ['XAI_API_KEY', 'COMPOSIO_API_KEY', 'ORGO_API_KEY']) {
    delete env[key];
    delete env[`${key}_FILE`];
  }
  return env;
}

function runScript(env, script, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], timeout,
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('exit', (code) => (code === 0 ? resolve(output) : reject(new Error(`child exited ${code}\n${output}`))));
    child.once('error', reject);
  });
}

async function withDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uap-hermes-adapter-'));
  await mkdir(path.join(dir, 'primary'), { recursive: true });
  for (const botId of ['bot_alpha', 'bot_beta']) {
    await mkdir(path.join(dir, 'managed', botId), { recursive: true });
    // A managed home whose key file exists but whose gateway is the fixture below.
    await writeFile(path.join(dir, 'managed', botId, '.env'), `API_SERVER_KEY=key-${botId}\n`);
  }
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------- the mapping ----------

test('the adapter surface names only gateway calls this tree makes, with evidence', { timeout: 30000 }, async () => {
  await withDir(async (dir) => {
    const script = `
      import assert from 'node:assert/strict';
      import { existsSync, readFileSync } from 'node:fs';
      import path from 'node:path';
      import { HERMES_GATEWAY_SURFACE } from './server/src/agent/hermes-adapter.ts';
      const root = ${JSON.stringify(root)};

      const used = new Set(HERMES_GATEWAY_SURFACE
        .filter((entry) => entry.hermes.endpoint)
        .map((entry) => entry.hermes.method + ' ' + entry.hermes.endpoint));
      assert.deepEqual([...used].sort(), [
        'GET /api/model/options',
        'GET /health',
        'GET /v1/models',
        'POST /v1/responses',
      ]);

      for (const entry of HERMES_GATEWAY_SURFACE) {
        assert.ok(entry.concept, 'every entry names the adapter concept it replaces');
        assert.ok(['mapped', 'partial', 'unsupported'].includes(entry.verdict), entry.concept + ': verdict');
        assert.ok(entry.evidence.length > 0, entry.concept + ': evidence is required, not asserted');
        for (const proof of entry.evidence) {
          const file = path.join(root, proof.file);
          assert.equal(existsSync(file), true, entry.concept + ': evidence file ' + proof.file + ' is gone');
          assert.ok(readFileSync(file, 'utf8').includes(proof.token),
            entry.concept + ': ' + proof.file + ' no longer contains ' + JSON.stringify(proof.token));
        }
        if (entry.verdict === 'unsupported') {
          assert.equal(entry.hermes.endpoint, undefined, entry.concept + ': unsupported entries claim no endpoint');
          assert.ok(entry.limitation, entry.concept + ': an unsupported entry says what is missing instead');
        } else {
          assert.ok(entry.hermes.endpoint, entry.concept + ': a supported entry names its endpoint');
        }
      }

      const concepts = HERMES_GATEWAY_SURFACE.map((entry) => entry.concept);
      for (const required of ['session/new', 'session/prompt', 'session/cancel', 'session/load',
        'session/request_permission', 'tool execution', 'mcp discovery', 'model selection', 'health']) {
        assert.ok(concepts.includes(required), 'the mapping is missing ' + required + '; silence is not a gap list');
      }

      // The gateway does not mint a session we can read back; we name the conversation.
      assert.equal(HERMES_GATEWAY_SURFACE.find((entry) => entry.concept === 'session/new').verdict, 'partial');
      // The gateway executes its own tools; this app executes none of them for it.
      assert.equal(HERMES_GATEWAY_SURFACE.find((entry) => entry.concept === 'tool execution').verdict, 'partial');
      // Gateway-side MCP discovery is configuration we have not proven against a live gateway.
      assert.equal(HERMES_GATEWAY_SURFACE.find((entry) => entry.concept === 'mcp discovery').verdict, 'unsupported');
      console.log('mapping ok');
    `;
    await runScript(isolatedEnv(dir), script);
  });
});

// ---------- thread identity ----------

test('a thread is owned by the SID, and only unbound agents fall back to the bot id', { timeout: 30000 }, async () => {
  await withDir(async (dir) => {
    const script = `
      import assert from 'node:assert/strict';
      import { AdapterIdentityError, conversationThread } from './server/src/agent/hermes-adapter.ts';

      assert.deepEqual(conversationThread({ botId: 'bot_alpha', sid: 'sid_alpha', generation: 3 }), {
        thread: 'hq-sid_alpha-g3', scopedBy: 'sid',
      });
      assert.deepEqual(conversationThread({ botId: 'bot_alpha', sid: null, generation: 1 }), {
        thread: 'hq-bot_alpha-g1', scopedBy: 'bot-legacy',
      });

      const a = conversationThread({ botId: 'bot_shared', sid: 'sid_alpha', generation: 1 }).thread;
      const b = conversationThread({ botId: 'bot_shared', sid: 'sid_beta', generation: 1 }).thread;
      assert.notEqual(a, b, 'two SIDs never share a conversation thread, even on the same bot row');

      // Stable across calls: the id carries no clock, no model and no process state.
      assert.equal(
        conversationThread({ botId: 'bot_alpha', sid: 'sid_alpha', generation: 3 }).thread,
        conversationThread({ botId: 'bot_alpha', sid: 'sid_alpha', generation: 3 }).thread,
      );

      const refuse = (input, code) => assert.throws(
        () => conversationThread(input),
        (error) => error instanceof AdapterIdentityError && error.code === code,
        JSON.stringify(input) + ' should be refused as ' + code,
      );
      refuse({ botId: 'bot_alpha', sid: 'sid_Alpha', generation: 1 }, 'sid_invalid');
      refuse({ botId: 'bot_alpha', sid: 'alpha', generation: 1 }, 'sid_invalid');
      refuse({ botId: '../bot', sid: null, generation: 1 }, 'bot_invalid');
      refuse({ botId: 'bot_alpha', sid: null, generation: 0 }, 'generation_invalid');
      refuse({ botId: 'bot_alpha', sid: null, generation: 1.5 }, 'generation_invalid');
      console.log('threads ok');
    `;
    await runScript(isolatedEnv(dir), script);
  });
});

// ---------- restart and model swap, against a gateway fixture ----------

const seed = `
  import { db } from './server/src/db.ts';
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('owner', 'owner@example.test', 'Owner', 1);
  const port = Number(process.env.FIXTURE_PORT);
  for (const [id, sid] of [['bot_alpha', 'sid_alpha'], ['bot_beta', 'sid_beta']]) {
    db.prepare('INSERT INTO bots(id,user_id,name,engine,engine_port,sid,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, 'owner', id, 'managed', port, sid, 1, 1);
  }
`;

const turn = (botId, text) => `await turn('${botId}', '${text}');`;

const phaseScript = (phase) => `
  import assert from 'node:assert/strict';
  ${phase === 1 ? seed : ''}
  const { enqueue, runInBotQueue } = await import('./server/src/agent/loop.ts');
  const turn = async (botId, text) => {
    enqueue(botId, { type: 'user', text });
    await runInBotQueue(botId, async () => {});
  };
  ${phase === 1 ? turn('bot_alpha', 'alpha token one') : ''}
  ${phase === 2 ? turn('bot_beta', 'beta token two') : ''}
  ${phase === 2 ? turn('bot_alpha', 'alpha token three') : ''}
  ${phase === 2 ? `
  const { engineInfo } = await import('./server/src/engine.ts');
  const info = await engineInfo('bot_alpha');
  console.log(JSON.stringify({ info: { model: info.model, provider: info.provider, status: info.status } }));
  ` : `console.log(JSON.stringify({ ok: true }));`}
`;

test('a model swap and a runtime restart keep each SID on its own thread', { timeout: 120000 }, async () => {
  await withDir(async (dir) => {
    const requests = [];
    let model = 'gateway-model-1';
    const gateway = createServer(async (req, res) => {
      if (req.url === '/health') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ status: 'ok', version: 'fixture-version' }));
        return;
      }
      if (req.url === '/api/model/options') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ model, provider: 'gateway-provider', providers: [] }));
        return;
      }
      if (req.url === '/v1/models') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      if (req.url === '/v1/responses' && req.method === 'POST') {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        requests.push({ ...body, authorization: req.headers.authorization });
        res.setHeader('content-type', 'text/event-stream');
        // Echo the thread the request named, so the stored transcript shows which
        // engine-side conversation the answer belongs to.
        res.end(`event: response.output_text.delta\ndata: ${JSON.stringify({ delta: `thread=${body.conversation} input=${body.input}` })}\n\n`);
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    gateway.listen(0, '127.0.0.1');
    await once(gateway, 'listening');
    const port = gateway.address().port;
    const env = isolatedEnv(dir, {
      HERMES_URL: `http://127.0.0.1:${port}`,
      FIXTURE_PORT: String(port),
    });

    try {
      await runScript(env, phaseScript(1), 45000);
      // The operator changes the model in Hermes configuration between the two runs.
      model = 'gateway-model-2';
      const second = await runScript(env, phaseScript(2), 60000);

      assert.deepEqual(requests.map((request) => request.conversation), [
        'hq-sid_alpha-g1',
        'hq-sid_beta-g1',
        'hq-sid_alpha-g1',
      ], 'the restarted process resumes the same SID thread and never borrows another');

      assert.match(requests[0].input, /alpha token one/);
      assert.match(requests[1].input, /beta token two/);
      assert.match(requests[2].input, /alpha token three/);
      assert.equal(requests.some((request) => /beta token/.test(request.input) && request.conversation.includes('alpha')), false);
      assert.equal(requests.some((request) => /alpha token/.test(request.input) && request.conversation.includes('beta')), false);

      assert.deepEqual(
        requests.map((request) => request.authorization),
        ['Bearer key-bot_alpha', 'Bearer key-bot_beta', 'Bearer key-bot_alpha'],
        'each SID thread goes out under its own engine key',
      );
      assert.deepEqual(requests.map((request) => request.model), ['hermes-agent', 'hermes-agent', 'hermes-agent']);

      const info = JSON.parse(second.trim().split('\n').pop());
      assert.equal(info.info.status, 'ready');
      assert.equal(info.info.model, 'gateway-model-2', 'the model swap is visible in gateway metadata');
      assert.equal(info.info.provider, 'gateway-provider');

      const db = new Database(env.DB_PATH, { readonly: true });
      try {
        const rows = db.prepare("SELECT bot_id, body FROM rows WHERE kind='message'").all().map((row) => ({
          botId: row.bot_id,
          body: JSON.parse(row.body),
        }));
        const textFor = (botId) => rows.filter((row) => row.botId === botId).map((row) => row.body.text ?? '').join('\n');
        assert.match(textFor('bot_alpha'), /thread=hq-sid_alpha-g1/);
        assert.doesNotMatch(textFor('bot_alpha'), /sid_beta/);
        assert.match(textFor('bot_beta'), /thread=hq-sid_beta-g1/);
        assert.doesNotMatch(textFor('bot_beta'), /sid_alpha/);
      } finally {
        db.close();
      }
    } finally {
      gateway.closeAllConnections();
      await new Promise((resolve) => gateway.close(resolve));
    }
  });
});

// ---------- the operator binding ----------

test('binding a SID is refused when it would re-label a conversation that already exists', { timeout: 30000 }, async () => {
  await withDir(async (dir) => {
    const script = `
      import assert from 'node:assert/strict';
      import { db } from './server/src/db.ts';
      import { bindConversationSid, conversationThread } from './server/src/agent/hermes-adapter.ts';
      db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('owner', 'owner@example.test', 'Owner', 1);
      db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run('bot_alpha', 'owner', 'Alpha', 1, 1);
      db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run('bot_other', 'owner', 'Other', 1, 1);

      const bound = bindConversationSid('bot_alpha', 'sid_alpha');
      assert.deepEqual(bound, { botId: 'bot_alpha', sid: 'sid_alpha', thread: 'hq-sid_alpha-g1' });
      assert.equal(db.prepare('SELECT sid FROM bots WHERE id=?').get('bot_alpha').sid, 'sid_alpha');

      // The same SID cannot own two live agents.
      assert.throws(() => bindConversationSid('bot_other', 'sid_alpha'), (error) => error.code === 'sid_in_use');

      // Re-labelling an existing conversation is refused until a new generation is opened.
      db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES (?,?,?,?,?,?,?)')
        .run('bot_alpha', 1, 1, 1, 'message', JSON.stringify({ type: 'message', role: 'user', text: 'hello' }), 1);
      assert.throws(() => bindConversationSid('bot_alpha', 'sid_other'), (error) => error.code === 'sid_rebind_requires_new_generation');
      assert.equal(db.prepare('SELECT sid FROM bots WHERE id=?').get('bot_alpha').sid, 'sid_alpha', 'a refused bind writes nothing');

      // Unknown agents and malformed SIDs are refused before any write.
      assert.throws(() => bindConversationSid('bot_missing', 'sid_missing'), (error) => error.code === 'bot_missing');
      assert.throws(() => bindConversationSid('bot_alpha', 'not-a-sid'), (error) => error.code === 'sid_invalid');

      db.prepare('UPDATE bots SET generation=2 WHERE id=?').run('bot_alpha');
      assert.deepEqual(conversationThread({ botId: 'bot_alpha', sid: 'sid_alpha', generation: 2 }).thread, 'hq-sid_alpha-g2');
      console.log('binding ok');
    `;
    await runScript(isolatedEnv(dir), script);
  });
});

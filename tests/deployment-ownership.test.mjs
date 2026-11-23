import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';

const root = path.resolve(import.meta.dirname, '..');
const secret = 'deployment-tests-secret';
const ownerKey = crypto.createHmac('sha256', secret).update('owner-login').digest('hex');
const variables = dir => {
  const env = { ...process.env, SESSION_SECRET: secret, PORT: '0', UAP_NO_SCHEDULER: '1', GROKBOT_NO_SCHEDULER: '1',
    DB_PATH: path.join(dir, 'app.sqlite'), ENGINES_DIR: path.join(dir, 'engines'), HERMES_HOME_PRIMARY: path.join(dir, 'primary'),
    DEV_LOGIN: '0', ALLOWED_EMAILS: '' };
  for (const key of ['XAI_API_KEY', 'ORGO_API_KEY', 'COMPOSIO_API_KEY']) { delete env[key]; delete env[`${key}_FILE`]; }
  return env;
};

async function execute(script, env) {
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', part => { output += part; });
  child.stderr.on('data', part => { output += part; });
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  return { code, output };
}

async function start(env) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  try {
    const base = await new Promise((resolve, reject) => {
      // 30s: the full suite spawns many servers concurrently; a 10s budget flaked
      // under load while passing in isolation (no startup work changed).
      const timeout = setTimeout(() => reject(new Error(`server startup timed out: ${output}`)), 30000);
      child.stderr.on('data', part => { output += part; });
      child.stdout.on('data', part => {
        output += part;
        const match = output.match(/server on (http:\/\/localhost:\d+)/);
        if (match) { clearTimeout(timeout); resolve(match[1]); }
      });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`server exited ${code}: ${output}`)); });
    });
    return { base, stop: async () => {
      if (child.exitCode !== null || child.signalCode) return;
      const ended = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM'); await ended;
    } };
  } catch (error) { child.kill('SIGTERM'); throw error; }
}

const ownerLogin = (base, email, link = false) => fetch(`${base}/api/auth/owner`, {
  method: 'POST', headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ email, link }),
});

function snapshot(file) {
  const db = new Database(file, { readonly: true });
  try { return { users: db.prepare('SELECT id,email FROM users ORDER BY id').all(), bots: db.prepare('SELECT id,user_id,engine FROM bots ORDER BY id').all(), binding: db.prepare('SELECT * FROM deployment_binding').all() }; }
  finally { db.close(); }
}

test('owner setup is atomic, rejects a second identity, and survives restart', { timeout: 45000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uap-owner-'));
  let server;
  try {
    const env = variables(dir);
    server = await start(env);
    const missingKey = await fetch(`${server.base}/api/auth/owner`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'attacker@example.com' }) });
    assert.equal(missingKey.status, 403);
    const first = await ownerLogin(server.base, 'Owner@Example.com');
    assert.equal(first.status, 200);
    const cookie = first.headers.get('set-cookie').split(';')[0];
    const before = snapshot(env.DB_PATH);
    assert.equal(before.users.length, 1);
    assert.equal(before.users[0].email, 'owner@example.com');
    assert.equal(before.bots.length, 1);
    assert.equal(before.bots[0].engine, 'primary');
    assert.equal(before.binding[0].primary_bot_id, before.bots[0].id);
    const rejected = await ownerLogin(server.base, 'second@example.com');
    assert.equal(rejected.status, 403);
    assert.match((await rejected.json()).error, /restricted to its owner/);
    assert.deepEqual(snapshot(env.DB_PATH), before);
    // Concurrent enrollment cannot race the single-owner binding.
    const attempts = await Promise.all(['a@example.com', 'b@example.com'].map(email => ownerLogin(server.base, email)));
    assert.deepEqual(attempts.map(r => r.status), [403, 403]);
    assert.deepEqual(snapshot(env.DB_PATH), before);
    // An owner-issued one-use link still works without a paid login provider.
    const cli = await execute(`process.argv = ['node', 'scripts/sign-in-link.mjs', 'owner@example.com']; await import('./scripts/sign-in-link.mjs');`, { ...env, PORT: new URL(server.base).port });
    assert.equal(cli.code, 0, cli.output);
    assert.equal(cli.output.includes(secret), false);
    assert.equal(cli.output.includes(ownerKey), false);
    const link = new URL(cli.output.trim());
    assert.equal((await fetch(`${server.base}${link.pathname}`, { redirect: 'manual' })).status, 302);
    assert.equal((await fetch(`${server.base}${link.pathname}`, { redirect: 'manual' })).status, 410);
    await server.stop();
    server = await start(env);
    assert.deepEqual(snapshot(env.DB_PATH), before);
    const me = await (await fetch(`${server.base}/api/auth/me`, { headers: { cookie } })).json();
    assert.equal(me.user.id, before.users[0].id);
    assert.equal(me.googleLogin, false);
    await assert.rejects(stat(env.HERMES_HOME_PRIMARY), { code: 'ENOENT' });
  } finally { await server?.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('failed initial profile creation rolls back user and ownership', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uap-owner-rollback-'));
  let server;
  try {
    const env = { ...variables(dir), MAX_BOTS: '0' };
    server = await start(env);
    assert.equal((await ownerLogin(server.base, 'owner@example.com')).status, 403);
    const state = snapshot(env.DB_PATH);
    assert.equal(state.users.length, 0);
    assert.equal(state.bots.length, 0);
    assert.equal(state.binding[0].owner_user_id, null);
    assert.equal(state.binding[0].primary_bot_id, null);
  } finally { await server?.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('legacy single-user migration retains IDs; ambiguous multi-user migration makes no ownership writes', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uap-owner-migrate-'));
  const env = variables(dir);
  try {
    const seed = await execute(`import { db } from './server/src/db.ts';
      db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('legacy-owner','old@example.com','Owner',1);
      db.prepare("INSERT INTO bots(id,user_id,name,engine,created_at,updated_at) VALUES ('legacy-agent','legacy-owner','Old','primary',1,1)").run(); db.close();`, env);
    assert.equal(seed.code, 0, seed.output);
    const migrate = await execute(`import { deployment } from './server/src/deployment.ts'; if(deployment.ownerId() !== 'legacy-owner') process.exit(1);`, env);
    assert.equal(migrate.code, 0, migrate.output);
    const state = snapshot(env.DB_PATH);
    assert.equal(state.binding[0].owner_user_id, 'legacy-owner');
    assert.equal(state.binding[0].primary_bot_id, 'legacy-agent');
    const addUser = await execute(`import { db } from './server/src/db.ts'; db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('legacy-second','second@example.com','Second',1); db.close();`, env);
    assert.equal(addUser.code, 0, addUser.output);
    const before = snapshot(env.DB_PATH);
    const blocked = await execute(`import './server/src/deployment.ts';`, env);
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.output, /Multiple legacy accounts/);
    assert.deepEqual(snapshot(env.DB_PATH), before);
    await assert.rejects(stat(env.ENGINES_DIR), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('pre-existing non-owner sessions cannot authorize HTTP or WebSocket identity', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uap-owner-session-'));
  try {
    const result = await execute(`
      import assert from 'node:assert/strict';
      import { db } from './server/src/db.ts';
      db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('owner','owner@example.com','Owner',1);
      const { userFromToken, userFromCookieHeader } = await import('./server/src/lib/auth.ts');
      db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('other','other@example.com','Other',1);
      db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (?,?,?,?)').run('other-token','other',1,Date.now()+60000);
      assert.equal(userFromToken('other-token'), null);
      assert.equal(userFromCookieHeader('grokbot_session=other-token'), null);
      db.close();
    `, variables(dir));
    assert.equal(result.code, 0, result.output);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

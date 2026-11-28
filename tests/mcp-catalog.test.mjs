import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'mcp-test-fixture';
const { db } = await import('../server/src/db.ts');
const { deployment } = await import('../server/src/deployment.ts');
const { v6Api } = await import('../server/src/routes-v6.ts');

db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('owner', 'owner@example.invalid', 'Owner', 1);
deployment.claimOwner('owner');
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('other', 'other@example.invalid', 'Other', 1);
db.prepare('INSERT INTO auth_sessions VALUES (?,?,?,?)').run('fixture-session', 'owner', 1, Date.now() + 60_000);
const insertBot = db.prepare('INSERT INTO bots(id,user_id,name,engine,created_at,updated_at) VALUES (?,?,?,?,1,1)');
insertBot.run('managed', 'owner', 'Managed', 'managed');
insertBot.run('primary', 'owner', 'Shared', 'primary');
insertBot.run('foreign', 'other', 'Foreign', 'managed');
const path = (bot = 'managed') => `/bots/${bot}/mcp-servers`;
const request = (url, method = 'GET', body, authenticated = true) => v6Api.request(url, {
  method, headers: { 'Content-Type': 'application/json', ...(authenticated ? { Cookie: 'grokbot_session=fixture-session' } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

test('authenticated catalog install uses the server-side preset and rejects overrides', async () => {
  assert.equal((await request(`${path()}/catalog`, 'GET', undefined, false)).status, 401);
  const catalog = await (await request(`${path()}/catalog`)).json();
  assert.ok(catalog.entries.some(entry => entry.id === 'deepwiki'));
  assert.ok(catalog.entries.some(entry => entry.id === 'notion' && entry.auth === 'oauth'));
  assert.equal((await request(`${path()}/catalog`, 'POST', { presetId: 'deepwiki', url: 'https://example.invalid' })).status, 400);
  assert.equal((await request(`${path()}/catalog`, 'POST', { presetId: 'notion' })).status, 409);
  const result = await request(`${path()}/catalog`, 'POST', { presetId: 'deepwiki' });
  assert.equal(result.status, 201);
  const { server } = await result.json();
  assert.equal(server.url, 'https://mcp.deepwiki.com/mcp');
  assert.ok((await (await request(path())).json()).servers.some(row => row.id === server.id));
  assert.equal((await request(`${path()}/catalog`, 'POST', { presetId: 'deepwiki' })).status, 400);
});

test('connector reads and changes stay on the owned managed agent', async () => {
  const { servers } = await (await request(path())).json();
  assert.equal((await request(path('foreign'))).status, 404);
  assert.equal((await request(`${path('foreign')}/catalog`, 'POST', { presetId: 'context7' })).status, 404);
  assert.equal((await request(`${path('primary')}/catalog`, 'POST', { presetId: 'context7' })).status, 409);
  assert.equal((await request(`${path('foreign')}/${servers[0].id}`, 'DELETE')).status, 404);
});

test('optional token is write-only and sent only to the selected provider in config', async () => {
  const { mcpServersFor } = await import('../server/src/lib/mcp-connectors.ts');
  const token = 'fixture-token-for-context7';
  const result = await request(`${path()}/catalog`, 'POST', { presetId: 'context7', token });
  assert.equal(result.status, 201);
  assert.ok(!(await result.text()).includes(token));
  assert.ok(!(await (await request(path())).text()).includes(token));
  const config = mcpServersFor(db, 'managed');
  assert.equal(config.context7.url, 'https://mcp.context7.com/mcp');
  assert.equal(config.context7.headers.Authorization, `Bearer ${token}`);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

process.env.SESSION_SECRET ??= 'mcp-connectors-test-secret';
const { addMcpServer, listMcpServers, removeMcpServer, setMcpServerEnabled, mcpServersFor, McpConnectorError } =
  await import('../server/src/lib/mcp-connectors.ts');

function db() {
  const d = new Database(':memory:');
  d.exec(`CREATE TABLE bot_mcp_servers (
    id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL,
    headers_json TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  return d;
}

test('adding a real server stores it and never echoes the header value back', () => {
  const d = db();
  const s = addMcpServer(d, 'bot_1', { name: 'spacemail', url: 'https://mcp.spacemail.com/mcp', headers: { Authorization: 'Bearer pk22dlPs6owpe26ue0GW' } });
  assert.equal(s.name, 'spacemail');
  assert.deepEqual(s.headerNames, ['Authorization']);
  const list = listMcpServers(d, 'bot_1');
  assert.equal(list.length, 1);
  assert.equal(JSON.stringify(list).includes('pk22dlPs6owpe26ue0GW'), false, 'the raw header value must never appear in a list response');
});

test('rejects a non-https URL (except localhost) and a bad name', () => {
  const d = db();
  assert.throws(() => addMcpServer(d, 'bot_1', { name: 'bad', url: 'http://evil.example.com/mcp' }), McpConnectorError);
  assert.throws(() => addMcpServer(d, 'bot_1', { name: 'Not Valid!', url: 'https://ok.example.com/mcp' }), McpConnectorError);
  addMcpServer(d, 'bot_1', { name: 'local_test', url: 'http://localhost:9000/mcp' }); // allowed for local dev
});

test('two bots can each add a server with the same name independently', () => {
  const d = db();
  addMcpServer(d, 'bot_a', { name: 'spacemail', url: 'https://mcp.spacemail.com/mcp' });
  addMcpServer(d, 'bot_b', { name: 'spacemail', url: 'https://mcp.spacemail.com/mcp' });
  assert.equal(listMcpServers(d, 'bot_a').length, 1);
  assert.equal(listMcpServers(d, 'bot_b').length, 1);
  assert.throws(() => addMcpServer(d, 'bot_a', { name: 'spacemail', url: 'https://mcp.spacemail.com/mcp' }), McpConnectorError);
});

test('disabling a server removes it from the config.yaml merge, not just a UI flag', () => {
  const d = db();
  const s = addMcpServer(d, 'bot_1', { name: 'spacemail', url: 'https://mcp.spacemail.com/mcp', headers: { Authorization: 'Bearer x' } });
  assert.deepEqual(Object.keys(mcpServersFor(d, 'bot_1')), ['spacemail']);
  setMcpServerEnabled(d, 'bot_1', s.id, false);
  assert.deepEqual(Object.keys(mcpServersFor(d, 'bot_1')), []);
  setMcpServerEnabled(d, 'bot_1', s.id, true);
  assert.deepEqual(Object.keys(mcpServersFor(d, 'bot_1')), ['spacemail']);
});

test('removing a server deletes it for good', () => {
  const d = db();
  const s = addMcpServer(d, 'bot_1', { name: 'spacemail', url: 'https://mcp.spacemail.com/mcp' });
  assert.equal(removeMcpServer(d, 'bot_1', s.id), true);
  assert.equal(listMcpServers(d, 'bot_1').length, 0);
  assert.equal(removeMcpServer(d, 'bot_1', s.id), false);
});

test('config reconciliation removes disabled and deleted entries without touching unrelated servers', async () => {
  const { reconcileMcpServers } = await import('../server/src/lib/mcp-connectors.ts');
  const d = db();
  const s = addMcpServer(d, 'bot_1', { name: 'books', url: 'https://books.example.invalid/mcp', headers: { Authorization: 'fixture-only' } });
  const manual = { another: { command: 'operator-managed' } };
  const legacy = { ...manual, books: { url: s.url, timeout: 120, connect_timeout: 30, headers: { Authorization: 'fixture-only' } } };
  setMcpServerEnabled(d, 'bot_1', s.id, false);
  assert.deepEqual(reconcileMcpServers(d, 'bot_1', legacy), manual);
  setMcpServerEnabled(d, 'bot_1', s.id, true);
  const configured = reconcileMcpServers(d, 'bot_1', legacy);
  assert.equal(configured.books.sampling.enabled, false);
  assert.throws(() => reconcileMcpServers(d, 'bot_1', { books: { command: 'operator-managed' } }), McpConnectorError);
  removeMcpServer(d, 'bot_1', s.id);
  assert.deepEqual(reconcileMcpServers(d, 'bot_1', configured), manual);
  assert.deepEqual(reconcileMcpServers(d, 'bot_1', { books: { command: 'operator-managed' } }), { books: { command: 'operator-managed' } });
  assert.deepEqual(reconcileMcpServers(d, 'bot_2', legacy), legacy);
  assert.equal(d.prepare('SELECT headers_json FROM bot_mcp_servers WHERE id=?').get(s.id)?.headers_json, '{}');
  assert.equal(setMcpServerEnabled(d, 'bot_1', s.id, true), false);
  assert.notEqual(addMcpServer(d, 'bot_1', { name: 'books', url: s.url }).id, s.id);
});

test('connector inputs must remain literal in the engine configuration', () => {
  const d = db();
  const url = 'https://books.example.invalid/mcp';
  const template = '$' + '{TEST_ONLY_PLACEHOLDER}';
  assert.throws(() => addMcpServer(d, 'bot_1', { name: 'books', url, headers: { 'X-Fixture': template } }), McpConnectorError);
  assert.throws(() => addMcpServer(d, 'bot_1', { name: 'books', url: `${url}/${template}` }), McpConnectorError);
  const s = addMcpServer(d, 'bot_1', { name: 'books', url });
  d.prepare('UPDATE bot_mcp_servers SET headers_json=? WHERE id=?').run(JSON.stringify({ 'X-Fixture': template }), s.id);
  assert.equal(Object.hasOwn(mcpServersFor(d, 'bot_1'), 'books'), false);
});

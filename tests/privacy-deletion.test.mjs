// Deletion/privacy propagation: erasure must reach memory, caches, the derived index and
// conversation history, while audit evidence is retained under an explicit, recorded rule.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';

const dir = await mkdtemp(path.join(os.tmpdir(), 'uap-privacy-deletion-'));
process.env.SESSION_SECRET = 'privacy-deletion-test-secret';
process.env.DB_PATH = path.join(dir, 'app.sqlite');
process.env.ENGINES_DIR = path.join(dir, 'engines');
process.env.HERMES_HOME_PRIMARY = path.join(dir, 'primary');
process.env.DEV_LOGIN = '0';
process.env.ALLOWED_EMAILS = '';
process.env.UAP_NO_SCHEDULER = '1';
const primary = process.env.HERMES_HOME_PRIMARY;
await mkdir(path.join(primary, 'memories'), { recursive: true });
const memoryFile = path.join(primary, 'memories', 'MEMORY.md');
const userFile = path.join(primary, 'memories', 'USER.md');
const SEP = '\n§\n';

const { db } = await import('../server/src/db.ts');
const { setLive, getLive } = await import('../server/src/store.ts');
const { listMemories } = await import('../server/src/engine-memory.ts');
const { syncMemoryIndex, searchMemory } = await import('../server/src/search/memory-index.ts');
const {
  requestDeletion, runDeletion, getDeletionRequest, listDeletionRequests,
  verifyDeletionReceipt, PrivacyDeletionError, EVIDENCE_RETENTION_RULES,
} = await import('../server/src/privacy/deletion.ts');
const { defaultHolders } = await import('../server/src/privacy/holders.ts');

after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });

// One owner account at import time (the deployment boundary refuses multiple legacy accounts).
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('usr-owner', 'owner@example.test', 'Owner', 1);
const seedBot = (id, userId = 'usr-owner', engine = 'primary') => db.prepare(
  "INSERT INTO bots(id,user_id,name,engine,is_primary,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
).run(id, userId, id, engine, engine === 'primary' ? 1 : 0, 1, 1);
seedBot('bot-erase');
seedBot('bot-other');
// The deployment boundary ran before this file seeded its single owner; bind it explicitly.
db.prepare("UPDATE deployment_binding SET owner_user_id=?, primary_bot_id=? WHERE singleton=1").run('usr-owner', 'bot-erase');

const seedContent = async () => {
  await writeFile(memoryFile, ['Prefers oat milk', 'Bank PIN is 4417'].join(SEP) + '\n');
  await writeFile(userFile, 'Speaks Suomi at home\n');
  db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES (?,?,?,?,?,?,?)')
    .run('bot-erase', 1, 1, 1, 'message', JSON.stringify({ type: 'message', role: 'user', text: 'My name is Aino' }), 10);
  db.prepare('INSERT INTO llm_items(bot_id,generation,idx,item) VALUES (?,?,?,?)')
    .run('bot-erase', 1, 0, JSON.stringify({ role: 'user', content: 'My name is Aino' }));
  db.prepare('INSERT INTO pending_turns(bot_id,state) VALUES (?,?)').run('bot-erase', 'queued');
  db.prepare('INSERT INTO approvals(id,bot_id,row_seq,call_id,tool,status,created_at) VALUES (?,?,?,?,?,?,?)')
    .run('apr-erase', 'bot-erase', 1, 'call-1', 'composio.gmail.send', 'allowed', 11);
  setLive('bot-erase', { activity: { kind: 'remembering', since: 1 } });
  const memories = listMemories('bot-erase');
  syncMemoryIndex('bot-erase', memories);
  return memories;
};

test('planning rejects an unknown legal basis and a subject that is not the tenant\'s', async () => {
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('usr-other', 'other@example.test', 'Other', 1);
  seedBot('bot-foreign', 'usr-other');

  await assert.rejects(
    () => requestDeletion({ tenantId: 'usr-owner', botId: 'bot-erase', basis: 'because_i_said_so', requestedBy: 'usr-owner' }),
    (error) => error instanceof PrivacyDeletionError && error.code === 'invalid_basis',
  );
  await assert.rejects(
    () => requestDeletion({ tenantId: 'usr-owner', botId: 'bot-foreign', basis: 'user_request', requestedBy: 'usr-owner' }),
    (error) => error instanceof PrivacyDeletionError && error.code === 'subject_not_found',
  );
  await assert.rejects(
    () => requestDeletion({ tenantId: 'usr-owner', botId: 'bot-missing', basis: 'user_request', requestedBy: 'usr-owner' }),
    (error) => error instanceof PrivacyDeletionError && error.code === 'subject_not_found',
  );
});

test('a request plans every holder: memory entries, conversation, cache, index — and retains audit evidence with its rule', async () => {
  const memories = await seedContent();
  const request = await requestDeletion({ tenantId: 'usr-owner', botId: 'bot-erase', basis: 'user_request', requestedBy: 'usr-owner' });

  assert.equal(request.state, 'pending');
  assert.equal(request.targets.filter((t) => t.holder === 'memory' && t.action === 'purge').length, memories.length);
  assert.ok(request.targets.some((t) => t.holder === 'conversation' && t.action === 'purge'));
  assert.ok(request.targets.some((t) => t.holder === 'cache' && t.action === 'purge'));
  assert.ok(request.targets.some((t) => t.holder === 'index' && t.action === 'purge'));
  const evidence = request.targets.filter((t) => t.holder === 'evidence');
  assert.ok(evidence.length >= 1, 'approval history is evidence');
  for (const target of evidence) {
    assert.equal(target.action, 'retain_exception');
    assert.ok(target.exceptionRule && EVIDENCE_RETENTION_RULES[target.exceptionRule], 'a retained target names a known rule');
  }
  assert.equal(getDeletionRequest(request.id).targets.length, request.targets.length, 'the plan is persisted');
});

test('running a request erases content from files, DB, cache and index while the receipt verifies', async () => {
  const before = listDeletionRequests('usr-owner', 'bot-erase').find((r) => r.state === 'pending');
  assert.ok(before, 'a pending request exists from planning');
  const request = await runDeletion(before.id);

  assert.equal(request.state, 'completed', request.lastError ?? '');
  assert.equal(await readFile(memoryFile, 'utf8').then((s) => s.trim()), '', 'memory file content is gone');
  assert.ok(!(await readFile(userFile, 'utf8')).includes('Suomi'), 'user profile content is gone');

  assert.equal(db.prepare('SELECT COUNT(*) n FROM rows WHERE bot_id=?').get('bot-erase').n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM llm_items WHERE bot_id=?').get('bot-erase').n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM pending_turns WHERE bot_id=?').get('bot-erase').n, 0);
  assert.deepEqual(getLive('bot-erase'), { botId: 'bot-erase', isRunning: false, activity: null, awaiting: null, startedAt: null });
  assert.deepEqual(searchMemory('bot-erase', 'oat'), []);
  assert.deepEqual(searchMemory('bot-erase', 'aino'), []);

  // Evidence retention exception: the audit row survives, and the target says why.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM approvals WHERE bot_id=?').get('bot-erase').n, 1);
  const retained = request.targets.filter((t) => t.action === 'retain_exception');
  assert.ok(retained.every((t) => t.state === 'retained' && t.exceptionRule === 'audit:approval_history'));

  assert.equal(request.receiptHash.length, 64);
  assert.equal(verifyDeletionReceipt(request.id), true);
});

test('a completed request is idempotent: rerun and a repeated request key change nothing', async () => {
  const completed = listDeletionRequests('usr-owner', 'bot-erase').find((r) => r.state === 'completed');
  const again = await runDeletion(completed.id);
  assert.equal(again.state, 'completed');
  assert.equal(again.receiptHash, completed.receiptHash);
  assert.equal(again.completedAt, completed.completedAt);

  const repeated = await requestDeletion({
    tenantId: 'usr-owner', botId: 'bot-erase', basis: 'user_request', requestedBy: 'usr-owner', requestKey: 'key-repeat',
  });
  const second = await requestDeletion({
    tenantId: 'usr-owner', botId: 'bot-erase', basis: 'user_request', requestedBy: 'usr-owner', requestKey: 'key-repeat',
  });
  assert.equal(second.id, repeated.id, 'the same idempotency key returns the same request');
  await assert.rejects(
    () => requestDeletion({ tenantId: 'usr-owner', botId: 'bot-other', basis: 'user_request', requestedBy: 'usr-owner', requestKey: 'key-repeat' }),
    (error) => error instanceof PrivacyDeletionError && error.code === 'request_key_conflict',
  );
});

test('a failing holder leaves the request partial with a retry path; completion is never faked', async () => {
  seedBot('bot-partial', 'usr-owner', 'managed');
  const partialHome = path.join(process.env.ENGINES_DIR, 'bot-partial');
  await mkdir(path.join(partialHome, 'memories'), { recursive: true });
  const partialMemory = path.join(partialHome, 'memories', 'MEMORY.md');
  await writeFile(partialMemory, 'Partial run memory\n');
  const planned = await requestDeletion({ tenantId: 'usr-owner', botId: 'bot-partial', basis: 'consent_withdrawal', requestedBy: 'usr-owner' });

  const failing = defaultHolders.map((holder) => holder.name === 'memory'
    ? { ...holder, purge: async () => { throw new Error('disk unavailable'); } }
    : holder);
  const partial = await runDeletion(planned.id, { holders: failing });
  assert.equal(partial.state, 'partial');
  assert.match(partial.lastError, /disk unavailable/);
  assert.ok(partial.targets.some((t) => t.state === 'failed'));
  assert.equal((await readFile(partialMemory, 'utf8')).includes('Partial run memory'), true, 'a failed purge leaves the bytes in place');

  const repaired = await runDeletion(planned.id);
  assert.equal(repaired.state, 'completed');
  assert.ok(!(await readFile(partialMemory, 'utf8')).includes('Partial run memory'));
  assert.equal(verifyDeletionReceipt(planned.id), true);
});

test('a running agent is refused before any target is touched', async () => {
  seedBot('bot-busy', 'usr-owner', 'managed');
  const busyHome = path.join(process.env.ENGINES_DIR, 'bot-busy');
  await mkdir(path.join(busyHome, 'memories'), { recursive: true });
  const busyMemory = path.join(busyHome, 'memories', 'MEMORY.md');
  await writeFile(busyMemory, 'Busy agent memory\n');
  const planned = await requestDeletion({ tenantId: 'usr-owner', botId: 'bot-busy', basis: 'user_request', requestedBy: 'usr-owner' });

  await assert.rejects(
    () => runDeletion(planned.id, { isBusy: () => true }),
    (error) => error instanceof PrivacyDeletionError && error.code === 'agent_busy',
  );
  assert.equal(getDeletionRequest(planned.id).state, 'pending', 'the plan is untouched, so it can be retried');
  assert.ok((await readFile(busyMemory, 'utf8')).includes('Busy agent memory'));

  assert.equal((await runDeletion(planned.id)).state, 'completed');
  assert.ok(!(await readFile(busyMemory, 'utf8')).includes('Busy agent memory'));
});

test('a tampered target breaks the receipt, and receipts survive removal of the subject', async () => {
  const completed = listDeletionRequests('usr-owner', 'bot-erase').find((r) => r.state === 'completed');
  assert.equal(verifyDeletionReceipt(completed.id), true);
  db.prepare("UPDATE privacy_deletion_targets SET state='planned' WHERE request_id=? AND rowid=(SELECT MIN(rowid) FROM privacy_deletion_targets WHERE request_id=?)")
    .run(completed.id, completed.id);
  assert.equal(verifyDeletionReceipt(completed.id), false, 'a rewritten target no longer matches the receipt');

  // Evidence retention: deleting the agent must not erase the proof that its data was deleted.
  db.prepare('DELETE FROM bots WHERE id=?').run('bot-other');
  assert.ok(getDeletionRequest(completed.id));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  classifyFailure, setFallbackChain, getFallbackChain, restLogin, loginResting, switchBack,
  nextStep, ledgerEntry, handoverLedger,
} from '../server/src/lib/agent-fallback.ts';

function db() { return new Database(':memory:'); }

test('failure text classifies before category, per Codync lesson: usage is not a transient 429', () => {
  assert.equal(classifyFailure("You've hit your usage limit"), 'usageLimit');
  assert.equal(classifyFailure('billing_error: account_on_hold'), 'outOfCredits');
  assert.equal(classifyFailure('no live kernel running that model'), 'notStarting');
  assert.equal(classifyFailure('authentication_failed'), 'signedOut');
  assert.equal(classifyFailure('model_not_found'), 'modelMissing');
  assert.equal(classifyFailure('rate limit exceeded'), 'rateLimited');
});

test('chain is bounded to 3 steps and each login appears once', () => {
  const d = db();
  assert.throws(() => setFallbackChain(d, 'bot_a', [
    { agent: 'a', model: 'm', loginKey: 'l1' }, { agent: 'b', model: 'm', loginKey: 'l2' },
    { agent: 'c', model: 'm', loginKey: 'l3' }, { agent: 'd', model: 'm', loginKey: 'l4' },
  ]));
  assert.throws(() => setFallbackChain(d, 'bot_a', [
    { agent: 'a', model: 'm', loginKey: 'l1' }, { agent: 'b', model: 'm', loginKey: 'l1' },
  ]));
});

test('a rested login is shared: another bot on the same login sees it resting too', () => {
  const d = db();
  setFallbackChain(d, 'bot_a', [{ agent: 'claude', model: 'sonnet', loginKey: 'login_x' }, { agent: 'codex', model: 'gpt', loginKey: 'login_y' }]);
  setFallbackChain(d, 'bot_b', [{ agent: 'claude', model: 'sonnet', loginKey: 'login_x' }]);
  restLogin(d, 'login_x', 'rateLimited');
  assert.equal(loginResting(d, 'login_x').resting, true);
  const next = nextStep(d, 'bot_a');
  assert.equal(next?.step.loginKey, 'login_y'); // moved to codex, login_x is resting
  assert.equal(nextStep(d, 'bot_b'), null); // bot_b's only step shares the resting login
  switchBack(d, 'login_x');
  assert.equal(loginResting(d, 'login_x').resting, false);
});

test('modelMissing never rests a login — it is the bot setup, not the provider', () => {
  const d = db();
  restLogin(d, 'login_z', 'modelMissing');
  assert.equal(loginResting(d, 'login_z').resting, false);
});

test('the ledger is an index, capped, newest first, never a diff or output', () => {
  const d = db();
  for (let i = 0; i < 15; i++) ledgerEntry(d, 'bot_a', 'file', `/path/${i}.ts`);
  ledgerEntry(d, 'bot_a', 'command', 'npm test');
  const ledger = handoverLedger(d, 'bot_a');
  assert.equal(ledger.files.length, 10);
  assert.equal(ledger.moreFiles, 5);
  assert.equal(ledger.files[0], '/path/14.ts'); // newest first
  assert.ok(!('output' in ledger));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { duskbotBlocked, mayVendor, SOURCE_RIGHTS } from '../server/src/lib/source-rights.ts';
import { autonomyDecision, getAutonomy, setAutonomy } from '../server/src/lib/autonomy.ts';
import { polyglotMap } from '../server/src/lib/polyglot-map.ts';

test('duskbot source is not vendored', () => {
  const dusk = SOURCE_RIGHTS.find((row) => row.repo === 'DuskBotAI/duskbot');
  assert.equal(dusk?.vendored, false);
  assert.match(dusk?.license ?? '', /Noncommercial/);
  assert.equal(mayVendor('DuskBotAI/duskbot'), false);
  assert.equal(duskbotBlocked().ok, false);
});

test('ask is the default and act is explicit', () => {
  const db = new Database(':memory:');
  assert.equal(getAutonomy(db, 'bot_a'), 'ask');
  assert.equal(autonomyDecision('ask', 'spawn_sid_subagent'), 'ask');
  assert.equal(autonomyDecision('act', 'spawn_sid_subagent'), 'allow');
  assert.equal(setAutonomy(db, 'bot_a', 'draft'), 'draft');
  assert.equal(autonomyDecision('draft', 'save_file'), 'allow');
  assert.equal(autonomyDecision('draft', 'send_to_bot'), 'ask');
});

test('polyglot map names a language per niche', () => {
  const map = polyglotMap();
  assert.ok(map.some((row) => row.language === 'Rust' && row.niche === 'enforcement'));
  assert.ok(map.some((row) => row.language === 'Elixir'));
  assert.ok(map.every((row) => typeof row.present === 'boolean'));
});

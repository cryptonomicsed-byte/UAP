import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { recordTurnFailure, setFallbackChain } from '../server/src/lib/agent-fallback.ts';
import { getBotTheme, setBotTheme } from '../server/src/lib/theme-sanitize.ts';

test('a turn failure with no configured chain is a no-op', () => {
  const d = new Database(':memory:');
  assert.equal(recordTurnFailure(d, 'bot_x', 'provider_rate_limited'), null);
});

test('a turn failure rests the active login and names the next agent', () => {
  const d = new Database(':memory:');
  setFallbackChain(d, 'bot_x', [
    { agent: 'claude', model: 'sonnet', loginKey: 'login_a' },
    { agent: 'codex', model: 'gpt', loginKey: 'login_b' },
  ]);
  const result = recordTurnFailure(d, 'bot_x', 'provider_rate_limited');
  assert.equal(result?.restedLogin, 'login_a');
  assert.equal(result?.reason, 'rateLimited');
  assert.equal(result?.nextAgent, 'codex');
});

test('an unmapped failure code is a no-op even with a chain configured', () => {
  const d = new Database(':memory:');
  setFallbackChain(d, 'bot_x', [{ agent: 'claude', model: 'sonnet', loginKey: 'login_a' }]);
  assert.equal(recordTurnFailure(d, 'bot_x', 'some_unknown_code'), null);
});

test('bot theme round-trips sanitized tokens scoped to that bot only', () => {
  const d = new Database(':memory:');
  const tokens = setBotTheme(d, 'bot_x', `.sid-theme-bot_x { --color-primary: teal; } .sid-theme-bot_y { --color-primary: red; }`);
  assert.deepEqual(tokens, { '--color-primary': 'teal' }); // bot_y's rule never applies to bot_x
  const stored = getBotTheme(d, 'bot_x');
  assert.deepEqual(stored.tokens, { '--color-primary': 'teal' });
  assert.match(stored.css, /sid-theme-bot_x/);
});

test('an exfil attempt in a bot theme never reaches saved tokens', () => {
  const d = new Database(':memory:');
  const tokens = setBotTheme(d, 'bot_x', `.sid-theme-bot_x { --bg: url(https://evil.example/x); --accent: teal; }`);
  assert.deepEqual(tokens, { '--accent': 'teal' });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { shortSha, boardClosed, deployBadgeText } from '../web/src/lib/deploy-format.ts';

test('shortSha truncates and handles empty', () => {
  assert.equal(shortSha(null), '—');
  assert.equal(shortSha(''), '—');
  assert.equal(shortSha('0dd974907a9ba9eba50209950053c6586824a5fc'), '0dd9749');
});

test('boardClosed sums done+verified', () => {
  const r = boardClosed({ total: 64, done: 37, verified: 27, pending: 0 });
  assert.equal(r.closed, 64);
  assert.equal(r.total, 64);
  assert.equal(r.label, '64/64 closed');
});

test('deployBadgeText is glanceable', () => {
  assert.equal(deployBadgeText(null), 'deploy …');
  assert.match(
    deployBadgeText({
      sha: '0dd974907a9ba9eba50209950053c6586824a5fc',
      board: { total: 64, done: 37, verified: 27 },
    }),
    /^UAP 0dd9749 · 64\/64 closed$/,
  );
});

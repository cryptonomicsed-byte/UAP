import assert from 'node:assert/strict';
import test from 'node:test';

const selected = 'agent-a';
const secret = 'fixture-only private text';
const row = (seq, body, botId = selected, createdAt = 1000 * seq) => ({
  botId, generation: 3, seq, updatedSeq: seq, kind: body.type, body, createdAt,
});

function toolCall(status, fields = {}) {
  return {
    type: 'tool-call', status, name: 'read_file', label: secret, callId: secret,
    args: { path: secret }, summary: secret, screenshot: `https://example.test/${secret}`,
    ...fields,
  };
}

test('activity projects only scoped tool statuses, notices and run requests, newest first', async () => {
  const { activityEntries } = await import('../web/src/components/studio/AgentActivity.tsx');
  const rows = [
    row(2, { type: 'event', event: 'routine-run', text: secret, ref: secret }, selected, 1000),
    row(1, toolCall('awaiting-approval')),
    row(3, { type: 'notice', tone: 'error', code: 'provider_auth', text: secret }),
    row(4, toolCall('done'), 'agent-b'),
    row(5, { type: 'message', role: 'assistant', text: secret }),
    row(6, { type: 'event', event: 'routine-created', text: secret }),
    row(7, { type: 'card', card: 'approval', status: 'allowed', detail: secret, args: secret }),
  ];
  const entries = activityEntries(selected, rows);
  assert.deepEqual(entries.map(({ label, status, at }) => [label, status, at]), [
    ['Provider authentication failed', 'Error', 3000],
    ['Automation run', 'Requested', 1000],
    ['Read files', 'Awaiting approval', 1000],
  ]);
  assert.deepEqual(rows.map(({ seq }) => seq), [2, 1, 3, 4, 5, 6, 7]);
  assert.doesNotMatch(JSON.stringify(entries), new RegExp(secret));
});

test('activity distinguishes recorded tool states without exposing unknown labels or notice codes', async () => {
  const { activityEntries } = await import('../web/src/components/studio/AgentActivity.tsx');
  const entries = activityEntries(selected, [
    row(1, toolCall('running')),
    row(2, toolCall('done')),
    row(3, toolCall('error')),
    row(4, toolCall('denied')),
    row(5, toolCall('denied', { name: `external-${secret}` })),
    row(6, { type: 'notice', tone: 'warn', code: secret, text: secret }),
    row(7, { type: 'notice', code: '__proto__', text: secret }),
  ]);
  assert.deepEqual(entries.map(({ label, status }) => [label, status]), [
    ['Agent notice', 'Info'],
    ['Agent notice', 'Warning'],
    ['Tool step', 'Denied'],
    ['Read files', 'Denied'],
    ['Read files', 'Failed'],
    ['Read files', 'Completed'],
    ['Read files', 'Running'],
  ]);
  assert.doesNotMatch(JSON.stringify(entries), new RegExp(secret));
});

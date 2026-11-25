import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SESSION_SECRET ??= 'email-test-secret';
delete process.env.SPACEMAIL_SMTP_PASS;
delete process.env.SPACEMAIL_SMTP_PASS_FILE;
const { isEmailConfigured, sendEmail } = await import('../server/src/lib/email.ts');

test('isEmailConfigured is honestly false with no mailbox password set', () => {
  assert.equal(isEmailConfigured(), false);
});

test('sendEmail refuses to pretend to send when not configured, never silently no-ops', async () => {
  await assert.rejects(() => sendEmail({ to: 'x@example.com', subject: 's', text: 't' }), /not configured/);
});

test('the default mailbox address is the real one, not a placeholder', async () => {
  const { env } = await import('../server/src/env.ts');
  assert.equal(env.spacemailUser, 'uap@omokoda.space');
});

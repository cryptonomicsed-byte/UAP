import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

process.env.SESSION_SECRET ??= 'local-stt-test-secret';
const { transcribeLocal } = await import('../server/src/lib/local-stt.ts');

test('real offline STT transcribes real synthesized speech (no mocking)', (t) => {
  if (!fs.existsSync('/opt/ares/UAP/.venv-stt/bin/python3')) {
    t.skip('local STT venv not present on this host');
    return;
  }
  const wav = execFileSync('espeak-ng', ['-v', 'en-us', '-s', '160', '--stdout', 'testing one two three the quick brown fox']);
  const text = transcribeLocal(wav).toLowerCase();
  assert.match(text, /fox/, `expected a recognizable word in "${text}"`);
  assert.match(text, /quick|brown/, `expected another recognizable word in "${text}"`);
});

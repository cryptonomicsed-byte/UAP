import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SESSION_SECRET ??= 'local-tts-test-secret';
const { synthesizeLocal, LOCAL_VOICE_DEFS, localVoiceDef } = await import('../server/src/lib/local-tts.ts');

test('5 real, distinct free voices exist, not 2 cosmetic labels over nothing', () => {
  assert.equal(LOCAL_VOICE_DEFS.length, 5);
  const uniqueEspeakVoices = new Set(LOCAL_VOICE_DEFS.map((v) => v.espeakVoice));
  assert.ok(uniqueEspeakVoices.size >= 3, 'at least 3 genuinely different underlying espeak-ng voices');
});

test('synthesizeLocal actually produces real WAV audio bytes, not a mocked buffer', () => {
  const wav = synthesizeLocal('This is a real local voice test.', 'local-default', 1);
  assert.ok(wav.length > 1000, 'a real synthesized clip is not tiny');
  assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF', 'espeak-ng --stdout emits a real RIFF/WAV header');
});

test('an unknown voice id falls back to the default rather than throwing', () => {
  assert.equal(localVoiceDef('not-a-real-id').id, 'local-default');
});

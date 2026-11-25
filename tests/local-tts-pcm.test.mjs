import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SESSION_SECRET ??= 'local-tts-pcm-test-secret';
const { synthesizeLocalPcm } = await import('../server/src/lib/local-tts.ts');

test('synthesizeLocalPcm produces headerless raw PCM, not a WAV container', () => {
  const pcm = synthesizeLocalPcm('Testing raw PCM output.', 'local-default', 1, 24000);
  assert.ok(pcm.length > 1000);
  // A WAV file always starts with the literal bytes "RIFF" -- raw PCM must not.
  assert.notEqual(pcm.subarray(0, 4).toString('ascii'), 'RIFF');
  // Byte length must be an even number of 16-bit samples.
  assert.equal(pcm.length % 2, 0);
});

test('a different sample rate produces a different (resampled) byte length for the same text', () => {
  const at16k = synthesizeLocalPcm('Same short sentence.', 'local-default', 1, 16000);
  const at24k = synthesizeLocalPcm('Same short sentence.', 'local-default', 1, 24000);
  // Roughly proportional to the sample rate (24000/16000 = 1.5x), not an exact ratio because
  // of real encoder framing, so just assert 24k is clearly bigger, not equal.
  assert.ok(at24k.length > at16k.length);
});

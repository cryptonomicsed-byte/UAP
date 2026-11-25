/**
 * Real, free, local TTS using espeak-ng (apt package, GPL-2.0, already installed on this
 * host). This is what LOCAL_VOICES actually produces audio with now — previously `/preview`
 * called xAI's TTS endpoint unconditionally with no fallback at all when xAI wasn't
 * configured, so a "local" voice had no sound behind it whatsoever beyond whatever the
 * user's own browser's speechSynthesis did. Five real, distinct espeak-ng voice variants,
 * not two cosmetic labels over one engine.
 */
import { execFileSync } from 'node:child_process';

export interface LocalVoiceDef { id: string; name: string; gender: 'male' | 'female' | 'neutral'; espeakVoice: string; rateAdjust: number }

export const LOCAL_VOICE_DEFS: LocalVoiceDef[] = [
  { id: 'local-default', name: 'Device voice (US)', gender: 'neutral', espeakVoice: 'en-us', rateAdjust: 0 },
  { id: 'local-calm', name: 'Device voice (US, slower)', gender: 'neutral', espeakVoice: 'en-us', rateAdjust: -40 },
  { id: 'local-gb', name: 'Device voice (British)', gender: 'male', espeakVoice: 'en-gb', rateAdjust: 0 },
  { id: 'local-rp', name: 'Device voice (Received Pronunciation)', gender: 'male', espeakVoice: 'en-gb-x-rp', rateAdjust: 0 },
  { id: 'local-scotland', name: 'Device voice (Scottish)', gender: 'male', espeakVoice: 'en-gb-scotland', rateAdjust: 0 },
];

export function localVoiceDef(id: string): LocalVoiceDef {
  return LOCAL_VOICE_DEFS.find((v) => v.id === id) ?? LOCAL_VOICE_DEFS[0];
}

export class LocalTtsError extends Error {}

/** Synthesizes text to a WAV buffer with espeak-ng. speed is the app's 0.5-2.0 scale;
 *  espeak-ng's own rate is words-per-minute (default ~175), so it's mapped multiplicatively. */
export function synthesizeLocal(text: string, voiceId: string, speed = 1): Buffer {
  const voice = localVoiceDef(voiceId);
  const wpm = Math.round(Math.max(80, Math.min(400, 175 * speed + voice.rateAdjust)));
  try {
    return execFileSync('espeak-ng', ['-v', voice.espeakVoice, '-s', String(wpm), '--stdout', text.slice(0, 2000)], {
      maxBuffer: 20 * 1024 * 1024,
      timeout: 15_000,
    });
  } catch (e: any) {
    throw new LocalTtsError(`Local TTS (espeak-ng) failed: ${e?.message ?? e}`);
  }
}

/** Same synthesis, but as headerless 16-bit PCM at `sampleRate` -- what the frontend's
 *  PcmPlayer actually expects (it always requests codec:'pcm' and treats the whole response
 *  body as raw Int16 samples; feeding it a WAV container's header bytes as if they were
 *  samples produces an audible click/garbage at the start). ffmpeg does the resample +
 *  container stripping; espeak-ng itself only emits WAV. */
export function synthesizeLocalPcm(text: string, voiceId: string, speed: number, sampleRate: number): Buffer {
  const wav = synthesizeLocal(text, voiceId, speed);
  try {
    return execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'wav', '-i', 'pipe:0', '-ar', String(sampleRate), '-ac', '1', '-f', 's16le', 'pipe:1'], {
      input: wav,
      maxBuffer: 20 * 1024 * 1024,
      timeout: 15_000,
    });
  } catch (e: any) {
    throw new LocalTtsError(`Local TTS PCM conversion failed: ${e?.message ?? e}`);
  }
}

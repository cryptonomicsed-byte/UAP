/**
 * Real, free, offline STT via Vosk (Apache-2.0, small English model already downloaded to
 * data/vosk-model/) + ffmpeg for format conversion. Closes the other half of "why are we
 * hardcoded to grok voice": /voice/stt previously had NO fallback at all when xAI wasn't
 * configured -- dictation just failed outright. This never touches a paid API; the
 * Python+venv path is fixed (not inherited from PATH) so it doesn't depend on the calling
 * process's environment.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VENV_PYTHON = '/opt/ares/UAP/.venv-stt/bin/python3';
const SCRIPT = new URL('../../../scripts/stt_local.py', import.meta.url).pathname;

export class LocalSttError extends Error {}

/** input: whatever the browser recorded (webm/ogg/wav/...), as a Buffer. */
export function transcribeLocal(input: Buffer): string {
  if (!fs.existsSync(VENV_PYTHON)) throw new LocalSttError('Local STT is not installed on this host (missing .venv-stt).');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uap-stt-'));
  const inPath = path.join(dir, 'in.audio');
  const wavPath = path.join(dir, 'out.wav');
  try {
    fs.writeFileSync(inPath, input);
    execFileSync('ffmpeg', ['-y', '-i', inPath, '-ar', '16000', '-ac', '1', '-f', 'wav', wavPath], { timeout: 20_000, stdio: ['ignore', 'ignore', 'pipe'] });
    const out = execFileSync(VENV_PYTHON, [SCRIPT, wavPath], { timeout: 20_000, encoding: 'utf8' });
    return out.trim();
  } catch (e: any) {
    throw new LocalSttError(`Local STT failed: ${e?.message ?? e}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The page a QR code opens: no UAP login, no app shell -- just one bot, a push-to-talk
 * button, and our own real local STT/TTS (never xAI, so it works with no provider keys at
 * all). Mirrors the /call/<slug> orb pattern from the other HelixMain repos.
 */
import { useEffect, useRef, useState } from 'react';

type Phase = 'loading' | 'ready' | 'notfound' | 'recording' | 'thinking' | 'speaking' | 'error';

export function PublicCall({ token }: { token: string }) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [botName, setBotName] = useState('');
  const [lines, setLines] = useState<{ role: 'user' | 'assistant'; text: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);

  useEffect(() => {
    fetch(`/api/public-call/${token}`)
      .then((r) => { if (!r.ok) throw new Error('not found'); return r.json(); })
      .then((d) => { setBotName(d.botName); setPhase('ready'); })
      .catch(() => setPhase('notfound'));
  }, [token]);

  async function speak(text: string) {
    setPhase('speaking');
    try {
      const res = await fetch(`/api/public-call/${token}/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      if (!res.ok) throw new Error();
      const buf = await res.arrayBuffer();
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      const pcm = new Int16Array(buf);
      const audioBuf = ctx.createBuffer(1, pcm.length, 24000);
      const ch = audioBuf.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
      const src = ctx.createBufferSource();
      src.buffer = audioBuf;
      src.connect(ctx.destination);
      src.onended = () => { setPhase('ready'); void ctx.close(); };
      src.start();
    } catch {
      setPhase('ready');
    }
  }

  async function sendTurn(text: string) {
    setLines((l) => [...l, { role: 'user', text }]);
    setPhase('thinking');
    try {
      const res = await fetch(`/api/public-call/${token}/turn`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      const d = await res.json();
      if (!res.ok) { setError(d.error ?? 'No reply yet.'); setPhase('ready'); return; }
      setLines((l) => [...l, { role: 'assistant', text: d.text }]);
      void speak(d.text);
    } catch {
      setError('Could not reach the agent.');
      setPhase('ready');
    }
  }

  async function startRecording() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: rec.mimeType });
        setPhase('thinking');
        const fd = new FormData();
        fd.append('file', blob, 'speech.webm');
        const res = await fetch(`/api/public-call/${token}/stt`, { method: 'POST', body: fd });
        const d = await res.json();
        const text = (d.text ?? '').trim();
        if (!res.ok || !text) { setError(d.error ?? "Didn't catch that -- try again."); setPhase('ready'); return; }
        void sendTurn(text);
      };
      rec.start();
      recRef.current = rec;
      setPhase('recording');
    } catch {
      setError('Microphone access failed.');
    }
  }

  function stopRecording() {
    recRef.current?.stop();
  }

  if (phase === 'loading') return <div className="public-call public-call--state">Loading…</div>;
  if (phase === 'notfound') return <div className="public-call public-call--state">This call link is no longer valid.</div>;

  return (
    <div className="public-call">
      <h1>{botName}</h1>
      <div className="public-call__transcript">
        {lines.map((l, i) => <p key={i} className={`public-call__line public-call__line--${l.role}`}>{l.text}</p>)}
      </div>
      {error && <p className="public-call__error" role="alert">{error}</p>}
      <button
        type="button"
        className={`public-call__btn public-call__btn--${phase}`}
        disabled={phase === 'thinking' || phase === 'speaking'}
        onMouseDown={startRecording}
        onMouseUp={stopRecording}
        onTouchStart={startRecording}
        onTouchEnd={stopRecording}
      >
        {phase === 'recording' ? 'Release to send' : phase === 'thinking' ? 'Thinking…' : phase === 'speaking' ? 'Speaking…' : `Hold to talk to ${botName || 'the agent'}`}
      </button>
      <p className="public-call__hint">No account needed. Runs on this server's own free voice stack.</p>
    </div>
  );
}

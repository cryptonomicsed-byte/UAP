import { useRef, useState } from 'react';
import { api } from '../../lib/api';
import { useStore } from '../../store';
import { Modal } from './Modal';

interface Draft { name: string; register: boolean; key: string }

function readDraft(storageKey: string): Draft | null {
  try {
    const draft = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') as Draft | null;
    return draft && typeof draft.name === 'string' && typeof draft.register === 'boolean' && typeof draft.key === 'string' ? draft : null;
  } catch { return null; }
}

export function OmokodaBirthModal({ onClose }: { onClose: () => void }) {
  const userId = useStore((s) => s.user?.id);
  const storageKey = `uap.omokoda.birth.${userId}`;
  const [draft, setDraft] = useState(() => readDraft(storageKey));
  const [name, setName] = useState(draft?.name ?? '');
  const [register, setRegister] = useState(draft?.register ?? true);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<Awaited<ReturnType<typeof api.birthOmokoda>> | null>(null);

  async function submit() {
    if (!userId || inFlight.current || !name.trim() || created) return;
    const request = draft ?? { name: name.trim(), register, key: crypto.randomUUID() };
    inFlight.current = true;
    setBusy(true);
    setError('');
    setDraft(request);
    try { sessionStorage.setItem(storageKey, JSON.stringify(request)); } catch { /* retain the in-memory key */ }
    try {
      const result = await api.birthOmokoda({ name: request.name, register: request.register }, request.key);
      setCreated(result);
      try { sessionStorage.removeItem(storageKey); } catch { /* a replay is harmless */ }
      const st = useStore.getState();
      await st.loadBots().catch(() => {});
      if (useStore.getState().bots.some((b) => b.id === result.botId)) st.selectBot(result.botId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Birth could not be confirmed.');
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }

  function close() { if (!inFlight.current) onClose(); }

  return (
    <Modal onClose={close} className="create-modal" label="Create an Omokoda agent">
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <div className="modal__header"><div className="modal__title">Create an Omokoda agent</div></div>
        <div className="create-modal__body">
          {created ? <div role="status">
            <p>Agent created in this UAP workspace.</p>
            <p>SID: {created.sid}</p>
            {created.vantage.status === 'registered' && <p>Registered on Vantage.</p>}
            {created.vantage.status === 'failed' && <p>Vantage registration could not be confirmed. Do not create another agent to retry registration.</p>}
            {created.vantage.status === 'skipped' && <p>Vantage registration skipped: {created.vantage.reason}.</p>}
          </div> : <>
            <p>Birth takes place in the signed-in UAP workspace. Your Vantage credentials are not transferred.</p>
            <label>Agent name <input className="text-input" value={name} maxLength={64} disabled={!!draft} onChange={(e) => setName(e.target.value)} required /></label>
            <label><input type="checkbox" checked={register} disabled={!!draft} onChange={(e) => setRegister(e.target.checked)} /> Register the agent on Vantage</label>
            {error && <div role="alert" className="card__error">{error} Retry uses the same birth request.</div>}
          </>}
        </div>
        <div className="modal__footer">
          <button type="button" className="btn btn--secondary btn--sm" onClick={close} disabled={busy}>{created ? 'Done' : 'Cancel'}</button>
          {!created && <button type="submit" className="btn btn--primary btn--sm" disabled={busy || !name.trim()}>{busy ? 'Creating…' : draft ? 'Check same request' : 'Create agent'}</button>}
        </div>
      </form>
    </Modal>
  );
}

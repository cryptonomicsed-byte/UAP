/**
 * "Engine" section of the details panel: which provider and model run this bot's agent,
 * signing in to a subscription, and the agent's status. Every call fails soft: if the engine
 * endpoints are missing or down, the section says so and the rest of the panel is unaffected.
 *
 * Restored from this project's own MIT-licensed ancestor, nickvasilescu/bot-hq
 * (web/src/components/EngineSettings.tsx) -- a prior UAP revision had disabled the actual
 * provider/model picker in favor of a read-only "change it in Hermes" message. The real
 * mechanism is simpler than a config.yaml rewrite: the chosen provider/model ride along in
 * every turn's request body (server/src/agent/loop.ts), so a change here takes effect on the
 * bot's very next turn, no restart required (restart is still offered for a stuck engine).
 *
 * The primary/managed split below is UAP's own addition, kept from the version this replaces:
 * the primary gateway also carries this app's messaging, so it is never restarted or
 * model-switched from here -- only a managed bot's own Hermes home gets the full picker.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Bot, EngineInfo, EngineProvider } from '@shared/types';
import { configApi } from '../lib/configApi';
import { useStore } from '../store';
import { Icon } from './Icon';

const KIND: Record<EngineProvider['kind'], string> = { subscription: 'Subscription', api_key: 'API key' };
const STATUS: Record<EngineInfo['status'], string> = { ready: 'ready', starting: 'starting', stopped: 'stopped', error: 'error' };

/** Connected providers first; otherwise the server's order. */
function sortProviders(list: EngineProvider[]): EngineProvider[] {
  return [...list].sort((a, b) => Number(b.connected) - Number(a.connected));
}

export function EngineSettings({ bot }: { bot: Bot }) {
  const viewerOpen = useStore((s) => s.viewerOpen);
  const set = useStore((s) => s.set);
  const [engine, setEngine] = useState<EngineInfo | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ok' | 'unavailable'>('loading');
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState<'save' | 'signin' | 'restart' | 'screen' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const dirty = useRef(false);
  const request = useRef(0);
  const botId = bot.id;

  const apply = useCallback((e: EngineInfo, keepDraft = false) => {
    setEngine(e); setPhase('ok');
    if (!keepDraft || !dirty.current) { dirty.current = false; setProvider(e.provider ?? ''); setModel(e.model ?? ''); }
    // Keep the bot's model label in step without waiting for the server's `bot` event.
    useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === e.botId && (b.model !== e.model || b.provider !== e.provider) ? { ...b, model: e.model, provider: e.provider } : b)) }));
  }, []);

  /** Quiet refreshes keep what is on screen if the call fails. */
  const load = useCallback((quiet = false) => {
    const revision = ++request.current;
    if (!quiet) setPhase('loading');
    setNote(null);
    configApi.engine(botId)
      .then((r) => { if (request.current === revision) { if (r?.engine) apply(r.engine, quiet); else if (!quiet) setPhase('unavailable'); } })
      .catch(() => { if (request.current === revision && !quiet) setPhase('unavailable'); });
  }, [botId, apply]);

  useEffect(() => { dirty.current = false; setEngine(null); setBusy(null); setNote(null); setSigningIn(false); load(); return () => { request.current++; }; }, [load]);

  // The agent takes a moment to come up after a change or a restart.
  const starting = engine?.status === 'starting';
  useEffect(() => {
    if (!starting) return;
    const t = setInterval(() => load(true), 3000);
    return () => clearInterval(t);
  }, [starting, load]);

  // Signing in happens on the bot's computer. Check while that view is open, and once more when it closes.
  useEffect(() => {
    if (!signingIn) return;
    if (!viewerOpen) { setSigningIn(false); load(true); return; }
    const t = setInterval(() => load(true), 5000);
    return () => clearInterval(t);
  }, [signingIn, viewerOpen, load]);

  if (phase !== 'ok' || !engine) {
    return (
      <div className="panel-card">
        <div className="panel-empty engine__empty" role="status">
          {phase === 'loading' ? 'Checking Hermes…' : (
            <>
              <span>Engine unavailable</span>
              <button type="button" className="link-btn link-btn--small" onClick={() => load()}>Try again</button>
            </>
          )}
        </div>
      </div>
    );
  }

  // The primary gateway also carries this app's messaging -- never restarted or model-switched here.
  if (engine.kind === 'primary') {
    const providerName = engine.providers.find((p) => p.id === engine.provider)?.name ?? engine.provider;
    return (
      <div className="panel-card engine">
        <div className="panel-row panel-row--setting"><span>Provider</span><span>{providerName || 'Not reported by Hermes'}</span></div>
        <div className="panel-row panel-row--setting"><span>Model</span><span>{engine.model || 'Not reported by Hermes'}</span></div>
        <div className="engine__notice"><Icon name="monitor" size={14} /><span>This gateway is managed in Hermes.</span></div>
        <div className="engine__meta">
          <span className={`engine__state is-${engine.status}`} title={engine.version ? `Hermes ${engine.version}` : undefined}>
            <i aria-hidden />Hermes · profile {engine.profile} · {STATUS[engine.status] ?? engine.status}
          </span>
        </div>
        {engine.status === 'error' && engine.error && <div className="engine__error" role="alert">{engine.error}</div>}
      </div>
    );
  }

  const providers = sortProviders(engine.providers ?? []);
  const selected = providers.find((p) => p.id === provider) ?? null;
  const suggestions = selected?.models ?? [];
  const wantProvider = provider && provider !== (engine.provider ?? '') ? provider : undefined;
  const wantModel = model.trim() && model.trim() !== (engine.model ?? '') ? model.trim() : undefined;
  const changed = !!wantProvider || !!wantModel;
  const openSubscriptions = providers.filter((p) => p.kind === 'subscription' && !p.connected);
  const signInTo = selected && selected.kind === 'subscription' && !selected.connected ? selected : null;
  const listId = `engine-models-${botId}`;

  const pickProvider = (id: string) => {
    dirty.current = true; setNote(null); setProvider(id);
    const next = providers.find((p) => p.id === id);
    // A model from another provider will not work here, so start from this provider's first suggestion.
    if (next?.models.length && !next.models.includes(model.trim())) setModel(next.models[0]);
  };

  const save = async () => {
    if (!changed || busy) return;
    setBusy('save'); setNote(null);
    try { const r = await configApi.setEngine(botId, { ...(wantProvider ? { provider: wantProvider } : {}), ...(wantModel ? { model: wantModel } : {}) }); dirty.current = false; apply(r.engine); }
    catch (e) { setNote(`Couldn't save: ${(e as Error).message || 'the engine did not answer'}`); }
    finally { setBusy(null); }
  };

  const signIn = async () => {
    if (busy) return;
    setBusy('signin'); setNote(null);
    try {
      await configApi.engineLogin(botId, signInTo?.id);
      // The sign-in runs in a terminal on the bot's screen, so take the person there with the mouse and keyboard.
      set({ viewerOpen: true, viewerMode: 'control', viewerHint: `Finish signing in on ${bot.name}'s computer, then hand back.` });
      setSigningIn(true);
    } catch (e) { setNote(`Couldn't start sign-in: ${(e as Error).message || 'the engine did not answer'}`); }
    finally { setBusy(null); }
  };

  const restart = async () => {
    if (busy) return;
    setBusy('restart'); setNote(null);
    try { const r = await configApi.restartEngine(botId); apply(r.engine, true); }
    catch (e) { setNote(`Couldn't restart: ${(e as Error).message || 'the engine did not answer'}`); }
    finally { setBusy(null); }
  };

  const useThisScreen = async () => {
    if (busy) return;
    setBusy('screen'); setNote(null);
    try { const r = await configApi.stopOwnScreen(botId); apply(r.engine, true); }
    catch (e) { setNote(`Couldn't switch screens: ${(e as Error).message || 'the engine did not answer'}`); }
    finally { setBusy(null); }
  };

  return (
    <div className="panel-card engine">
      <div className="panel-row panel-row--setting">
        <span>Provider</span>
        <span className="mini-select mini-select--native engine__select">
          <span>{selected?.name ?? (provider || 'Default')}</span>
          <Icon name="chev_down" size={10} opacity={0.66} />
          <select aria-label="Provider" value={provider} onChange={(e) => pickProvider(e.target.value)}>
            {!selected && <option value={provider}>{provider || 'Default'}</option>}
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name} · {KIND[p.kind]} · {p.connected ? 'Connected' : 'Not connected'}</option>)}
          </select>
        </span>
      </div>
      {selected && (
        <div className={`engine__conn${selected.connected ? ' is-on' : ''}`}>
          <i aria-hidden />
          <span>{selected.connected ? 'Connected' : 'Not connected'} · {KIND[selected.kind]}</span>
        </div>
      )}
      <div className="panel-row panel-row--setting">
        <label htmlFor={`${listId}-input`}>Model</label>
        <input
          id={`${listId}-input`} className="engine__model" list={listId} value={model} spellCheck={false} autoComplete="off"
          placeholder={suggestions[0] ?? 'Model id'}
          onChange={(e) => { dirty.current = true; setNote(null); setModel(e.target.value); }}
          onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
        />
        <datalist id={listId}>{suggestions.map((m) => <option key={m} value={m} />)}</datalist>
      </div>
      <div className="engine__actions">
        <button type="button" className="btn btn--sm btn--bot" onClick={save} disabled={!changed || busy === 'save'}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
        {changed && <button type="button" className="link-btn link-btn--small" onClick={() => { dirty.current = false; setNote(null); setProvider(engine.provider ?? ''); setModel(engine.model ?? ''); }}>Undo</button>}
      </div>
      {(signInTo || openSubscriptions.length > 0) && (
        <button type="button" className="panel-row panel-row--action engine__signin" onClick={signIn} disabled={busy === 'signin'}>
          <Icon name="monitor" size={14} opacity={0.56} />
          {busy === 'signin' ? 'Opening sign-in…' : signInTo ? `Sign in to ${signInTo.name}…` : 'Sign in to a subscription…'}
        </button>
      )}
      {engine.ownScreen && (
        <div className="engine__notice">
          <span>{bot.name} also has a private screen of its own switched on. Desktop work it does there (clicking around apps) will not show on the screen here.</span>
          <button type="button" className="link-btn link-btn--small" onClick={useThisScreen} disabled={busy === 'screen'}>{busy === 'screen' ? 'Switching…' : 'Use this screen'}</button>
        </div>
      )}
      {note && <div className="voice-error" role="alert">{note}</div>}
      <div className="engine__meta">
        <span className={`engine__state is-${engine.status}`} title={engine.version ? `Hermes ${engine.version}` : undefined}>
          <i aria-hidden />
          Hermes · profile {engine.profile} · {STATUS[engine.status] ?? engine.status}
        </span>
        {(engine.status === 'error' || engine.status === 'stopped') && (
          <button type="button" className="link-btn link-btn--small" onClick={restart} disabled={busy === 'restart'}>{busy === 'restart' ? 'Restarting…' : 'Restart agent'}</button>
        )}
      </div>
      {engine.status === 'error' && engine.error && <div className="engine__error">{engine.error}</div>}
    </div>
  );
}

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Bot, Routine } from '@shared/types';
import { useConfigUI } from '../../configStore';
import { api } from '../../lib/api';
import { useStore } from '../../store';
import { nextRunLabel } from '../config/ui';

// Keep each mutation locked even if the user switches tabs, agents or surfaces.
const pending = new Set<string>();
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function setPending(id: string, value: boolean) {
  if (value) pending.add(id);
  else pending.delete(id);
  listeners.forEach((listener) => listener());
}

function AutomationItem({ routine, editable }: { routine: Routine; editable: boolean }) {
  const busy = useSyncExternalStore(subscribe, () => pending.has(routine.id), () => false);
  const [error, setError] = useState(false);
  const action = routine.enabled ? 'Pause' : 'Resume';
  const isTrigger = routine.schedule.startsWith('event:');
  const schedule = [routine.description || routine.schedule, !isTrigger && routine.timezone].filter(Boolean).join(' · ');
  const next = routine.enabled && !isTrigger ? nextRunLabel(routine.nextRunAt, routine.timezone) : '';

  async function toggle() {
    if (!editable || pending.has(routine.id)) return;
    setPending(routine.id, true);
    setError(false);
    try {
      const { routine: saved } = await api.setRoutine(routine.id, !routine.enabled);
      if (saved.id !== routine.id || saved.botId !== routine.botId) throw new Error('Unexpected routine response');
      useStore.setState((state) => {
        const list = state.routines[routine.botId];
        if (!list?.some((item) => item.id === saved.id)) return state;
        return { routines: { ...state.routines, [routine.botId]: list.map((item) => item.id === saved.id ? saved : item) } };
      });
    } catch {
      setError(true);
    } finally {
      setPending(routine.id, false);
    }
  }

  return (
    <li className="studio-list__item">
      <div>
        <strong>{routine.name}</strong>
        <p>{schedule}</p>
        <p>{[routine.enabled ? 'Enabled' : 'Paused', next].filter(Boolean).join(' · ')}</p>
        {error && <p role="alert">Could not confirm the change. Reopen Automations to refresh its status.</p>}
      </div>
      <button type="button" className="cfg-btn" aria-label={`${action} ${routine.name}`} disabled={!editable || busy} onClick={() => void toggle()}>
        {busy ? 'Updating…' : action}
      </button>
    </li>
  );
}

function AutomationList({ botId }: { botId: string }) {
  const routines = useStore((state) => state.routines[botId]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    useStore.getState().loadRoutines(botId).then(
      () => { if (active) setState('ready'); },
      () => { if (active) setState('error'); },
    );
    return () => { active = false; };
  }, [botId, attempt]);

  const scoped = routines?.filter((routine) => routine.botId === botId) ?? [];
  return (
    <>
      {state === 'loading' && <p role="status">Loading automations…</p>}
      {state === 'error' && <div>
        <p role="alert">Could not load automations.</p>
        <button type="button" className="cfg-btn" onClick={() => { setState('loading'); setAttempt((value) => value + 1); }}>Retry</button>
      </div>}
      {state === 'ready' && scoped.length === 0 && <p>No automations yet. To create one, ask this agent in chat.</p>}
      {scoped.length > 0 && <ul className="studio-list">
        {scoped.map((routine) => <AutomationItem key={routine.id} routine={routine} editable={state === 'ready'} />)}
      </ul>}
    </>
  );
}

export function AgentAutomations({ bot }: { bot: Bot }) {
  return (
    <section className="studio-facet" aria-label="Automations">
      <header className="studio-facet__head">
        <p>Workspace / Automations</p>
        <h1>Automations</h1>
        <span>Schedules and triggers for {bot.name}.</span>
      </header>
      <button type="button" className="cfg-btn" onClick={() => useConfigUI.getState().openBotSettings(bot.id, 'routines')}>
        Manage in settings
      </button>
      <AutomationList key={bot.id} botId={bot.id} />
    </section>
  );
}

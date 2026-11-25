/**
 * Agent desk. Rules applied, not imported:
 * Brand director: one job, this agent. No second navigation app.
 * Frontend engineer: loading, empty, and error are states. Every control does work.
 * Reality checker: numbers come from the live API, not a placeholder.
 * Motion director: no animation that hides a loading state.
 * Anti-slop: no equal-weight chip bar, no generic card grid, no fake success.
 */
import { useEffect, useState } from 'react';
import type { Bot } from '@shared/types';
import { useStore } from '../store';
import { useConfigUI } from '../configStore';

type Template = { slug: string; title: string; family: string };
type Note = { id: string; text: string };

export function AgentDesk({ bot }: { bot: Bot }) {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [autonomy, setAutonomy] = useState('ask');
  const [notes, setNotes] = useState<Note[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [pending, setPending] = useState<number | null>(null);
  const [pack, setPack] = useState('Engineering pack not loaded');
  const [themeCss, setThemeCss] = useState('');
  const [themeTokens, setThemeTokens] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    setPhase('loading');
    setError(null);
    try {
      const [auto, memory, catalog, live] = await Promise.all([
        fetch(`/api/v6/bots/${bot.id}/autonomy`, { credentials: 'include' }).then((r) => r.json()),
        fetch(`/api/bots/${bot.id}/memories`, { credentials: 'include' }).then((r) => r.json()),
        fetch('/api/v6/sid/templates', { credentials: 'include' }).then((r) => r.json()),
        fetch('/api/v6/live', { credentials: 'include' }).then((r) => r.json()),
      ]);
      setAutonomy(auto.mode || 'ask');
      setNotes(memory.memories ?? []);
      setTemplates(catalog.templates ?? []);
      setPending(Array.isArray(live.pending) ? live.pending.length : 0);
      const packRes = await fetch('/api/v6/engineering-pack', { credentials: 'include' }).then((r) => r.json());
      setPack(`${packRes.count} sources pinned, ${packRes.installed} installed. A finished prompt is not a release.`);
      const theme = await fetch(`/api/v6/bots/${bot.id}/theme`, { credentials: 'include' }).then((r) => r.json());
      setThemeCss(theme.css ?? '');
      setThemeTokens(theme.tokens ?? {});
      setPhase('ready');
    } catch {
      setPhase('error');
      setError('The desk could not load. The conversation is still usable.');
    }
  }

  useEffect(() => { load().catch(() => {}); }, [bot.id]);

  async function setMode(mode: 'ask' | 'draft' | 'act') {
    setBusy(mode);
    setError(null);
    const res = await fetch(`/api/v6/bots/${bot.id}/autonomy`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) { setError(body.error || 'Autonomy was not saved.'); return; }
    setAutonomy(body.mode || mode);
  }

  async function saveNote(form: HTMLFormElement) {
    const input = form.elements.namedItem('note') as HTMLInputElement;
    const text = input.value.trim();
    if (!text) return;
    setBusy('note');
    const res = await fetch(`/api/bots/${bot.id}/memories`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok || !body.memory) { setError(body.error || 'The note was not saved.'); return; }
    setNotes((rows) => [...rows, body.memory]);
    input.value = '';
  }

  async function mint(slug: string, asChild: boolean) {
    setBusy(slug);
    setError(null);
    const res = await fetch('/api/v6/sid/materialize', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template: slug, parentBotId: asChild ? bot.id : undefined }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) { setError(body.error || 'The agent was not minted.'); return; }
    setError(null);
    await useStore.getState().loadBots().catch(() => {});
    setError(`Minted ${body.sid}. It is in the roster. It has no grants.`);
  }

  async function saveTheme(css: string) {
    setBusy('theme');
    setError(null);
    const res = await fetch(`/api/v6/bots/${bot.id}/theme`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ css }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) { setError('The theme was not saved.'); return; }
    setThemeCss(css);
    setThemeTokens(body.tokens ?? {});
  }

  if (phase === 'loading') return <p className="desk__state">Loading {bot.name}'s desk…</p>;
  if (phase === 'error') return <p className="desk__state" role="alert">{error} <button type="button" className="link-btn" onClick={() => load()}>Retry</button></p>;

  return (
    <div className={`desk sid-theme-${bot.id}`} style={themeTokens as React.CSSProperties}>
      {error && <p className="desk__state" role="status">{error}</p>}
      <section className="desk__block">
        <h3>Model</h3>
        {bot.model ? <p>{bot.model}</p> : (
          <>
            <p>No model is set. A turn will not run.</p>
            <button type="button" className="btn btn--sm" onClick={() => useConfigUI.getState().openBotSettings(bot.id)}>Set a model</button>
          </>
        )}
      </section>
      <section className="desk__block">
        <h3>Autonomy</h3>
        <p>{pending === 0 ? 'No turn is in flight.' : `${pending} turn${pending === 1 ? '' : 's'} in flight.`} {pack}</p>
        <div className="desk__row">
          {(['ask', 'draft', 'act'] as const).map((mode) => (
            <button key={mode} type="button" className={autonomy === mode ? 'btn btn--sm' : 'btn btn--sm btn--secondary'} disabled={busy === mode} onClick={() => setMode(mode)}>{mode}</button>
          ))}
        </div>
      </section>
      <section className="desk__block">
        <h3>Notes</h3>
        {notes.length === 0 ? <p className="desk__state">No notes yet. A note is not a grant.</p> : (
          <ul className="desk__list">{notes.slice(-4).map((row) => <li key={row.id}>{row.text}</li>)}</ul>
        )}
        <form className="desk__row" onSubmit={(event) => { event.preventDefault(); saveNote(event.currentTarget); }}>
          <input name="note" className="text-input" aria-label="Note" placeholder="What this agent should remember" />
          <button type="submit" className="btn btn--sm" disabled={busy === 'note'}>Save</button>
        </form>
      </section>
      <section className="desk__block">
        <h3>Templates</h3>
        {templates.length === 0 ? <p className="desk__state">No templates returned.</p> : (
          <ul className="desk__list">
            {templates.map((row) => (
              <li key={row.slug}>
                <span><strong>{row.title}</strong><small>{row.family}</small></span>
                <span className="desk__row">
                  <button type="button" className="btn btn--sm" disabled={busy === row.slug} onClick={() => mint(row.slug, false)}>Install</button>
                  <button type="button" className="btn btn--sm btn--secondary" disabled={busy === row.slug} onClick={() => mint(row.slug, true)}>Spawn</button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="desk__block">
        <h3>Appearance</h3>
        <p className="desk__state">A per-agent accent, not a theme for the whole app. Set custom properties only — <code>--color-primary</code>, <code>--radius-md</code>, and similar. Anything that could load something (url(), @import) is dropped before it is saved.</p>
        <form className="desk__row" onSubmit={(event) => { event.preventDefault(); const input = event.currentTarget.elements.namedItem('css') as HTMLTextAreaElement; saveTheme(input.value); }}>
          <textarea name="css" className="text-input desk__theme-input" defaultValue={themeCss} aria-label="Agent accent CSS" placeholder={`.sid-theme-${bot.id} { --color-primary: teal; }`} />
          <button type="submit" className="btn btn--sm" disabled={busy === 'theme'}>Save</button>
        </form>
        {Object.keys(themeTokens).length > 0 && <p className="desk__state">{Object.keys(themeTokens).length} token{Object.keys(themeTokens).length === 1 ? '' : 's'} applied to this desk.</p>}
      </section>
    </div>
  );
}
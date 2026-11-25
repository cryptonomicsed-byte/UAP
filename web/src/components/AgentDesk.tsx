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
type McpServer = { id: string; name: string; url: string; headerNames: string[]; enabled: boolean };

export function AgentDesk({ bot }: { bot: Bot }) {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [autonomy, setAutonomy] = useState('ask');
  const [notes, setNotes] = useState<Note[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [npub, setNpub] = useState<string | null>(null);
  const [calls, setCalls] = useState<{ id: string; from_pubkey: string | null; created_at: number }[]>([]);
  const [listening, setListening] = useState(false);
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
      const [auto, memory, catalog, live, connectors] = await Promise.all([
        fetch(`/api/v6/bots/${bot.id}/autonomy`, { credentials: 'include' }).then((r) => r.json()),
        fetch(`/api/bots/${bot.id}/memories`, { credentials: 'include' }).then((r) => r.json()),
        fetch('/api/v6/sid/templates', { credentials: 'include' }).then((r) => r.json()),
        fetch('/api/v6/live', { credentials: 'include' }).then((r) => r.json()),
        fetch(`/api/v6/bots/${bot.id}/mcp-servers`, { credentials: 'include' }).then((r) => r.json()),
      ]);
      setAutonomy(auto.mode || 'ask');
      setNotes(memory.memories ?? []);
      setTemplates(catalog.templates ?? []);
      setPending(Array.isArray(live.pending) ? live.pending.length : 0);
      setMcpServers(connectors.servers ?? []);
      const packRes = await fetch('/api/v6/engineering-pack', { credentials: 'include' }).then((r) => r.json());
      setPack(`${packRes.count} sources pinned, ${packRes.installed} installed. A finished prompt is not a release.`);
      const theme = await fetch(`/api/v6/bots/${bot.id}/theme`, { credentials: 'include' }).then((r) => r.json());
      setThemeCss(theme.css ?? '');
      setThemeTokens(theme.tokens ?? {});
      fetch(`/api/v6/bots/${bot.id}/nostr-identity`, { credentials: 'include' }).then((r) => r.json()).then((d) => setNpub(d.npub ?? null)).catch(() => {});
      fetch(`/api/v6/bots/${bot.id}/calls`, { credentials: 'include' }).then((r) => r.json()).then((d) => { setCalls(d.calls ?? []); setListening(!!d.listening); }).catch(() => {});
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
    const packNote = body.packsInstalled?.length ? ` · ${body.packsInstalled.length} pack skill(s) installed` : '';
    setError(`Minted ${body.sid}. It is in the roster. It has no grants.${packNote}`);
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

  async function addConnector(form: HTMLFormElement) {
    const name = (form.elements.namedItem('mcp_name') as HTMLInputElement).value.trim();
    const url = (form.elements.namedItem('mcp_url') as HTMLInputElement).value.trim();
    const headerName = (form.elements.namedItem('mcp_header_name') as HTMLInputElement).value.trim();
    const headerValue = (form.elements.namedItem('mcp_header_value') as HTMLInputElement).value;
    if (!name || !url) return;
    setBusy('mcp-add');
    setError(null);
    const res = await fetch(`/api/v6/bots/${bot.id}/mcp-servers`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, url, headers: headerName ? { [headerName]: headerValue } : undefined }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) { setError(body.error || 'The MCP server was not added.'); return; }
    setMcpServers((rows) => [...rows, body.server]);
    form.reset();
  }

  async function toggleConnector(id: string, enabled: boolean) {
    setBusy(`mcp-${id}`);
    const res = await fetch(`/api/v6/bots/${bot.id}/mcp-servers/${id}`, {
      method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(null);
    if (res.ok) setMcpServers(body.servers ?? []);
  }

  async function removeConnector(id: string) {
    setBusy(`mcp-${id}`);
    const res = await fetch(`/api/v6/bots/${bot.id}/mcp-servers/${id}`, { method: 'DELETE', credentials: 'include' });
    const body = await res.json().catch(() => ({}));
    setBusy(null);
    if (res.ok) setMcpServers(body.servers ?? []);
  }

  if (phase === 'loading') return <p className="desk__state">Loading {bot.name}'s desk…</p>;
  if (phase === 'error') return <p className="desk__state" role="alert">{error} <button type="button" className="link-btn" onClick={() => load()}>Retry</button></p>;

  async function toggleListening() {
    setBusy('listen');
    try {
      const r = await fetch(`/api/v6/bots/${bot.id}/nostr-listen${listening ? '/stop' : ''}`, { method: 'POST', credentials: 'include' }).then((r2) => r2.json());
      setListening(!!r.listening);
    } finally {
      setBusy(null);
    }
  }

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
        <p className="desk__state">Nostr identity (the real, callable address — a numberless agent-phone rooted on the live relay, not a phone number): {npub ? <code>{npub}</code> : 'minting…'}</p>
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
        <h3>Calls</h3>
        <p className="desk__state">
          This agent's real, numberless address on the Nostr relay: {npub ? <code>{npub}</code> : 'minting…'}.
          Another agent that has this npub can call it.
        </p>
        <button type="button" className="btn btn--sm" disabled={busy === 'listen'} onClick={() => void toggleListening()}>
          {listening ? 'Stop listening for calls' : 'Start listening for calls'}
        </button>
        {calls.length === 0 ? <p className="desk__state">No incoming calls waiting.</p> : (
          <ul className="desk__list">
            {calls.map((call) => (
              <li key={call.id}>
                <span>Ringing from <code>{call.from_pubkey?.slice(0, 16) ?? 'unknown'}…</code></span>
                <small>{new Date(call.created_at).toLocaleTimeString()}</small>
              </li>
            ))}
          </ul>
        )}
        <p className="desk__state">Signaling only for now — real-time audio over this call isn't wired up yet.</p>
      </section>
      <section className="desk__block">
        <h3>Connectors</h3>
        <p className="desk__state">Real MCP servers for this agent — not just Composio's catalog. A name becomes its tool prefix (<code>mcp_&lt;name&gt;_*</code>). Header values are never shown again once saved.</p>
        {mcpServers.length === 0 ? <p className="desk__state">No custom MCP servers yet.</p> : (
          <ul className="desk__list">
            {mcpServers.map((s) => (
              <li key={s.id}>
                <span><strong>{s.name}</strong><small>{s.url}{s.headerNames.length > 0 ? ` · ${s.headerNames.join(', ')} set` : ''}</small></span>
                <span className="desk__row">
                  <button type="button" className="btn btn--sm btn--secondary" disabled={busy === `mcp-${s.id}`} onClick={() => toggleConnector(s.id, !s.enabled)}>{s.enabled ? 'On' : 'Off'}</button>
                  <button type="button" className="btn btn--sm btn--secondary" disabled={busy === `mcp-${s.id}`} onClick={() => removeConnector(s.id)}>Remove</button>
                </span>
              </li>
            ))}
          </ul>
        )}
        <form className="desk__row" onSubmit={(event) => { event.preventDefault(); addConnector(event.currentTarget); }}>
          <input name="mcp_name" className="text-input" aria-label="Server name" placeholder="spacemail" />
          <input name="mcp_url" className="text-input" aria-label="Server URL" placeholder="https://mcp.example.com/mcp" />
          <input name="mcp_header_name" className="text-input" aria-label="Header name (optional)" placeholder="Authorization" />
          <input name="mcp_header_value" className="text-input" aria-label="Header value (optional)" type="password" placeholder="Bearer sk-..." />
          <button type="submit" className="btn btn--sm" disabled={busy === 'mcp-add'}>Add</button>
        </form>
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
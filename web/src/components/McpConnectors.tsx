import { useEffect, useState } from 'react';
import type { McpCatalogEntry } from '@shared/types';
import { configApi } from '../lib/configApi';

type Server = { id: string; name: string; url: string; headerNames: string[]; enabled: boolean };
type Settings = { servers: Server[]; managed: boolean };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'include', ...init, signal: init?.signal ?? AbortSignal.timeout(15_000) });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Connector request failed.');
  }
  return response.json();
}

const json = (method: string, body: unknown) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export function McpConnectors({ botId }: { botId: string }) {
  const base = `/api/v6/bots/${encodeURIComponent(botId)}/mcp-servers`;
  const [settings, setSettings] = useState<Settings | null>(null);
  const [entries, setEntries] = useState<McpCatalogEntry[] | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [needsRestart, setNeedsRestart] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
    setError('');
    Promise.all([request<Settings>(base, { signal }), request<{ entries: McpCatalogEntry[] }>(`${base}/catalog`, { signal })])
      .then(([saved, catalog]) => { if (!controller.signal.aborted) { setSettings(saved); setEntries(catalog.entries); } })
      .catch(() => { if (!controller.signal.aborted) setError('Could not load MCP connectors.'); });
    return () => controller.abort();
  }, [base, attempt]);

  async function change(action: () => Promise<void>, note = 'Saved. Restart this agent to apply connector changes.') {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try { await action(); setNotice(note); }
    catch (err) { setError(err instanceof Error ? err.message : 'Connector request failed.'); }
    finally { setBusy(false); }
  }

  function replace(servers: Server[]) {
    setSettings((current) => current && { ...current, servers });
    setNeedsRestart(true);
  }

  async function add(form: HTMLFormElement, destination: string, body: unknown) {
    await change(async () => {
      const { server } = await request<{ server: Server }>(destination, json('POST', body));
      setSettings((current) => current && { ...current, servers: [...current.servers, server] });
      setNeedsRestart(true);
      form.reset();
    });
  }

  const matches = entries?.filter((entry) => `${entry.displayName} ${entry.category} ${entry.description}`.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <section className="desk__block desk__mcp" aria-label="MCP connectors">
      <h3>Connectors</h3>
      {error && <p role="alert">{error}</p>}
      {!settings || !entries ? (
        error ? <button type="button" className="link-btn" onClick={() => setAttempt((n) => n + 1)}>Retry connectors</button> : <p role="status">Loading connectors…</p>
      ) : (
        <>
          {!settings.managed ? <p>This agent’s connectors are configured in Hermes. You can browse the catalog here.</p> : (
            <>
              <p>Saved connectors apply after this agent restarts. Remote tools can receive data the agent sends to them.</p>
              <div className="desk__row desk__mcp-heading">
                <h4>Saved for this agent</h4>
                <button type="button" className="btn btn--sm btn--secondary" disabled={busy} onClick={() => {
                  void change(async () => {
                    const { engine } = await configApi.restartEngine(botId);
                    if (engine.status === 'error' || engine.status === 'stopped') throw new Error('Agent did not start. Check its Hermes settings.');
                  }, 'Restart requested. This does not confirm that Hermes loaded the changes. Check Engine settings for readiness.');
                }}>{needsRestart ? 'Restart to apply' : 'Restart agent'}</button>
              </div>
              {settings.servers.length === 0 ? <p>No MCP servers saved.</p> : (
                <ul className="desk__list">
                  {settings.servers.map((server) => (
                    <li key={server.id}>
                      <span><strong>{server.name}</strong><small>{server.enabled ? 'Enabled in settings' : 'Disabled in settings'}{server.headerNames.length ? ' · credentials set' : ''}</small></span>
                      <span className="desk__row">
                        <button type="button" className="btn btn--sm btn--secondary" aria-label={`${server.enabled ? 'Disable' : 'Enable'} ${server.name}`} disabled={busy} onClick={() => void change(async () => {
                          const result = await request<Settings>(`${base}/${server.id}`, json('PATCH', { enabled: !server.enabled }));
                          replace(result.servers);
                        })}>{server.enabled ? 'Disable' : 'Enable'}</button>
                        <button type="button" className="btn btn--sm btn--secondary" aria-label={`Remove ${server.name}`} disabled={busy} onClick={() => void change(async () => {
                          const result = await request<Settings>(`${base}/${server.id}`, { method: 'DELETE' });
                          replace(result.servers);
                        })}>Remove</button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          {notice && <p role="status">{notice}</p>}
          <div className="desk__row desk__mcp-heading">
            <h4>MCP catalog</h4>
            <input className="text-input" type="search" aria-label="Search MCP catalog" placeholder="Search connectors" value={query} onChange={(event) => setQuery(event.target.value)} />
          </div>
          {matches?.length ? <ul className="desk__list desk__mcp-catalog">
            {matches.map((entry) => {
              const saved = settings.servers.find((server) => server.name === entry.id);
              return <li key={entry.id}>
                <span><strong>{entry.displayName}</strong><small>{entry.category} · {entry.auth === 'oauth' ? 'OAuth required' : entry.auth === 'optional_token' ? 'Token optional' : 'No key required'}</small><small>{entry.description}</small></span>
                {entry.auth === 'oauth' ? <small>Not available in UAP yet</small> : saved ? <small>{saved.enabled ? 'Already added' : 'Saved, disabled'}</small> : settings.managed && (
                  <form className="desk__row desk__mcp-preset" onSubmit={(event) => {
                    event.preventDefault();
                    const token = String(new FormData(event.currentTarget).get('token') ?? '').trim();
                    void add(event.currentTarget, `${base}/catalog`, { presetId: entry.id, ...(token ? { token } : {}) });
                  }}>
                    {entry.auth === 'optional_token' && <input className="text-input" type="password" maxLength={2048} autoComplete="off" name="token" aria-label={`${entry.displayName} token (optional)`} placeholder="Optional token" />}
                    <button type="submit" className="btn btn--sm" disabled={busy} aria-label={`Add ${entry.displayName}`}>Add</button>
                  </form>
                )}
              </li>;
            })}
          </ul> : <p>No connectors match your search.</p>}
          {settings.managed && <details>
            <summary>Add a custom remote server</summary>
            <p>Use an MCP endpoint you trust. Enter credentials as headers, not in the URL.</p>
            <form className="desk__row desk__mcp-custom" onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              const header = String(form.get('header') ?? '').trim();
              void add(event.currentTarget, base, { name: form.get('name'), url: form.get('url'), ...(header ? { headers: { [header]: form.get('value') } } : {}) });
            }}>
              <input name="name" className="text-input" aria-label="Server name" placeholder="Name" required />
              <input name="url" className="text-input" aria-label="Server URL" placeholder="https://…/mcp" required />
              <input name="header" className="text-input" aria-label="Header name (optional)" placeholder="Header name" />
              <input name="value" className="text-input" aria-label="Header value (optional)" type="password" autoComplete="off" placeholder="Header value" />
              <button type="submit" className="btn btn--sm" disabled={busy}>Add custom server</button>
            </form>
          </details>}
        </>
      )}
    </section>
  );
}

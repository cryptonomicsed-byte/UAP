/**
 * Product rail. Patterns adapted, not imported:
 * Nod: chat, schedule, apps, vault
 * Rakazo: templates, computers, spaces
 * Codync: agent roster and bring-your-own model
 * OpenMausBot: team/workforce surface
 * dusk bot: capability list only. Its license forbids copying source.
 */
import { useEffect, useState } from 'react';
import { ComputerScreen } from './ComputerViewer';
import { EngineSettings } from './EngineSettings';
import { useSelectedBot, useStore } from '../store';

export type WorkspaceSurface =
  | 'chat'
  | 'roster'
  | 'templates'
  | 'computer'
  | 'apps'
  | 'schedule'
  | 'vault'
  | 'models'
  | 'workforce'
  | 'memory'
  | 'skills'
  | 'polyglot';

const ITEMS: { id: WorkspaceSurface; label: string; hint: string }[] = [
  { id: 'chat', label: 'Chat', hint: 'Talk to the selected agent' },
  { id: 'roster', label: 'Agents', hint: 'Teammates and rooms' },
  { id: 'templates', label: 'Templates', hint: 'SID birth recipes' },
  { id: 'computer', label: 'Computer', hint: 'Local desk for the selected agent' },
  { id: 'apps', label: 'Apps', hint: 'Connectors' },
  { id: 'schedule', label: 'Schedule', hint: 'Routines for this agent' },
  { id: 'vault', label: 'Vault', hint: 'What is configured, not the secrets' },
  { id: 'models', label: 'Models', hint: 'Bring your own model' },
  { id: 'workforce', label: 'Workforce', hint: 'Install or spawn a SID' },
  { id: 'memory', label: 'Memory', hint: 'Notes you can read' },
  { id: 'skills', label: 'Skills', hint: 'Instructions, not grants' },
  { id: 'polyglot', label: 'Stack', hint: 'Which language owns which job' },
];

export function WorkspaceRail({
  surface,
  onChange,
}: {
  surface: WorkspaceSurface;
  onChange: (id: WorkspaceSurface) => void;
}) {
  return (
    <nav className="ws-rail" aria-label="Workspace">
      <div className="ws-rail__mark" title="UAP">U</div>
      {ITEMS.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`ws-rail__item${surface === item.id ? ' is-on' : ''}`}
          aria-current={surface === item.id ? 'page' : undefined}
          title={item.hint}
          onClick={() => onChange(item.id)}
        >
          <span className="ws-rail__glyph">{item.label.slice(0, 1)}</span>
          <span className="ws-rail__label">{item.label}</span>
        </button>
      ))}
    </nav>
  );
}

type Template = { slug: string; title: string; family: string; source?: { take?: string } };

export function WorkspaceStage({ surface }: { surface: WorkspaceSurface }) {
  const bot = useSelectedBot();
  const setModal = useStore((s) => s.setModal);
  const set = useStore((s) => s.set);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [apps, setApps] = useState<{ name: string; connected?: boolean; local?: boolean }[]>([]);
  const [routines, setRoutines] = useState<{ id: string; name?: string; cron?: string }[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [vault, setVault] = useState<string>('Checking providers…');
  const [memories, setMemories] = useState<{ id: string; text: string }[]>([]);
  const [skills, setSkills] = useState<{ id: string; name?: string; title?: string }[]>([]);
  const [pillars, setPillars] = useState<{ niche: string; language: string; owns: string; present: boolean }[]>([]);
  const [autonomy, setAutonomyMode] = useState('ask');

  useEffect(() => {
    if (surface !== 'templates' && surface !== 'workforce') return;
    fetch('/api/v6/sid/templates', { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => setTemplates(j.templates ?? []))
      .catch(() => setNote('Templates unavailable'));
  }, [surface]);

  useEffect(() => {
    if (surface !== 'apps') return;
    fetch('/api/apps', { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => setApps(j.apps ?? j.connectors ?? []))
      .catch(() => setNote('Apps unavailable'));
  }, [surface]);

  useEffect(() => {
    if (surface !== 'schedule' || !bot) return;
    fetch(`/api/bots/${bot.id}/routines`, { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => setRoutines(j.routines ?? []))
      .catch(() => setRoutines([]));
  }, [surface, bot?.id]);

  useEffect(() => {
    if (surface !== 'memory' || !bot) return;
    fetch(`/api/bots/${bot.id}/memories`, { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => setMemories(j.memories ?? []))
      .catch(() => setMemories([]));
  }, [surface, bot?.id]);

  useEffect(() => {
    if (surface !== 'skills' || !bot) return;
    fetch(`/api/bots/${bot.id}/skills`, { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => setSkills(j.skills ?? []))
      .catch(() => setSkills([]));
  }, [surface, bot?.id]);

  useEffect(() => {
    if (surface !== 'polyglot') return;
    fetch('/api/v6/polyglot', { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => setPillars(j.pillars ?? []))
      .catch(() => setPillars([]));
  }, [surface]);

  useEffect(() => {
    if (!bot || (surface !== 'workforce' && surface !== 'models')) return;
    fetch(`/api/v6/bots/${bot.id}/autonomy`, { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => setAutonomyMode(j.mode || 'ask'))
      .catch(() => setAutonomyMode('ask'));
  }, [surface, bot?.id]);

  useEffect(() => {
    if (surface !== 'vault') return;
    fetch('/api/v6/operate-surface', { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => {
        const providers = j.providers ?? {};
        const lines = Object.entries(providers).map(([name, row]) => `${name}: ${(row as { status?: string }).status ?? 'unknown'}`);
        setVault(lines.join(' · ') || 'No provider status');
      })
      .catch(() => setVault('Vault status unavailable'));
  }, [surface]);

  async function mint(slug: string, asChild: boolean) {
    setNote(null);
    const res = await fetch('/api/v6/sid/materialize', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template: slug, parentBotId: asChild ? bot?.id : undefined }),
    });
    const body = await res.json().catch(() => ({}));
    setNote(res.ok ? `Minted ${body.sid}` : (body.error || `failed ${res.status}`));
    if (res.ok) useStore.getState().loadBots().catch(() => {});
  }

  if (surface === 'roster') {
    return (
      <section className="ws-stage">
        <header className="ws-stage__head">
          <h1>Agents</h1>
          <p>Each teammate is its own bot. A spawn is a new SID, not a copy of the parent.</p>
        </header>
        <div className="ws-stage__body">
          {bot ? <p className="ws-lead">{bot.name} is selected. Open Chat to talk, or Workforce to spawn under it.</p> : <p className="ws-lead">Select an agent in the roster.</p>}
        </div>
      </section>
    );
  }

  if (surface === 'computer') {
    return (
      <section className="ws-stage">
        <header className="ws-stage__head">
          <h1>Computer</h1>
          <p>Local desk. Control requires an explicit lease. The screen relay is still unreliable if VNC wedges.</p>
          <button type="button" className="ws-btn" onClick={() => set({ viewerOpen: true, viewerMode: 'watch', viewerHint: null })}>Open large view</button>
        </header>
        <div className="ws-stage__body ws-stage__computer">
          {bot ? <ComputerScreen bot={bot} variant="stage" /> : <p className="ws-lead">Select an agent first.</p>}
        </div>
      </section>
    );
  }

  if (surface === 'apps') {
    return (
      <section className="ws-stage">
        <header className="ws-stage__head">
          <h1>Apps</h1>
          <p>Local connectors first. A paid catalog is optional and is not a silent fallback.</p>
          <button type="button" className="ws-btn" onClick={() => setModal('apps')}>Browse</button>
        </header>
        <ul className="ws-list">
          {apps.length === 0 && <li className="ws-empty">No connector list yet.</li>}
          {apps.map((app) => (
            <li key={app.name}><strong>{app.name}</strong><span>{app.connected ? 'connected' : app.local ? 'local' : 'available'}</span></li>
          ))}
        </ul>
      </section>
    );
  }

  if (surface === 'schedule') {
    return (
      <section className="ws-stage">
        <header className="ws-stage__head">
          <h1>Schedule</h1>
          <p>{bot ? `Routines for ${bot.name}.` : 'Select an agent to see its routines.'}</p>
        </header>
        <ul className="ws-list">
          {routines.length === 0 && <li className="ws-empty">No routines.</li>}
          {routines.map((row) => <li key={row.id}><strong>{row.name || row.id}</strong><span>{row.cron || 'scheduled'}</span></li>)}
        </ul>
      </section>
    );
  }

  if (surface === 'vault') {
    return (
      <section className="ws-stage">
        <header className="ws-stage__head">
          <h1>Vault</h1>
          <p>Secrets stay on the server. This page only shows whether a provider is configured.</p>
        </header>
        <p className="ws-lead">{vault}</p>
      </section>
    );
  }

  if (surface === 'models') {
    return (
      <section className="ws-stage">
        <header className="ws-stage__head">
          <h1>Models</h1>
          <p>Bring your own model. A template does not include a provider key.</p>
        </header>
        <div className="ws-stage__body">{bot ? <EngineSettings bot={bot} /> : <p className="ws-lead">Select an agent first.</p>}</div>
      </section>
    );
  }

  if (surface === 'memory') {
    return (
      <section className="ws-stage">
        <header className="ws-stage__head">
          <h1>Memory</h1>
          <p>{bot ? `Notes ${bot.name} keeps. You can read them here. They are not grants.` : 'Select an agent.'}</p>
        </header>
        <ul className="ws-list">
          {memories.length === 0 && <li className="ws-empty">No notes yet.</li>}
          {memories.map((row) => <li key={row.id}>{row.text}</li>)}
        </ul>
      </section>
    );
  }

  if (surface === 'skills') {
    return (
      <section className="ws-stage">
        <header className="ws-stage__head">
          <h1>Skills</h1>
          <p>A skill is an instruction. It does not authorize a tool.</p>
        </header>
        <ul className="ws-list">
          {skills.length === 0 && <li className="ws-empty">No skills on this agent.</li>}
          {skills.map((row) => <li key={row.id}><strong>{row.name || row.title || row.id}</strong></li>)}
        </ul>
      </section>
    );
  }

  if (surface === 'polyglot') {
    return (
      <section className="ws-stage">
        <header className="ws-stage__head">
          <h1>Stack</h1>
          <p>One language owns each job. A missing binary is shown as absent. dusk bot source is not copied: its license is noncommercial.</p>
        </header>
        <ul className="ws-list">
          {pillars.map((row) => (
            <li key={row.niche}><strong>{row.language}</strong><span>{row.niche} · {row.present ? 'present' : 'absent'} · {row.owns}</span></li>
          ))}
        </ul>
      </section>
    );
  }

  const gallery = (
    <div className="ws-grid">
      {templates.map((row) => (
        <article key={row.slug} className="ws-card">
          <p className="ws-card__family">{row.family}</p>
          <h2>{row.title}</h2>
          <p>{row.source?.take || 'SID template. No grants.'}</p>
          <div className="ws-card__actions">
            <button type="button" className="ws-btn" onClick={() => mint(row.slug, false)}>Install</button>
            <button type="button" className="ws-btn ws-btn--ghost" onClick={() => mint(row.slug, true)} disabled={!bot}>Spawn</button>
          </div>
        </article>
      ))}
    </div>
  );

  return (
    <section className="ws-stage">
      <header className="ws-stage__head">
        <h1>{surface === 'workforce' ? 'Workforce' : 'Templates'}</h1>
        <p>Install makes a full agent. Spawn makes a child under {bot?.name || 'the selected agent'}. Autonomy is {autonomy}: risky tools ask unless you set act.</p>
      </header>
      {note && <p className="ws-note" role="status">{note}</p>}
      {gallery}
    </section>
  );
}

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
  | 'polyglot'
  | 'board'
  | 'market'
  | 'live'
  | 'design'
  | 'domain'
  | 'operator';

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
  { id: 'board', label: 'Board', hint: 'Tasks and SID identity' },
  { id: 'market', label: 'Market', hint: 'Templates you can install, and trial roles you cannot' },
  { id: 'live', label: 'Live', hint: 'Turns and approvals, not message text' },
  { id: 'design', label: 'Design', hint: 'Design gate findings, including failures' },
  { id: 'domain', label: 'Domain', hint: 'Chain, research, media, NPC, languages' },
  { id: 'operator', label: 'Ops', hint: 'Providers and tool availability' },
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
  const [board, setBoard] = useState<{ tasks: { task_id: string; status: string; intent: string }[]; identities: { sid: string; template_slug: string; kind: string; status: string; parent_sid: string | null }[]; screens: { bot_id: string; screen_id: string }[] }>({ tasks: [], identities: [], screens: [] });
  const [roles, setRoles] = useState<{ id: string; title: string; family: string; state: string; riskClass: string }[]>([]);
  const [family, setFamily] = useState('all');
  const [live, setLive] = useState<{ pending: { bot_id: string; state: string }[]; approvals: { id: string; tool: string; status: string }[]; recent: { bot_id: string; kind: string }[]; note?: string }>({ pending: [], approvals: [], recent: [] });
  const [design, setDesign] = useState<{ ok?: boolean; nogo?: boolean; findings: { code: string; severity: string; message: string }[] }>({ findings: [] });
  const [domain, setDomain] = useState<{ chain: { family: string; signer: boolean }[]; research: { id: string; title: string; riskClass: string }[]; media: { id: string; title: string }[]; languages: { id: string; title: string }[]; npc: Record<string, boolean> }>({ chain: [], research: [], media: [], languages: [], npc: {} });
  const [ops, setOps] = useState<{ providers: Record<string, { status: string }>; computer?: { localBox?: boolean }; tools: number }>({ providers: {}, tools: 0 });
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
    if (surface !== 'board') return;
    fetch('/api/v6/board', { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => setBoard({ tasks: j.tasks ?? [], identities: j.identities ?? [], screens: j.screens ?? [] }))
      .catch(() => setNote('Board unavailable'));
  }, [surface]);

  useEffect(() => {
    if (surface !== 'market') return;
    fetch('/api/v6/roles/roster', { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => setRoles(j.roles ?? []))
      .catch(() => setNote('Roster unavailable'));
  }, [surface]);

  useEffect(() => {
    if (surface !== 'live') return;
    fetch('/api/v6/live', { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => setLive({ pending: j.pending ?? [], approvals: j.approvals ?? [], recent: j.recent ?? [], note: j.note }))
      .catch(() => setNote('Live view unavailable'));
  }, [surface]);

  useEffect(() => {
    if (surface !== 'design') return;
    fetch('/api/v6/design/gates', { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => setDesign({ ok: j.ok, nogo: j.nogo, findings: j.findings ?? [] }))
      .catch(() => setNote('Design gates unavailable'));
  }, [surface]);

  useEffect(() => {
    if (surface !== 'domain') return;
    fetch('/api/v6/domain', { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => setDomain({ chain: j.chain ?? [], research: j.research ?? [], media: j.media ?? [], languages: j.languages ?? [], npc: j.npc ?? {} }))
      .catch(() => setNote('Domain catalog unavailable'));
  }, [surface]);

  useEffect(() => {
    if (surface !== 'operator') return;
    fetch('/api/v6/operate-surface', { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => setOps({ providers: j.providers ?? {}, computer: j.computer, tools: j.mcp?.activeCount ?? 0 }))
      .catch(() => setNote('Operator surface unavailable'));
  }, [surface]);

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
        {bot && (
          <form className="ws-card__actions" onSubmit={(event) => {
            event.preventDefault();
            const input = (event.currentTarget.elements.namedItem('note') as HTMLInputElement);
            const text = input.value.trim();
            if (!text) return;
            fetch(`/api/bots/${bot.id}/memories`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
              .then((r) => r.json())
              .then((j) => { if (j.memory) { setMemories((rows) => [...rows, j.memory]); input.value = ''; } else setNote(j.error || 'Could not save'); })
              .catch(() => setNote('Could not save'));
          }}>
            <input name="note" className="text-input" placeholder="Add a note the agent and you can both read" aria-label="New note" />
            <button type="submit" className="ws-btn">Save</button>
          </form>
        )}
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

  if (surface === 'design') {
    return (
      <section className="ws-stage">
        <header className="ws-stage__head">
          <h1>Design</h1>
          <p>{design.nogo ? 'Release is no-go.' : design.ok ? 'Gates passed.' : 'Gate result pending.'} A missing persona is a finding, not a pass.</p>
        </header>
        <ul className="ws-list">
          {design.findings.length === 0 && <li className="ws-empty">No findings returned.</li>}
          {design.findings.map((row) => <li key={row.code + row.message}><strong>{row.severity}</strong><span>{row.message}</span></li>)}
        </ul>
      </section>
    );
  }

  if (surface === 'domain') {
    return (
      <section className="ws-stage">
        <header className="ws-stage__head">
          <h1>Domain</h1>
          <p>Chain templates have no signer. Research and media roles do not approve a claim by being listed. A decorative NPC does not get a SID.</p>
        </header>
        <h2>Chain</h2>
        <ul className="ws-list">{domain.chain.map((row) => <li key={row.family}><strong>{row.family}</strong><span>{row.signer ? 'signer' : 'no signer'}</span></li>)}</ul>
        <h2>Research</h2>
        <ul className="ws-list">{domain.research.map((row) => <li key={row.id}><strong>{row.title}</strong><span>{row.riskClass}</span></li>)}</ul>
        <h2>Media</h2>
        <ul className="ws-list">{domain.media.map((row) => <li key={row.id}><strong>{row.title}</strong></li>)}</ul>
        <h2>NPC SID</h2>
        <ul className="ws-list">{Object.entries(domain.npc).map(([kind, allowed]) => <li key={kind}><strong>{kind}</strong><span>{allowed ? 'may hold a SID' : 'no SID'}</span></li>)}</ul>
        <h2>Languages</h2>
        <ul className="ws-list">{domain.languages.map((row) => <li key={row.id}><strong>{row.title}</strong><span>{row.id}</span></li>)}</ul>
      </section>
    );
  }

  if (surface === 'operator') {
    return (
      <section className="ws-stage">
        <header className="ws-stage__head">
          <h1>Operator</h1>
          <p>Local desk is {ops.computer?.localBox ? 'on' : 'off'}. {ops.tools} tools are active. A configured provider is not a verified one.</p>
        </header>
        <ul className="ws-list">
          {Object.entries(ops.providers).map(([name, row]) => <li key={name}><strong>{name}</strong><span>{row.status}</span></li>)}
        </ul>
      </section>
    );
  }

  if (surface === 'market') {
    const families = ['all', ...new Set(roles.map((row) => row.family))];
    const shown = roles.filter((row) => family === 'all' || row.family === family);
    return (
      <section className="ws-stage">
        <header className="ws-stage__head">
          <h1>Market</h1>
          <p>Installable agents are on Templates. This roster is trial. A title here is not a grant and does not install.</p>
          <div className="ws-card__actions">
            {families.map((name) => (
              <button key={name} type="button" className={name === family ? 'ws-btn' : 'ws-btn ws-btn--ghost'} onClick={() => setFamily(name)}>{name}</button>
            ))}
          </div>
        </header>
        <ul className="ws-list">
          {shown.map((row) => <li key={`${row.id}-${row.family}`}><strong>{row.title}</strong><span>{row.family} · {row.state} · {row.riskClass}</span></li>)}
        </ul>
      </section>
    );
  }

  if (surface === 'live') {
    return (
      <section className="ws-stage">
        <header className="ws-stage__head">
          <h1>Live</h1>
          <p>{live.note || 'Turns and approvals. Message text stays in the chat.'}</p>
        </header>
        <h2>Pending</h2>
        <ul className="ws-list">
          {live.pending.length === 0 && <li className="ws-empty">No turn in flight.</li>}
          {live.pending.map((row) => <li key={row.bot_id}><strong>{row.state}</strong><span>{row.bot_id}</span></li>)}
        </ul>
        <h2>Approvals</h2>
        <ul className="ws-list">
          {live.approvals.length === 0 && <li className="ws-empty">No approvals.</li>}
          {live.approvals.map((row) => <li key={row.id}><strong>{row.tool}</strong><span>{row.status}</span></li>)}
        </ul>
        <h2>Recent kinds</h2>
        <ul className="ws-list">
          {live.recent.length === 0 && <li className="ws-empty">No rows yet.</li>}
          {live.recent.map((row, index) => <li key={`${row.bot_id}-${index}`}><strong>{row.kind}</strong><span>{row.bot_id}</span></li>)}
        </ul>
      </section>
    );
  }

  if (surface === 'board') {
    return (
      <section className="ws-stage">
        <header className="ws-stage__head">
          <h1>Board</h1>
          <p>Tasks and SID identity. An empty list means nothing is running. A worker is not an always-on life.</p>
        </header>
        <h2>Tasks</h2>
        <ul className="ws-list">
          {board.tasks.length === 0 && <li className="ws-empty">No tasks.</li>}
          {board.tasks.map((row) => <li key={row.task_id}><strong>{row.status}</strong><span>{row.intent}</span></li>)}
        </ul>
        <h2>Identities</h2>
        <ul className="ws-list">
          {board.identities.length === 0 && <li className="ws-empty">No SID minted yet.</li>}
          {board.identities.map((row) => <li key={row.sid}><strong>{row.template_slug}</strong><span>{row.kind} · {row.status} · {row.parent_sid || 'no parent'}</span></li>)}
        </ul>
        <h2>Screens</h2>
        <ul className="ws-list">
          {board.screens.length === 0 && <li className="ws-empty">No screen leased.</li>}
          {board.screens.map((row) => <li key={row.bot_id}><strong>{row.screen_id}</strong><span>{row.bot_id}</span></li>)}
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
        {bot && (
          <div className="ws-card__actions">
            {(['ask', 'draft', 'act'] as const).map((mode) => (
              <button key={mode} type="button" className={mode === autonomy ? 'ws-btn' : 'ws-btn ws-btn--ghost'} onClick={() => {
                fetch(`/api/v6/bots/${bot.id}/autonomy`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) })
                  .then((r) => r.json())
                  .then((j) => setAutonomyMode(j.mode || mode))
                  .catch(() => setNote('Could not set autonomy'));
              }}>{mode}</button>
            ))}
          </div>
        )}
      </header>
      {note && <p className="ws-note" role="status">{note}</p>}
      {gallery}
    </section>
  );
}

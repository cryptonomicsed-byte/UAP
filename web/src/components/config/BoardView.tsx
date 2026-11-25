import { useEffect, useMemo, useState } from 'react';
import { useConfigUI } from '../../configStore';
import { useStore } from '../../store';
import { Glyph } from './glyphs';
import { useSpotlight } from '../../lib/useSpotlight';
import './ui';

type Status = 'todo' | 'in_progress' | 'in_review' | 'blocked' | 'done' | 'wont_do';
interface Ticket {
  id: string; title: string; description: string; ownerBotId: string | null;
  status: Status; priority: 'low' | 'normal' | 'high'; comments: { at: number; author: string; text: string }[];
}
const COLUMNS: { id: Status; label: string }[] = [
  { id: 'todo', label: 'To do' }, { id: 'in_progress', label: 'In progress' }, { id: 'in_review', label: 'In review' },
  { id: 'blocked', label: 'Blocked' }, { id: 'done', label: 'Done' }, { id: 'wont_do', label: "Won't do" },
];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v6${path}`, { credentials: 'include', headers: init?.body ? { 'Content-Type': 'application/json' } : undefined, ...init });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || 'request failed');
  return body;
}

function useTickets() {
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rev, setRev] = useState(0);
  useEffect(() => {
    let alive = true;
    api<{ tickets: Ticket[] }>('/tickets').then((r) => { if (alive) setTickets(r.tickets); }).catch((e) => { if (alive) { setTickets([]); setError(e.message); } });
    return () => { alive = false; };
  }, [rev]);
  return { tickets, error, reload: () => setRev((r) => r + 1) };
}

function BoardCard({ t, owner, otherCols, busy, onMove }: {
  t: Ticket; owner: { name: string } | undefined; otherCols: { id: Status; label: string }[]; busy: string | null; onMove: (id: string, s: Status) => void;
}) {
  const spot = useSpotlight<HTMLDivElement>();
  return (
    <div ref={spot.ref} onPointerMove={spot.onPointerMove} onPointerLeave={spot.onPointerLeave} className="board-card spotlight">
      <div className="board-card__title">{t.title}</div>
      {owner && <div className="board-card__owner">{owner.name}</div>}
      <div className="board-card__row">
        {otherCols.slice(0, 3).map((c) => (
          <button key={c.id} type="button" className="link-btn link-btn--small" disabled={busy === t.id} onClick={() => onMove(t.id, c.id)}>{c.label}</button>
        ))}
      </div>
    </div>
  );
}

/** Operate surface — a Kanban-shaped board, action affordances first, no hero. */
export function BoardView() {
  const { tickets, error, reload } = useTickets();
  const bots = useStore((s) => s.bots);
  const byId = useMemo(() => new Map(bots.map((b) => [b.id, b])), [bots]);
  const [busy, setBusy] = useState<string | null>(null);

  async function create(title: string) {
    if (!title.trim()) return;
    setBusy('create');
    try { await api('/tickets', { method: 'POST', body: JSON.stringify({ title }) }); reload(); } catch { /* shows via error state on reload */ }
    setBusy(null);
  }
  async function move(id: string, status: Status) {
    setBusy(id);
    try { await api(`/tickets/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }); reload(); } catch { /* ignore */ }
    setBusy(null);
  }

  return (
    <main className="chat board-view">
      <header className="tasks-view__header">
        <div className="tasks-view__title">Board</div>
        <form className="board-new" onSubmit={(e) => { e.preventDefault(); const f = e.currentTarget; create((f.elements.namedItem('title') as HTMLInputElement).value); f.reset(); }}>
          <input name="title" className="text-input" placeholder="New ticket" aria-label="New ticket title" />
          <button type="submit" className="btn btn--sm" disabled={busy === 'create'}>Add</button>
        </form>
      </header>
      <div className="board-scroll">
        {tickets === null ? <div className="cfg-empty">Loading…</div> : error && tickets.length === 0 ? (
          <div className="tasks-empty"><Glyph name="tasks" size={28} opacity={0.35} /><div className="tasks-empty__title">The board didn't load</div><div className="tasks-empty__sub">{error}</div></div>
        ) : (
          <div className="board-columns">
            {COLUMNS.map((col) => (
              <div key={col.id} className="board-col">
                <div className="board-col__head">{col.label}<span className="board-col__count">{tickets.filter((t) => t.status === col.id).length}</span></div>
                <div className="board-col__cards">
                  {tickets.filter((t) => t.status === col.id).map((t) => {
                    const owner = t.ownerBotId ? byId.get(t.ownerBotId) : undefined;
                    return <BoardCard key={t.id} t={t} owner={owner} otherCols={COLUMNS.filter((c) => c.id !== col.id)} busy={busy} onMove={move} />;
                  })}
                  {tickets.filter((t) => t.status === col.id).length === 0 && <div className="board-col__empty">Empty</div>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

export function BoardIsland() {
  const view = useConfigUI((s) => s.view);
  return (
    <button type="button" className={`sidebar-island${view === 'board' ? ' is-active' : ''}`} onClick={() => useConfigUI.getState().setView(view === 'board' ? 'chat' : 'board')} title="Board" aria-pressed={view === 'board'}>
      <span className="sidebar-island__icon"><Glyph name="tasks" size={18} /></span>
      <span className="sidebar-island__label">Board</span>
    </button>
  );
}

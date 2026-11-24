import { useEffect, useState } from 'react';
import { deployBadgeText, shortSha, type DeployStatusPayload } from '../lib/deploy-format';

/**
 * Bottom-right live build chip. Makes green deploys visible without opening DevTools.
 * Fetches public /api/deploy-status; fails closed to a quiet “offline” state.
 */
export function DeployBadge() {
  const [payload, setPayload] = useState<DeployStatusPayload | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch('/api/deploy-status', { credentials: 'same-origin' });
        if (!r.ok) throw new Error(String(r.status));
        const j = (await r.json()) as DeployStatusPayload;
        if (alive) setPayload(j);
      } catch {
        if (alive) setPayload({ error: 'unreachable', sha: null, board: null });
      }
    };
    load();
    const t = window.setInterval(load, 60_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  const text = deployBadgeText(payload);
  const ok = !!(payload?.sha && !payload?.error);

  return (
    <div className={`deploy-badge${ok ? ' is-live' : ''}${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="deploy-badge__chip"
        aria-expanded={open}
        aria-label={`Deploy status: ${text}`}
        title={text}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="deploy-badge__dot" aria-hidden />
        <span className="deploy-badge__text">{text}</span>
      </button>
      {open && (
        <div className="deploy-badge__panel" role="dialog" aria-label="Deploy details">
          <div className="deploy-badge__row">
            <span>SHA</span>
            <code>{shortSha(payload?.sha, 12)}</code>
          </div>
          <div className="deploy-badge__row">
            <span>Deployed</span>
            <span>{payload?.deployedAt ? new Date(payload.deployedAt).toLocaleString() : '—'}</span>
          </div>
          <div className="deploy-badge__row">
            <span>Board</span>
            <span>
              {payload?.board
                ? `${Number(payload.board.verified ?? 0)}v · ${Number(payload.board.done ?? 0)}d · ${Number(payload.board.pending ?? 0)}p`
                : '—'}
            </span>
          </div>
          <a className="deploy-badge__link" href="/api/deploy-status" target="_blank" rel="noreferrer">
            raw JSON
          </a>
        </div>
      )}
    </div>
  );
}

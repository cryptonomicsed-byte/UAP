/** Pure helpers for the live deploy badge (no DOM). */

export type DeployStatusPayload = {
  sha?: string | null;
  deployedAt?: string | null;
  board?: {
    total?: number;
    done?: number;
    verified?: number;
    pending?: number;
    claimed?: number;
    rework?: number;
  } | null;
  error?: string | null;
};

export function shortSha(sha: string | null | undefined, n = 7): string {
  if (!sha) return '—';
  const s = sha.trim();
  if (!s) return '—';
  return s.slice(0, Math.max(4, n));
}

/** Closed = done + verified; used for the glanceable fraction. */
export function boardClosed(board: DeployStatusPayload['board']): { closed: number; total: number; label: string } {
  const total = Number(board?.total ?? 0);
  const closed = Number(board?.done ?? 0) + Number(board?.verified ?? 0);
  if (!total) return { closed: 0, total: 0, label: 'board empty' };
  return { closed, total, label: `${closed}/${total} closed` };
}

export function deployBadgeText(payload: DeployStatusPayload | null): string {
  if (!payload) return 'deploy …';
  if (payload.error) return `deploy err`;
  const sha = shortSha(payload.sha);
  const { label } = boardClosed(payload.board);
  return `UAP ${sha} · ${label}`;
}

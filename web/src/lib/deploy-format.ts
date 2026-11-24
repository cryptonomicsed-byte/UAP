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
  checklist?: {
    implemented?: number;
    partial?: number;
    missing?: number;
    mapped?: number;
    generatedAt?: string | null;
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

/** Prefer full checklist evidence totals when present. */
export function checklistLabel(checklist: DeployStatusPayload['checklist']): string | null {
  const mapped = Number(checklist?.mapped ?? 0);
  const implemented = Number(checklist?.implemented ?? 0);
  if (!mapped) return null;
  return `${implemented}/${mapped} checklist`;
}

export function deployBadgeText(payload: DeployStatusPayload | null): string {
  if (!payload) return 'deploy …';
  if (payload.error) return `deploy err`;
  const sha = shortSha(payload.sha);
  const cl = checklistLabel(payload.checklist);
  if (cl) return `UAP ${sha} · ${cl}`;
  const { label } = boardClosed(payload.board);
  return `UAP ${sha} · ${label}`;
}

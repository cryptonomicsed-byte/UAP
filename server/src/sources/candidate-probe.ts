/** Classify a GitHub probe row. A reachable repo is still not installable. */
export interface ProbeRow {
  repository: string;
  access: string;
  license?: string | null;
  archived?: boolean;
  installable?: boolean;
  trust?: string;
  head_sha?: string | null;
}

export type ProbeClass = 'not_found' | 'auth_or_rate' | 'archived' | 'no_license' | 'unverified';

export function classifyProbe(row: ProbeRow): ProbeClass {
  if (row.access === 'not_found') return 'not_found';
  if (row.access === 'auth_or_rate' || row.access === 'error') return 'auth_or_rate';
  if (row.archived || row.access === 'archived') return 'archived';
  if (!row.license) return 'no_license';
  return 'unverified';
}

/** Promotion requires an independent reviewer. Probe success is not that signature. */
export function canPromote(row: ProbeRow): false {
  void classifyProbe(row);
  return false;
}

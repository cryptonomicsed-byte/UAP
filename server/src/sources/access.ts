/**
 * B-20 / V6-02-04: prove direct source access, or record the failure honestly.
 *
 * GitHub answers 404 for both a missing repository and a private one without
 * credentials, so that case is reported as `not_found_or_private_without_credentials`
 * rather than pretending it is one or the other. A redirect is recorded as
 * `moved` with its target; following it is a separate, visible decision.
 */

export type AccessStatus = 'ok' | 'not-found' | 'auth-required' | 'forbidden' | 'rate-limited' | 'moved' | 'network-error';

export interface RepositoryProbe {
  readonly status: number;
  readonly archived?: boolean;
  readonly defaultBranch?: string;
  readonly redirectUrl?: string;
  readonly forkOf?: string | null;
  readonly mirrorOf?: string | null;
  readonly licenseSpdx?: string | null;
  readonly rateLimitRemaining?: number;
}

export interface SourceAccessClient {
  probe(owner: string, repo: string): Promise<RepositoryProbe>;
}

export interface AccessObservation {
  readonly status: AccessStatus;
  readonly httpStatus: number | null;
  readonly archived: boolean;
  readonly defaultBranch: string | null;
  readonly redirectUrl: string | null;
  /** Stable, non-secret explanation suitable for the registry. */
  readonly detail: string;
}

export async function inspectSourceAccess(client: SourceAccessClient, source: { owner: string; repo: string }): Promise<AccessObservation> {
  let probe: RepositoryProbe;
  try {
    probe = await client.probe(source.owner, source.repo);
  } catch {
    return { status: 'network-error', httpStatus: null, archived: false, defaultBranch: null, redirectUrl: null, detail: 'request_failed' };
  }
  const base = { httpStatus: probe.status, archived: probe.archived === true, defaultBranch: probe.defaultBranch ?? null };
  if (probe.status === 200) {
    return { ...base, status: 'ok', redirectUrl: null, detail: probe.archived ? 'archived' : 'accessible' };
  }
  if ([301, 302, 307, 308].includes(probe.status)) {
    return { ...base, status: 'moved', redirectUrl: probe.redirectUrl ?? null, detail: 'relocated' };
  }
  if (probe.status === 401) return { ...base, status: 'auth-required', redirectUrl: null, detail: 'auth_required' };
  if (probe.status === 403) {
    return probe.rateLimitRemaining === 0
      ? { ...base, status: 'rate-limited', redirectUrl: null, detail: 'rate_limited' }
      : { ...base, status: 'forbidden', redirectUrl: null, detail: 'forbidden' };
  }
  if (probe.status === 404) return { ...base, status: 'not-found', redirectUrl: null, detail: 'not_found_or_private_without_credentials' };
  return { ...base, status: 'network-error', redirectUrl: null, detail: `unexpected_status_${probe.status}` };
}

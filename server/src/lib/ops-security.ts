// R-51..54 SBOM signing, prompt-injection CI, backup/restore/replay, load/partition, SLO/release
import { createHash, createHmac, randomBytes } from 'node:crypto';

export interface SbomComponent {
  name: string;
  version: string;
  purl?: string;
}

export interface SignedSbom {
  components: SbomComponent[];
  contentHash: string;
  signature: string;
  signedBy: string;
  signedAt: string;
}

export function buildSbom(components: SbomComponent[]): { contentHash: string; body: string } {
  const body = JSON.stringify({
    bomFormat: 'uap-sbom/1',
    components: [...components].sort((a, b) => a.name.localeCompare(b.name)),
  });
  return { contentHash: createHash('sha256').update(body).digest('hex'), body };
}

export function signSbom(components: SbomComponent[], signingKey: string, signedBy: string): SignedSbom {
  const { contentHash, body } = buildSbom(components);
  const signature = createHmac('sha256', signingKey).update(body).digest('hex');
  return { components: [...components], contentHash, signature, signedBy, signedAt: new Date().toISOString() };
}

export function verifySbom(sbom: SignedSbom, signingKey: string): boolean {
  const { body, contentHash } = buildSbom(sbom.components);
  if (contentHash !== sbom.contentHash) return false;
  const expected = createHmac('sha256', signingKey).update(body).digest('hex');
  return expected === sbom.signature;
}

/** Prompt-injection CI patterns — fail closed on match in untrusted input channels. */
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior)\s+instructions/i,
  /system\s*:\s*you\s+are\s+now/i,
  /<\/?system>/i,
  /exfiltrate\s+(secrets|keys|credentials)/i,
  /do\s+not\s+follow\s+your\s+(safety|policy)/i,
];

export function scanPromptInjection(text: string): { clean: boolean; hits: string[] } {
  const hits: string[] = [];
  for (const re of INJECTION_PATTERNS) {
    if (re.test(text)) hits.push(re.source);
  }
  return { clean: hits.length === 0, hits };
}

export interface BackupBlob {
  id: string;
  snapshotHash: string;
  payload: string;
  createdAt: string;
}

export function createBackup(state: unknown): BackupBlob {
  const payload = JSON.stringify(state);
  return {
    id: `bak_${randomBytes(6).toString('hex')}`,
    snapshotHash: createHash('sha256').update(payload).digest('hex'),
    payload,
    createdAt: new Date().toISOString(),
  };
}

export function restoreBackup<T>(blob: BackupBlob): T {
  const hash = createHash('sha256').update(blob.payload).digest('hex');
  if (hash !== blob.snapshotHash) {
    throw Object.assign(new Error('backup hash mismatch'), { code: 'backup_corrupt' });
  }
  return JSON.parse(blob.payload) as T;
}

export function replayEvents<T extends { id: string }>(
  events: T[],
  apply: (state: unknown, ev: T) => unknown,
  initial: unknown = {},
): { state: unknown; replayed: number } {
  let state = initial;
  const seen = new Set<string>();
  for (const ev of events) {
    if (seen.has(ev.id)) continue; // idempotent replay
    seen.add(ev.id);
    state = apply(state, ev);
  }
  return { state, replayed: seen.size };
}

/** R-53 load + partition fail-closed */
export function evaluatePartition(input: {
  quorum: number;
  reachable: number;
  writeAttempt: boolean;
}): { allowWrite: boolean; blockers: string[] } {
  const blockers: string[] = [];
  if (input.reachable < input.quorum) {
    blockers.push('partition_below_quorum');
    if (input.writeAttempt) blockers.push('write_fail_closed');
  }
  return { allowWrite: blockers.length === 0, blockers };
}

export function loadShed(input: { rps: number; limit: number }): { shed: boolean; acceptRatio: number } {
  if (input.rps <= input.limit) return { shed: false, acceptRatio: 1 };
  const acceptRatio = Math.max(0, input.limit / input.rps);
  return { shed: true, acceptRatio };
}

export interface SloTarget {
  name: string;
  objective: number; // e.g. 0.999
  windowHours: number;
}

export interface ReleaseRecord {
  version: string;
  sbomHash: string;
  testsPassed: boolean;
  injectionScanClean: boolean;
  backupVerified: boolean;
  slo: SloTarget[];
  playbooks: string[];
  recordedAt: string;
  blockers: string[];
}

export function buildReleaseRecord(input: {
  version: string;
  sbom: SignedSbom;
  testsPassed: boolean;
  injectionScanClean: boolean;
  backupVerified: boolean;
  slo: SloTarget[];
  playbooks: string[];
}): ReleaseRecord {
  const blockers: string[] = [];
  if (!input.testsPassed) blockers.push('tests_failed');
  if (!input.injectionScanClean) blockers.push('injection_scan_dirty');
  if (!input.backupVerified) blockers.push('backup_not_verified');
  if (!input.sbom.signature) blockers.push('sbom_unsigned');
  if (!input.playbooks.includes('incident-response')) blockers.push('missing_incident_playbook');
  if (!input.playbooks.includes('rollback')) blockers.push('missing_rollback_playbook');
  if (input.slo.length === 0) blockers.push('slo_missing');
  return {
    version: input.version,
    sbomHash: input.sbom.contentHash,
    testsPassed: input.testsPassed,
    injectionScanClean: input.injectionScanClean,
    backupVerified: input.backupVerified,
    slo: input.slo,
    playbooks: input.playbooks,
    recordedAt: new Date().toISOString(),
    blockers,
  };
}

export function assertReleaseRecordReady(rec: ReleaseRecord): void {
  if (rec.blockers.length) {
    throw Object.assign(new Error(`release blocked: ${rec.blockers.join(',')}`), {
      code: 'release_record_blocked',
      blockers: rec.blockers,
    });
  }
}

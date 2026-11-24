import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { driverCall, openWorkforce } from './workforce-runtime.js';

export interface AdoptionRow {
  repository: string;
  url: string;
  source_family: string;
  adoption_type: string;
  priority: string;
  what_we_take: string;
  caution_or_gate: string;
  audit_state: string;
}

export interface AdoptionDecision {
  repository: string;
  priority: string;
  adoption_type: string;
  installable: false;
  executeContent: false;
  reason: string;
}

/** Quote-aware CSV. The matrix is the contract; a row is not an install. */
export function parseCsv(text: string): AdoptionRow[] {
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  const [header, ...body] = rows.filter((r) => r.some((c) => c.trim()));
  return body.map((cells) => {
    const rec = Object.fromEntries(header.map((h, i) => [h.trim(), (cells[i] ?? '').trim()]));
    return rec as unknown as AdoptionRow;
  });
}

export function loadAdoptionMatrix(path: string): AdoptionRow[] {
  return parseCsv(readFileSync(path, 'utf8'));
}

export function decideAdoption(row: AdoptionRow): AdoptionDecision {
  const kind = row.adoption_type.toUpperCase();
  const knowledge = kind.includes('KNOWLEDGE') || kind.includes('DATASET') || kind.includes('REFERENCE') || kind.includes('CANDIDATE');
  return {
    repository: row.repository,
    priority: row.priority,
    adoption_type: row.adoption_type,
    installable: false,
    executeContent: false,
    reason: knowledge
      ? 'reference or knowledge only; content is not executed'
      : 'source and license audit required before any install',
  };
}

export function adoptionReport(rows: AdoptionRow[]) {
  const decisions = rows.map(decideAdoption);
  return {
    count: decisions.length,
    installable: 0,
    executed: 0,
    p0: decisions.filter((d) => d.priority === 'P0').map((d) => d.repository),
    decisions,
  };
}

export interface SliceResult {
  sid: string;
  sidAfterTeardown: string;
  taskStatus: string;
  toolWithLease: { allowed: boolean; code: string };
  toolWithoutLease: { allowed: boolean; code: string };
  shellBypass: { ok: boolean; code: string };
  uncertainBlocksSuccess: boolean;
  rust: { allowed: boolean; code: string };
  elixir: 'spawned' | 'unavailable';
}

function rustGate(bin: string, body: Record<string, string | null>): { allowed: boolean; code: string } {
  const proc = spawnSync(bin, [], { input: JSON.stringify(body), encoding: 'utf8', timeout: 5000 });
  if (proc.status !== 0) throw new Error(`lease-gate failed: ${proc.stderr || proc.stdout}`);
  return JSON.parse(proc.stdout);
}

/** Atlas §13 priority slice. Role title is not a grant. Worker death does not delete the SID. */
export function runAgentOsSlice(opts: { rustBin: string; elixir?: boolean }): SliceResult {
  const db = new Database(':memory:');
  const wf = openWorkforce(db);
  const role = 'rust-kernel-engineer';
  const roleDigest = createHash('sha256').update(role).digest('hex');
  const sid = wf.activateRole({ tenantId: 'tenant_agentos', roleSlug: role, roleDigest }).sid;
  const task = wf.assignTask({
    tenantId: 'tenant_agentos',
    sid,
    intent: 'compile the lease gate',
    riskClass: 'READ_DRAFT',
    idempotencyKey: `slice:${sid}`,
  });
  const withLease = rustGate(opts.rustBin, { presented_lease: task.leaseId, lease_id: task.leaseId, status: task.status });
  const without = rustGate(opts.rustBin, { presented_lease: '', lease_id: task.leaseId, status: task.status });
  const shell = driverCall({ protocol: 'raw-shell' }, 'startTurn');
  const crashed = wf.crashWorker(task.taskId);
  let uncertainBlocksSuccess = false;
  try { wf.teardown(task.taskId, 'SUCCEEDED'); } catch { uncertainBlocksSuccess = true; }
  const still = wf.installation(sid);
  const elixir = opts.elixir
    ? spawnSync('elixir', ['-e', 'IO.puts("SPAWN sid")\nIO.puts("TERMINATED sid")'], { encoding: 'utf8', timeout: 8000 })
    : { status: 1, stdout: '' };
  db.close();
  return {
    sid,
    sidAfterTeardown: still.status,
    taskStatus: crashed.status,
    toolWithLease: withLease,
    toolWithoutLease: without,
    shellBypass: { ok: shell.ok, code: shell.code },
    uncertainBlocksSuccess,
    rust: withLease,
    elixir: elixir.status === 0 && elixir.stdout.includes('SPAWN') ? 'spawned' : 'unavailable',
  };
}

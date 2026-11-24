// K-36 Language-specific coding gate packs (V6-11-01..07)
// Pinned profiles + real tool check definitions. Pass requires tool evidence, never skill claims.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type LanguageId =
  | 'rust'
  | 'elixir'
  | 'julia'
  | 'move'
  | 'go'
  | 'python'
  | 'clojure';

export type CheckKind = 'fmt' | 'lint' | 'test' | 'type' | 'audit' | 'race' | 'profile' | 'object-model' | 'supervision';

export interface GateCheck {
  id: string;
  kind: CheckKind;
  /** argv[0] binary that must exist for a live run */
  binary: string;
  args: string[];
  /** If true, missing binary → skip (not fail) when allowSkipMissingTools */
  optional?: boolean;
  description: string;
}

export interface LanguageGatePack {
  id: LanguageId;
  version: string;
  title: string;
  pinnedToolchain: string;
  checks: GateCheck[];
  /** sha256 of canonical JSON of pack identity fields */
  digest: string;
}

export interface CheckEvidence {
  checkId: string;
  status: 'pass' | 'fail' | 'skip' | 'not_run';
  exitCode: number | null;
  stdoutSha256: string | null;
  stderrSha256: string | null;
  durationMs: number;
  binaryPresent: boolean;
  note?: string;
}

export interface PackRunResult {
  packId: LanguageId;
  version: string;
  packDigest: string;
  ranAt: string;
  evidence: CheckEvidence[];
  /** True only when every required check has status pass with tool output hashes */
  pass: boolean;
  blockers: string[];
}

const REQUIRED_LANGUAGES: LanguageId[] = [
  'rust', 'elixir', 'julia', 'move', 'go', 'python', 'clojure',
];

function digestPack(pack: Omit<LanguageGatePack, 'digest'>): string {
  const canonical = JSON.stringify({
    id: pack.id,
    version: pack.version,
    title: pack.title,
    pinnedToolchain: pack.pinnedToolchain,
    checks: pack.checks.map((c) => ({
      id: c.id, kind: c.kind, binary: c.binary, args: c.args, optional: !!c.optional, description: c.description,
    })),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function pack(p: Omit<LanguageGatePack, 'digest'>): LanguageGatePack {
  return { ...p, digest: digestPack(p) };
}

/** Curated pinned gate packs — one per language (V6-11-01..07). */
export const LANGUAGE_GATE_PACKS: Record<LanguageId, LanguageGatePack> = {
  rust: pack({
    id: 'rust',
    version: '1.0.0',
    title: 'Rust — rustfmt + clippy + cargo test',
    pinnedToolchain: 'stable-1.83+',
    checks: [
      { id: 'rust.fmt', kind: 'fmt', binary: 'cargo', args: ['fmt', '--', '--check'], description: 'rustfmt check' },
      { id: 'rust.clippy', kind: 'lint', binary: 'cargo', args: ['clippy', '--', '-D', 'warnings'], description: 'clippy -D warnings' },
      { id: 'rust.test', kind: 'test', binary: 'cargo', args: ['test', '--workspace'], description: 'cargo test --workspace' },
    ],
  }),
  elixir: pack({
    id: 'elixir',
    version: '1.0.0',
    title: 'Elixir OTP — mix format + compile + ExUnit',
    pinnedToolchain: 'elixir-1.17+/otp-27',
    checks: [
      { id: 'elixir.fmt', kind: 'fmt', binary: 'mix', args: ['format', '--check-formatted'], description: 'mix format check' },
      { id: 'elixir.test', kind: 'test', binary: 'mix', args: ['test'], description: 'ExUnit' },
      { id: 'elixir.supervision', kind: 'supervision', binary: 'mix', args: ['test', '--only', 'supervision'], optional: true, description: 'OTP supervision failure tests' },
    ],
  }),
  julia: pack({
    id: 'julia',
    version: '1.0.0',
    title: 'Julia — package tests + deterministic numerical fixtures',
    pinnedToolchain: 'julia-1.10+',
    checks: [
      { id: 'julia.test', kind: 'test', binary: 'julia', args: ['--project=.', '-e', 'using Pkg; Pkg.test()'], description: 'Pkg.test()' },
      { id: 'julia.profile', kind: 'profile', binary: 'julia', args: ['--project=.', '-e', 'include("test/runtests.jl")'], optional: true, description: 'numerical fixtures' },
    ],
  }),
  move: pack({
    id: 'move',
    version: '1.0.0',
    title: 'Move (Sui) — package build + object-model tests',
    pinnedToolchain: 'sui-cli-1.37+',
    checks: [
      { id: 'move.build', kind: 'test', binary: 'sui', args: ['move', 'build'], description: 'sui move build' },
      { id: 'move.test', kind: 'object-model', binary: 'sui', args: ['move', 'test'], description: 'sui move test (object model)' },
    ],
  }),
  go: pack({
    id: 'go',
    version: '1.0.0',
    title: 'Go — test + race + vet',
    pinnedToolchain: 'go-1.22+',
    checks: [
      { id: 'go.vet', kind: 'lint', binary: 'go', args: ['vet', './...'], description: 'go vet' },
      { id: 'go.test', kind: 'test', binary: 'go', args: ['test', './...'], description: 'go test' },
      { id: 'go.race', kind: 'race', binary: 'go', args: ['test', '-race', './...'], optional: true, description: 'go test -race' },
    ],
  }),
  python: pack({
    id: 'python',
    version: '1.0.0',
    title: 'Python — ruff + typing + pytest + audit',
    pinnedToolchain: 'python-3.11+',
    checks: [
      { id: 'python.ruff', kind: 'lint', binary: 'ruff', args: ['check', '.'], description: 'ruff check' },
      { id: 'python.type', kind: 'type', binary: 'mypy', args: ['.'], optional: true, description: 'mypy' },
      { id: 'python.test', kind: 'test', binary: 'pytest', args: ['-q'], description: 'pytest' },
      { id: 'python.audit', kind: 'audit', binary: 'pip-audit', args: [], optional: true, description: 'dependency audit' },
    ],
  }),
  clojure: pack({
    id: 'clojure',
    version: '1.0.0',
    title: 'Clojure — Kaocha (or chosen runner) + Malli schemas',
    pinnedToolchain: 'clojure-1.11+/kaocha',
    checks: [
      { id: 'clojure.test', kind: 'test', binary: 'clojure', args: ['-M:test'], description: 'clojure -M:test (Kaocha/default)' },
      { id: 'clojure.malli', kind: 'lint', binary: 'clojure', args: ['-M:dev', '-e', '(require \'malli.core)'], optional: true, description: 'Malli load smoke' },
    ],
  }),
};

export function listLanguageGatePacks(): LanguageGatePack[] {
  return REQUIRED_LANGUAGES.map((id) => LANGUAGE_GATE_PACKS[id]);
}

export function getLanguageGatePack(id: LanguageId, version?: string): LanguageGatePack | null {
  const p = LANGUAGE_GATE_PACKS[id];
  if (!p) return null;
  if (version && p.version !== version) return null;
  return p;
}

export function assertSevenPacksComplete(): void {
  for (const id of REQUIRED_LANGUAGES) {
    const p = LANGUAGE_GATE_PACKS[id];
    if (!p) throw new Error(`missing pack ${id}`);
    if (!p.checks.length) throw new Error(`pack ${id} has no checks`);
    if (p.digest.length !== 64) throw new Error(`pack ${id} bad digest`);
  }
  if (listLanguageGatePacks().length !== 7) throw new Error('expected 7 packs');
}

function binaryOnPath(bin: string): boolean {
  if (path.isAbsolute(bin) && fs.existsSync(bin)) return true;
  const pathEnv = process.env.PATH || '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    if (fs.existsSync(candidate)) return true;
  }
  return false;
}

function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Run pack checks. Claims never count as pass.
 * - missing required binary → fail (unless allowSkipMissingTools for CI without toolchains)
 * - optional missing → skip
 * - non-zero exit → fail
 * - pass only with exit 0 + stdout/stderr hashes recorded
 */
export function runLanguageGatePack(
  id: LanguageId,
  opts?: {
    cwd?: string;
    allowSkipMissingTools?: boolean;
    dryRun?: boolean;
    timeoutMs?: number;
  },
): PackRunResult {
  const packDef = LANGUAGE_GATE_PACKS[id];
  if (!packDef) {
    return {
      packId: id,
      version: '0',
      packDigest: '',
      ranAt: new Date().toISOString(),
      evidence: [],
      pass: false,
      blockers: ['unknown_pack'],
    };
  }

  const evidence: CheckEvidence[] = [];
  const blockers: string[] = [];
  const timeout = opts?.timeoutMs ?? 120_000;

  for (const check of packDef.checks) {
    const present = binaryOnPath(check.binary);
    if (opts?.dryRun) {
      evidence.push({
        checkId: check.id,
        status: 'not_run',
        exitCode: null,
        stdoutSha256: null,
        stderrSha256: null,
        durationMs: 0,
        binaryPresent: present,
        note: 'dry_run',
      });
      continue;
    }
    if (!present) {
      if (check.optional || opts?.allowSkipMissingTools) {
        evidence.push({
          checkId: check.id,
          status: 'skip',
          exitCode: null,
          stdoutSha256: null,
          stderrSha256: null,
          durationMs: 0,
          binaryPresent: false,
          note: 'binary_missing',
        });
        continue;
      }
      evidence.push({
        checkId: check.id,
        status: 'fail',
        exitCode: null,
        stdoutSha256: null,
        stderrSha256: null,
        durationMs: 0,
        binaryPresent: false,
        note: 'binary_missing_required',
      });
      blockers.push(`missing_binary:${check.binary}`);
      continue;
    }

    const t0 = Date.now();
    const r = spawnSync(check.binary, check.args, {
      cwd: opts?.cwd || process.cwd(),
      encoding: 'utf8',
      timeout,
      env: process.env,
    });
    const durationMs = Date.now() - t0;
    const stdout = r.stdout ?? '';
    const stderr = r.stderr ?? '';
    const code = r.status;
    const ok = code === 0 && !r.error;
    evidence.push({
      checkId: check.id,
      status: ok ? 'pass' : 'fail',
      exitCode: code,
      stdoutSha256: sha(stdout),
      stderrSha256: sha(stderr),
      durationMs,
      binaryPresent: true,
      note: r.error ? String(r.error.message) : undefined,
    });
    if (!ok) blockers.push(`check_failed:${check.id}`);
  }

  // V6-11-10: pass only when every non-skipped check passed with hashes
  const required = evidence.filter((e) => e.status !== 'skip' && e.status !== 'not_run');
  const allPassed = required.length > 0 && required.every((e) => e.status === 'pass' && e.stdoutSha256 && e.stderrSha256);
  const anyNotRun = evidence.every((e) => e.status === 'not_run');
  if (anyNotRun) blockers.push('dry_run_no_pass');
  if (required.length === 0 && !anyNotRun) blockers.push('no_required_checks_executed');

  return {
    packId: packDef.id,
    version: packDef.version,
    packDigest: packDef.digest,
    ranAt: new Date().toISOString(),
    evidence,
    pass: allPassed && blockers.length === 0,
    blockers,
  };
}

/** Reject “skill claimed pass” without evidence (V6-11-10). */
export function acceptPackClaim(claim: { packId: LanguageId; claimedPass: boolean; evidence?: CheckEvidence[] }): {
  accepted: boolean;
  reason: string;
} {
  if (!claim.evidence || claim.evidence.length === 0) {
    return { accepted: false, reason: 'claim_without_evidence' };
  }
  const required = claim.evidence.filter((e) => e.status !== 'skip');
  if (!required.length) return { accepted: false, reason: 'no_required_evidence' };
  for (const e of required) {
    if (e.status !== 'pass') return { accepted: false, reason: `evidence_not_pass:${e.checkId}` };
    if (!e.stdoutSha256 || !e.stderrSha256) return { accepted: false, reason: `missing_output_hash:${e.checkId}` };
  }
  if (!claim.claimedPass) return { accepted: false, reason: 'claim_says_fail' };
  return { accepted: true, reason: 'evidence_ok' };
}

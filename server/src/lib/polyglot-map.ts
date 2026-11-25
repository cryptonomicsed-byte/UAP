/** Polyglot ownership. A missing binary is reported, not faked. */
import { spawnSync } from 'node:child_process';

export interface Pillar {
  niche: string;
  language: string;
  owns: string;
  binary: string | null;
  present: boolean;
}

function has(bin: string | null): boolean {
  if (!bin) return true;
  const probe = spawnSync('bash', ['-lc', `command -v ${bin}`], { encoding: 'utf8', timeout: 3000 });
  return probe.status === 0 && Boolean(probe.stdout.trim());
}

export function polyglotMap(): Pillar[] {
  const rows: Omit<Pillar, 'present'>[] = [
    { niche: 'surface', language: 'TypeScript', owns: 'workspace, roster, templates', binary: 'node' },
    { niche: 'enforcement', language: 'Rust', owns: 'lease gate before a tool runs', binary: 'cargo' },
    { niche: 'lifecycle', language: 'Elixir', owns: 'spawn and teardown announcement', binary: 'elixir' },
    { niche: 'memory', language: 'SQLite now, Julia later', owns: 'notes the owner can read', binary: 'julia' },
    { niche: 'network', language: 'Go', owns: 'not the tenant ledger; bridges only when present', binary: 'go' },
    { niche: 'settlement', language: 'Move', owns: 'chain templates only; no mainnet signer', binary: 'sui' },
    { niche: 'reasoning', language: 'Hermes', owns: 'model sessions, not grants', binary: null },
  ];
  return rows.map((row) => ({ ...row, present: has(row.binary) }));
}

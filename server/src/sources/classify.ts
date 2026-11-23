/**
 * B-20 / V6-02-03: identify what a source is before any install UI can render it.
 *
 * Classification uses only observed evidence: file names in the pinned tree, the
 * repository name and the supplied proposed use. It is intentionally
 * conservative — a README-only repository is `unknown`, not a "skill pack", and
 * nothing here claims a source is executable or safe. `evidence` lists exactly
 * what drove the answer so a reviewer can disagree with it.
 */

export type SourceKind = 'meta-list' | 'agent-skill' | 'dataset' | 'standalone-software' | 'documentation' | 'unknown';
export type ClassificationConfidence = 'high' | 'medium' | 'low';

export interface SourceClassification {
  readonly kind: SourceKind;
  readonly confidence: ClassificationConfidence;
  readonly evidence: string[];
}

export interface ClassificationInput {
  readonly repository: string;
  readonly proposedUse?: string;
  readonly description?: string;
  readonly filePaths?: readonly string[];
}

const SKILL_MANIFESTS = ['SKILL.md', 'AGENTS.md', '.claude/skills/SKILL.md'];
const SOFTWARE_MANIFESTS = ['package.json', 'Cargo.toml', 'pyproject.toml', 'go.mod', 'Move.toml', 'mix.exs', 'Project.toml', 'pom.xml'];
const DATASET_SUFFIXES = ['.jsonl', '.csv', '.parquet', '.arrow', '.tsv'];

function baseName(filePath: string): string {
  const parts = filePath.split('/');
  return parts[parts.length - 1] ?? filePath;
}

export function classifySource(input: ClassificationInput): SourceClassification {
  const files = input.filePaths ?? [];
  const name = input.repository.split('/').at(-1) ?? input.repository;
  const proposedUse = (input.proposedUse ?? '').toLowerCase();
  const description = (input.description ?? '').toLowerCase();

  const skillFile = files.find((file) => SKILL_MANIFESTS.includes(file) || SKILL_MANIFESTS.includes(baseName(file)));
  if (skillFile) return { kind: 'agent-skill', confidence: 'high', evidence: [`file:${skillFile}`] };

  if (/^awesome[-_.]/i.test(name) || /[-_.]awesome$/i.test(name) || /^(meta|awesome)[-_.]/.test(name)) {
    return { kind: 'meta-list', confidence: 'high', evidence: [`name:${name}`] };
  }
  if (/\b(meta[- ]?(list|catalog)|awesome list|discovery source)\b/.test(`${proposedUse} ${description}`)) {
    return { kind: 'meta-list', confidence: 'medium', evidence: ['proposed_use:meta'] };
  }

  const datasetFile = files.find((file) => DATASET_SUFFIXES.some((suffix) => file.toLowerCase().endsWith(suffix)) && (file.includes('/') || file.includes('data')));
  if (datasetFile && !files.some((file) => SOFTWARE_MANIFESTS.includes(baseName(file)))) {
    return { kind: 'dataset', confidence: 'medium', evidence: [`file:${datasetFile}`] };
  }
  if (/\b(dataset|corpus|benchmark data)\b/.test(`${proposedUse} ${description}`) && !files.some((file) => SOFTWARE_MANIFESTS.includes(baseName(file)))) {
    return { kind: 'dataset', confidence: 'low', evidence: ['proposed_use:dataset'] };
  }

  const softwareFile = files.find((file) => SOFTWARE_MANIFESTS.includes(baseName(file)));
  if (softwareFile) return { kind: 'standalone-software', confidence: 'medium', evidence: [`file:${softwareFile}`] };

  if (/\b(checklist|standard|guideline|documentation|readiness)\b/.test(`${proposedUse} ${description}`) && files.some((file) => /\.md$/i.test(file))) {
    return { kind: 'documentation', confidence: 'medium', evidence: ['proposed_use:documentation'] };
  }

  return { kind: 'unknown', confidence: 'low', evidence: ['no recognized manifest, catalog or dataset marker'] };
}

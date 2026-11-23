// Markdown persona parser (V6-03-02).
//
// Persona repositories are prose plus YAML frontmatter. Parsing them yields
// role fields for review and nothing else: tool declarations become
// `requestedTools` (a request the policy kernel may refuse), and fields that
// try to speak about authority (`permissions`, `grants`, `capabilities`) are
// recorded in `ignoredAuthorityFields` so the attempt is visible but powerless.
//
// Nothing here mints a grant, and the canonical source bytes are preserved so
// provenance (C-18 / V6-03-03) can compare canonical text with derived text.
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';

export interface PersonaFile {
  path: string;
  content: string;
}

export interface PersonaDocument {
  path: string;
  title: string;
  description: string | null;
  body: string;
  canonicalMarkdown: string;
  requestedTools: string[];
  unparsedToolDeclarations: string[];
  ignoredAuthorityFields: string[];
}

export interface PersonaRepository {
  documents: PersonaDocument[];
  digest: string;
}

export class PersonaError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PersonaError';
    this.code = code;
  }
}

const MAX_FILE_BYTES = 1024 * 1024;
const TOOL_RE = /^[a-z0-9][a-z0-9_.:-]{0,80}$/;
const TOOL_FIELDS = ['tools', 'allowed-tools', 'allowedTools'] as const;
const AUTHORITY_FIELDS = ['permissions', 'grants', 'capabilities', 'authorization', 'allow'] as const;

function fail(code: string, message: string): never {
  throw new PersonaError(code, message);
}

export function requirePersonaPath(value: unknown): string {
  if (typeof value !== 'string') fail('path_invalid', 'persona path must be a string');
  const path = value.trim();
  const segments = path.split('/');
  if (
    !path ||
    path.length > 400 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    segments.some(segment => segment === '..' || segment === '.' || segment === '') ||
    !path.endsWith('.md')
  ) {
    fail('path_invalid', 'persona path must be a relative .md path inside the source repository');
  }
  return path;
}

function splitFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  if (!content.startsWith('---')) return { frontmatter: {}, body: content };
  const open = content.match(/^---\r?\n/);
  if (!open) fail('frontmatter_invalid', 'frontmatter must open with a --- line');
  const rest = content.slice(open[0].length);
  const close = rest.match(/\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!close || close.index === undefined) fail('frontmatter_invalid', 'frontmatter is not closed with ---');
  const raw = rest.slice(0, close.index);
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    fail('frontmatter_invalid', `frontmatter is not valid YAML: ${(err as Error).message}`);
  }
  if (parsed === null || parsed === undefined) return { frontmatter: {}, body: rest.slice(close.index + close[0].length) };
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('frontmatter_invalid', 'frontmatter must be a mapping');
  }
  return { frontmatter: parsed as Record<string, unknown>, body: rest.slice(close.index + close[0].length) };
}

function toolDeclarations(frontmatter: Record<string, unknown>): unknown[] {
  const out: unknown[] = [];
  for (const field of TOOL_FIELDS) {
    if (!(field in frontmatter)) continue;
    const value = frontmatter[field];
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      if (typeof item !== 'string') {
        out.push(String(item));
        continue;
      }
      for (const part of item.split(',')) out.push(part);
    }
  }
  return out;
}

function normaliseTools(declarations: unknown[]): { requestedTools: string[]; unparsedToolDeclarations: string[] } {
  const requested = new Set<string>();
  const unparsed: string[] = [];
  for (const declaration of declarations) {
    const raw = String(declaration)
      .trim()
      .replace(/^["'](.*)["']$/, '$1')
      .trim();
    if (!raw) continue;
    // "Bash(git:*)" describes an invocation scope; the tool is Bash. The scope
    // itself is not parsed into authority here — it is a request for review.
    const name = raw.replace(/\s*\(.*\)\s*$/, '').trim().toLowerCase();
    if (TOOL_RE.test(name)) requested.add(name);
    else if (!unparsed.includes(raw)) unparsed.push(raw);
  }
  return { requestedTools: [...requested].sort(), unparsedToolDeclarations: unparsed };
}

function firstHeading(body: string): string | null {
  const match = body.match(/^#[ \t]+(.+?)[ \t]*#*[ \t]*$/m);
  return match ? match[1].trim() : null;
}

function optionalText(value: unknown, code: string, field: string, max = 400): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') fail(code, `${field} must be a string`);
  const text = value.trim();
  if (!text || text.length > max) fail(code, `${field} must be 1..${max} characters`);
  return text;
}

/** Parse one persona markdown file. The source bytes are kept in canonicalMarkdown. */
export function parsePersonaFile(file: PersonaFile): PersonaDocument {
  if (!file || typeof file !== 'object') fail('content_invalid', 'persona file is required');
  const path = requirePersonaPath(file.path);
  if (typeof file.content !== 'string') fail('content_invalid', 'persona content must be a string');
  if (file.content.includes('\0')) fail('content_invalid', 'persona content contains a NUL byte');
  if (Buffer.byteLength(file.content, 'utf8') > MAX_FILE_BYTES) {
    fail('file_too_large', `persona file exceeds ${MAX_FILE_BYTES} bytes`);
  }
  if (!file.content.trim()) fail('content_empty', 'persona file is empty');

  const { frontmatter, body } = splitFrontmatter(file.content);
  const title =
    optionalText(frontmatter.title, 'title_invalid', 'title', 200) ??
    optionalText(frontmatter.name, 'title_invalid', 'name', 200) ??
    firstHeading(body);
  if (!title) fail('title_missing', 'persona needs a title, name or H1 heading');
  const description = optionalText(frontmatter.description, 'description_invalid', 'description', 1000);
  const { requestedTools, unparsedToolDeclarations } = normaliseTools(toolDeclarations(frontmatter));
  const ignoredAuthorityFields = AUTHORITY_FIELDS.filter(field => field in frontmatter).sort();

  return {
    path,
    title,
    description,
    body,
    canonicalMarkdown: file.content,
    requestedTools,
    unparsedToolDeclarations,
    ignoredAuthorityFields,
  };
}

/**
 * Parse a persona repository. Documents are ordered by path and the digest is
 * sha256 over `path\0content\0` in that order, so the same bytes always produce
 * the same source digest regardless of how the caller listed the files.
 */
export function parsePersonaRepository(files: PersonaFile[]): PersonaRepository {
  if (!Array.isArray(files) || files.length === 0) fail('input_invalid', 'a persona repository needs at least one file');
  const seen = new Set<string>();
  for (const file of files) {
    const path = requirePersonaPath(file?.path);
    if (seen.has(path)) fail('duplicate_path', `duplicate persona path ${path}`);
    seen.add(path);
  }
  const ordered = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const documents = ordered.map(parsePersonaFile);
  const hash = createHash('sha256');
  for (const doc of documents) hash.update(`${doc.path}\0${doc.canonicalMarkdown}\0`, 'utf8');
  return { documents, digest: hash.digest('hex') };
}

/** Compose canonical instructions in path order; the derived text is its own artifact. */
export function composeInstructions(documents: PersonaDocument[]): string {
  if (!Array.isArray(documents) || documents.length === 0) fail('input_invalid', 'no persona documents to compose');
  return `${documents.map(doc => doc.body.trimEnd()).join('\n\n')}\n`;
}

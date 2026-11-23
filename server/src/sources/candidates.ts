/**
 * B-20 / V6-02-01: the user-supplied candidate corpus is imported as data.
 *
 * The CSV is an intake list, not an approval: every row keeps the name and URL
 * exactly as supplied and carries its unverified status through to ingestion.
 * Parsing is deliberately strict — a misspelt header, an empty URL or two rows
 * for the same source are refused rather than silently repaired.
 */

export interface SourceCandidate {
  readonly group: string;
  readonly repository: string;
  readonly url: string;
  readonly proposedUse: string;
  readonly status: string;
}

export type SourceCandidateErrorCode =
  | 'invalid_candidate_header'
  | 'invalid_candidate_row'
  | 'duplicate_candidate';

export class SourceCandidateError extends Error {
  readonly code: SourceCandidateErrorCode;
  constructor(code: SourceCandidateErrorCode, message: string) {
    super(message);
    this.name = 'SourceCandidateError';
    this.code = code;
  }
}

const REQUIRED_COLUMNS = ['group', 'repository', 'url', 'proposed_use', 'status'] as const;

/** RFC 4180 subset: quoted fields, doubled quotes inside quotes, CRLF or LF. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  while (i < text.length) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += char; i++; continue;
    }
    if (char === '"' && field === '') { quoted = true; i++; continue; }
    if (char === ',') { pushField(); i++; continue; }
    if (char === '\r' || char === '\n') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      pushRow(); i++;
      continue;
    }
    field += char; i++;
  }
  if (quoted) throw new SourceCandidateError('invalid_candidate_row', 'Candidate CSV ends inside a quoted field.');
  if (field.length > 0 || row.length > 0) pushRow();
  return rows.filter((cells) => cells.length > 1 || (cells[0] ?? '').trim().length > 0);
}

function requireText(value: string | undefined, column: string, line: number): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) throw new SourceCandidateError('invalid_candidate_row', `Candidate row ${line} has an empty ${column}.`);
  if (trimmed.length > 2_000) throw new SourceCandidateError('invalid_candidate_row', `Candidate row ${line} has an oversized ${column}.`);
  if (trimmed.includes('\0')) throw new SourceCandidateError('invalid_candidate_row', `Candidate row ${line} has a NUL in ${column}.`);
  return trimmed;
}

export function parseCandidateCsv(text: string): SourceCandidate[] {
  const rows = parseCsvRows(text);
  if (rows.length === 0) throw new SourceCandidateError('invalid_candidate_header', 'Candidate CSV is empty.');
  const header = rows[0].map((cell) => cell.trim().toLowerCase());
  if (header.length !== REQUIRED_COLUMNS.length || REQUIRED_COLUMNS.some((column, index) => header[index] !== column)) {
    throw new SourceCandidateError('invalid_candidate_header', `Candidate CSV header must be exactly: ${REQUIRED_COLUMNS.join(',')}`);
  }
  const candidates: SourceCandidate[] = [];
  const seen = new Set<string>();
  rows.slice(1).forEach((cells, offset) => {
    const line = offset + 2;
    if (cells.length !== REQUIRED_COLUMNS.length) {
      throw new SourceCandidateError('invalid_candidate_row', `Candidate row ${line} has ${cells.length} columns, expected ${REQUIRED_COLUMNS.length}.`);
    }
    const [group, repository, url, proposedUse, status] = cells;
    const candidate: SourceCandidate = {
      group: requireText(group, 'group', line),
      repository: requireText(repository, 'repository', line),
      url: requireText(url, 'url', line),
      proposedUse: requireText(proposedUse, 'proposed_use', line),
      status: requireText(status, 'status', line),
    };
    let parsed: URL;
    try { parsed = new URL(candidate.url); }
    catch { throw new SourceCandidateError('invalid_candidate_row', `Candidate row ${line} has an invalid URL.`); }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new SourceCandidateError('invalid_candidate_row', `Candidate row ${line} must be an http(s) URL.`);
    }
    const key = `${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase()}`;
    if (seen.has(key)) throw new SourceCandidateError('duplicate_candidate', `Candidate row ${line} repeats ${candidate.url}.`);
    seen.add(key);
    candidates.push(candidate);
  });
  if (candidates.length === 0) throw new SourceCandidateError('invalid_candidate_row', 'Candidate CSV contains no rows.');
  return candidates;
}

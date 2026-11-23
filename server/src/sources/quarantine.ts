/**
 * B-21 / V6-02-07: quarantine, malicious-prompt detection, executable-script analysis
 * and secret scan for every imported source.
 *
 * A scan returns evidence. It never promotes a source: `importAllowed` is true only
 * for a bundle with no block and no warning, and `assertImportAllowed` is the hard gate
 * a pipeline calls before treating imported content as role instructions.
 *
 * Secrets are never echoed: every finding carries a redacted excerpt (first characters
 * plus the secret's length), so the report itself cannot become the leak.
 */

import { scanInstructions } from '../roles/role-review.js';

export type ScanSeverity = 'block' | 'warn' | 'info';

export type FindingCategory = 'secret' | 'prompt-injection' | 'executable' | 'unscannable';

export interface ScanFinding {
  readonly category: FindingCategory;
  readonly rule: string;
  readonly severity: ScanSeverity;
  readonly path: string;
  readonly line: number | null;
  /** Safe to log: secrets are truncated, never reproduced. */
  readonly excerpt: string;
  readonly detail: string;
}

export interface SourceFileInput {
  readonly path: string;
  readonly content: string | Uint8Array;
  /**
   * Size from the filesystem when the caller did not load the body (a file above the
   * budget). Without it an oversized file would be reported as the fragment that was
   * read, which understates what was skipped.
   */
  readonly declaredSize?: number;
}

export type QuarantineDecision = 'clean' | 'needs-review' | 'quarantined';

export interface QuarantineCounts {
  readonly files: number;
  readonly bytes: number;
  readonly findings: number;
  readonly skipped: number;
  readonly executableFiles: number;
  readonly bySeverity: { readonly block: number; readonly warn: number; readonly info: number };
}

export interface QuarantineAssessment {
  readonly decision: QuarantineDecision;
  readonly importAllowed: boolean;
  readonly findings: readonly ScanFinding[];
  readonly blockers: readonly string[];
  readonly counts: QuarantineCounts;
}

export const SCAN_LIMITS = {
  /** Larger files are not scanned; they are reported as skipped, never silently passed. */
  fileBytes: 1_048_576,
  totalBytes: 16_777_216,
} as const;

const PLACEHOLDER = /^(?:x{6,}|\*{3,}|<[^>]*>|your|example|changeme|change_me|placeholder|redacted|sample|dummy|fake|insert|todo|none|null|undefined|test)/i;

function redact(value: string): string {
  const keep = Math.min(4, Math.max(0, value.length - 1));
  return `${value.slice(0, keep)}…(${value.length} chars)`;
}

function isPlaceholder(value: string): boolean {
  if (PLACEHOLDER.test(value)) return true;
  return new Set(value).size === 1;
}

interface SecretRule {
  readonly rule: string;
  readonly severity: ScanSeverity;
  readonly pattern: RegExp;
  readonly detail: string;
}

/** Line-scoped provider patterns. Generic assignments are checked only when none match. */
const SECRET_RULES: readonly SecretRule[] = [
  { rule: 'private_key_block', severity: 'block', pattern: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/, detail: 'Embedded private key material.' },
  { rule: 'aws_access_key', severity: 'block', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, detail: 'AWS access key identifier.' },
  { rule: 'github_token', severity: 'block', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, detail: 'GitHub personal access or app token.' },
  { rule: 'slack_token', severity: 'block', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, detail: 'Slack API token.' },
  { rule: 'stripe_live_key', severity: 'block', pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/, detail: 'Stripe live secret key.' },
  { rule: 'openai_key', severity: 'block', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/, detail: 'OpenAI-style secret key.' },
  { rule: 'google_api_key', severity: 'block', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/, detail: 'Google API key.' },
  { rule: 'jwt', severity: 'warn', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, detail: 'Signed JWT that may carry a live session.' },
];

const GENERIC_ASSIGNMENT = /\b(?:api[_-]?key|secret|token|password|passwd|access[_-]?key|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*["']?([A-Za-z0-9+/=_-]{16,})["']?/i;

export function scanForSecrets(text: string, path: string): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const lines = text.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    let lineMatched = false;
    for (const rule of SECRET_RULES) {
      if (rule.rule === 'private_key_block') continue;
      const match = rule.pattern.exec(line);
      if (!match) continue;
      lineMatched = true;
      findings.push({
        category: 'secret',
        rule: rule.rule,
        severity: rule.severity,
        path,
        line: index + 1,
        excerpt: redact(match[0]),
        detail: rule.detail,
      });
    }
    if (!lineMatched) {
      const generic = GENERIC_ASSIGNMENT.exec(line);
      const value = generic?.[1];
      if (value && !isPlaceholder(value)) {
        findings.push({
          category: 'secret',
          rule: 'generic_credential_assignment',
          severity: 'warn',
          path,
          line: index + 1,
          excerpt: redact(value),
          detail: 'Credential-shaped value assigned in source text.',
        });
      }
    }
  }

  const block = /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/.exec(text);
  if (block) {
    const line = text.slice(0, block.index).split('\n').length;
    findings.push({
      category: 'secret',
      rule: 'private_key_block',
      severity: 'block',
      path,
      line,
      excerpt: 'PRIVATE KEY',
      detail: 'Embedded private key material.',
    });
  }

  return findings;
}

interface InjectionRule {
  readonly rule: string;
  readonly severity: ScanSeverity;
  readonly pattern: RegExp;
  readonly detail: string;
}

/**
 * Source-specific injection rules. The seven override classes (ignore_instructions,
 * prompt_extraction, safety_disable, identity_hijack, secret_read, privilege_escalation,
 * covert_action) are NOT re-declared here: the import scan delegates to C-19's
 * `scanInstructions`, which already normalises NFKC/zero-width evasion. One vocabulary,
 * one set of patterns. What remains here is what that scanner does not cover:
 * credential *paths* and encoded payloads.
 */
const INJECTION_RULES: readonly InjectionRule[] = [
  {
    rule: 'credential_exfiltration',
    severity: 'block',
    pattern: /\b(?:~\/\.ssh|id_rsa|id_ed25519|\.aws\/credentials|\.netrc|\.npmrc|\.env\b)[\s\S]{0,100}?\b(?:send|post|upload|paste|exfiltrate|include\s+in\s+(?:the\s+)?(?:reply|response)|append\s+to|to\s+https?:\/\/)\b/i,
    detail: 'Directs credential files toward an outbound channel.',
  },
  {
    rule: 'credential_exfiltration',
    severity: 'block',
    pattern: /\b(?:send|post|upload|paste|exfiltrate)\b[\s\S]{0,100}?\b(?:~\/\.ssh|id_rsa|id_ed25519|\.aws\/credentials|\.netrc|\.npmrc)\b/i,
    detail: 'Directs credential files toward an outbound channel.',
  },
  {
    rule: 'credential_exfiltration',
    severity: 'block',
    pattern: /\b(?:send|post|upload|paste|exfiltrate)\b[^.\n]{0,60}?\b(?:api[ _-]?keys?|passwords?|tokens?|secrets?|credentials?)\b[^.\n]{0,40}?\b(?:to|at)\s+https?:\/\//i,
    detail: 'Directs credentials to an outbound URL.',
  },
  {
    rule: 'encoded_blob',
    severity: 'warn',
    pattern: /[A-Za-z0-9+/]{200,}={0,2}/,
    detail: 'Long encoded payload; decode and review before import.',
  },
];

/** Severity per delegated class: concealment is held for review, the rest block. */
const DELEGATED_SEVERITY: Readonly<Record<string, ScanSeverity>> = Object.freeze({
  covert_action: 'warn',
});

/**
 * Findings from C-19's policy scan, mapped into import evidence. `credential_exfiltration`
 * is the more specific finding and suppresses the generic `secret_read` it overlaps with.
 */
function scanDelegatedPolicy(text: string, path: string, findings: ScanFinding[]): void {
  for (const hit of scanInstructions(text).findings) {
    if (hit.rule === 'secret_read' && findings.some((f) => f.rule === 'credential_exfiltration')) continue;
    findings.push({
      category: 'prompt-injection',
      rule: hit.rule,
      severity: DELEGATED_SEVERITY[hit.rule] ?? 'block',
      path,
      line: null,
      excerpt: excerptOf(hit.match),
      detail: hit.label,
    });
  }
}

const INVISIBLE_CHARACTERS: ReadonlyArray<{ readonly rule: string; readonly severity: ScanSeverity; readonly range: readonly [number, number]; readonly detail: string }> = [
  { rule: 'bidi_control', severity: 'block', range: [0x202a, 0x202e], detail: 'Bidirectional override can visually reorder instructions.' },
  { rule: 'bidi_control', severity: 'block', range: [0x2066, 0x2069], detail: 'Bidirectional isolate can visually reorder instructions.' },
  { rule: 'unicode_tag_characters', severity: 'block', range: [0xe0000, 0xe007f], detail: 'Unicode tag characters can smuggle invisible instructions.' },
  { rule: 'zero_width_character', severity: 'warn', range: [0x200b, 0x200d], detail: 'Zero-width character hides text from a reader.' },
  { rule: 'zero_width_character', severity: 'warn', range: [0xfeff, 0xfeff], detail: 'Byte-order mark inside text hides content from a reader.' },
];

function codePointLabel(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

function excerptOf(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}...` : trimmed;
}

export function detectPromptInjection(text: string, path: string): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const lines = text.split('\n');

  scanDelegatedPolicy(text, path, findings);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    for (const rule of INJECTION_RULES) {
      const match = rule.pattern.exec(line);
      if (!match) continue;
      findings.push({
        category: 'prompt-injection',
        rule: rule.rule,
        severity: rule.severity,
        path,
        line: index + 1,
        excerpt: excerptOf(match[0]),
        detail: rule.detail,
      });
    }
  }

  // Invisible characters are found as code points so their line number is exact.
  for (let offset = 0; offset < text.length; offset += 1) {
    const codePoint = text.codePointAt(offset);
    if (codePoint === undefined) break;
    const hit = INVISIBLE_CHARACTERS.find(({ range }) => codePoint >= range[0] && codePoint <= range[1]);
    if (!hit) continue;
    const line = text.slice(0, offset).split('\n').length;
    findings.push({
      category: 'prompt-injection',
      rule: hit.rule,
      severity: hit.severity,
      path,
      line,
      excerpt: codePointLabel(codePoint),
      detail: hit.detail,
    });
    if (codePoint > 0xffff) offset += 1;
  }

  return findings;
}

export type SourceQuarantineCode = 'source_quarantined' | 'source_needs_review';

/**
 * The hard import gate. Thrown when content is not clean; the message names the rules
 * that blocked it so the operator can review evidence instead of guessing.
 */
export class SourceQuarantineError extends Error {
  readonly code: SourceQuarantineCode;
  readonly blockers: readonly string[];

  constructor(assessment: QuarantineAssessment) {
    const review = assessment.decision === 'needs-review';
    const rules = assessment.blockers.join(', ');
    super(review
      ? `Source requires review before import (${rules}).`
      : `Source is quarantined and cannot be imported (${rules}).`);
    this.name = 'SourceQuarantineError';
    this.code = review ? 'source_needs_review' : 'source_quarantined';
    this.blockers = assessment.blockers;
  }
}

export function assertImportAllowed(assessment: QuarantineAssessment): void {
  if (!assessment.importAllowed) throw new SourceQuarantineError(assessment);
}

const EXECUTABLE_EXTENSIONS = new Set([
  '.sh', '.bash', '.zsh', '.ksh', '.fish', '.ps1', '.bat', '.cmd',
  '.py', '.js', '.mjs', '.cjs', '.ts', '.rb', '.pl', '.php', '.lua',
]);

interface ExecutableRule {
  readonly rule: string;
  readonly severity: ScanSeverity;
  readonly pattern: RegExp;
  readonly detail: string;
}

/** Commands that turn an imported script into remote control of the host. */
const EXECUTABLE_RULES: readonly ExecutableRule[] = [
  { rule: 'remote_pipe_to_shell', severity: 'block', pattern: /\b(?:curl|wget)\b[^\n|]{0,200}\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/i, detail: 'Pipes a remote download straight into a shell.' },
  { rule: 'remote_pipe_to_shell', severity: 'block', pattern: /\b(?:curl|wget)\b[^\n|]{0,200}\|\s*(?:python[0-9.]*|node|perl|ruby)\b/i, detail: 'Pipes a remote download straight into an interpreter.' },
  { rule: 'destructive_command', severity: 'block', pattern: /\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*\s+\/(?:\s|$|[;&|])/, detail: 'Recursive deletion rooted at filesystem root.' },
  { rule: 'destructive_command', severity: 'block', pattern: /\b(?:mkfs(?:\.\w+)?\s+\/dev\/|dd\s+[^\n]*of=\/dev\/(?:sd|nvme|hd))/, detail: 'Writes directly over a block device.' },
  { rule: 'reverse_shell', severity: 'block', pattern: /\bnc\s+-[a-zA-Z]*e\s|\/dev\/tcp\/|\bncat\b[^\n]*--exec\b/i, detail: 'Opens an interactive reverse shell.' },
  { rule: 'encoded_powershell', severity: 'block', pattern: /powershell(?:\.exe)?\s+[^\n]*-(?:enc|encodedcommand)\b/i, detail: 'Runs an encoded PowerShell payload.' },
  { rule: 'obfuscated_execution', severity: 'block', pattern: /\beval\s*\(\s*(?:Buffer\.from|atob|base64)|eval\s*\(\s*\$\(\s*(?:echo|printf)[^\n]*base64/i, detail: 'Executes a base64-decoded payload.' },
  { rule: 'shell_execution', severity: 'warn', pattern: /\bos\.system\s*\(|subprocess\.(?:run|call|Popen|check_output)\([^)\n]*shell\s*=\s*True|child_process\.(?:exec|execSync)\s*\(/i, detail: 'Shells out to the host; review the command source.' },
  { rule: 'world_writable', severity: 'warn', pattern: /\bchmod\s+(?:-R\s+)?777\b/, detail: 'Makes files world-writable.' },
];

function isExecutablePath(path: string): boolean {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot === -1) return false;
  return EXECUTABLE_EXTENSIONS.has(lower.slice(dot));
}

export function analyzeExecutableScript(text: string, path: string): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    for (const rule of EXECUTABLE_RULES) {
      const match = rule.pattern.exec(line);
      if (!match) continue;
      findings.push({
        category: 'executable',
        rule: rule.rule,
        severity: rule.severity,
        path,
        line: index + 1,
        excerpt: excerptOf(match[0]),
        detail: rule.detail,
      });
    }
  }
  return findings;
}

const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall'] as const;

/** Package install hooks execute code at `npm install` time; report them, never run them. */
export function analyzePackageManifest(text: string, path: string): ScanFinding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [{
      category: 'executable',
      rule: 'manifest_unparseable',
      severity: 'warn',
      path,
      line: null,
      excerpt: 'invalid JSON',
      detail: 'package.json could not be parsed, so its install hooks are unknown.',
    }];
  }
  const scripts = (parsed as { scripts?: Record<string, unknown> } | null)?.scripts;
  if (!scripts || typeof scripts !== 'object') return [];
  const findings: ScanFinding[] = [];
  for (const hook of INSTALL_HOOKS) {
    const command = scripts[hook];
    if (typeof command !== 'string' || command.length === 0) continue;
    findings.push({
      category: 'executable',
      rule: 'install_hook',
      severity: 'warn',
      path,
      line: null,
      excerpt: excerptOf(command),
      detail: `Runs code at install time via the ${hook} script.`,
    });
  }
  return findings;
}

function looksBinary(bytes: Uint8Array): boolean {
  const probe = bytes.subarray(0, 8_192);
  return probe.includes(0);
}

import { createHash } from 'node:crypto';

/**
 * SHA-256 over the canonical assessment (decision, blockers, counts, findings). A reviewer
 * cites this digest as the evidence for an import decision; two scans of one bundle produce
 * the same digest, and any changed finding produces a different one.
 */
export function assessmentDigest(assessment: QuarantineAssessment): string {
  const canonical = JSON.stringify({
    decision: assessment.decision,
    importAllowed: assessment.importAllowed,
    blockers: assessment.blockers,
    counts: assessment.counts,
    findings: assessment.findings,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function decisionFor(findings: readonly ScanFinding[]): QuarantineDecision {
  if (findings.some((finding) => finding.severity === 'block')) return 'quarantined';
  if (findings.some((finding) => finding.severity === 'warn')) return 'needs-review';
  return 'clean';
}

function compareFindings(a: ScanFinding, b: ScanFinding): number {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  const lineA = a.line ?? 0;
  const lineB = b.line ?? 0;
  if (lineA !== lineB) return lineA - lineB;
  return a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0;
}

export function assessSourceBundle(
  files: readonly SourceFileInput[],
  limits: { readonly fileBytes?: number; readonly totalBytes?: number } = {},
): QuarantineAssessment {
  const fileBytes = limits.fileBytes ?? SCAN_LIMITS.fileBytes;
  const totalBytes = limits.totalBytes ?? SCAN_LIMITS.totalBytes;
  const findings: ScanFinding[] = [];
  let bytes = 0;
  let skipped = 0;

  let executableFiles = 0;

  for (const file of files) {
    const raw = typeof file.content === 'string' ? Buffer.from(file.content, 'utf8') : Buffer.from(file.content);
    const size = file.declaredSize ?? raw.byteLength;
    bytes += size;
    if (size > fileBytes || bytes > totalBytes) {
      skipped += 1;
      findings.push({
        category: 'unscannable',
        rule: 'file_too_large',
        severity: 'warn',
        path: file.path,
        line: null,
        excerpt: `${size} bytes`,
        detail: 'File exceeds the scan budget and was not inspected; import is held for review.',
      });
      continue;
    }
    if (looksBinary(raw)) {
      skipped += 1;
      findings.push({
        category: 'unscannable',
        rule: 'unscannable_binary',
        severity: 'warn',
        path: file.path,
        line: null,
        excerpt: `${size} bytes`,
        detail: 'Binary content cannot be reviewed as text; import is held for review.',
      });
      continue;
    }
    const text = raw.toString('utf8');
    findings.push(...scanForSecrets(text, file.path));
    findings.push(...detectPromptInjection(text, file.path));
    const executable = isExecutablePath(file.path) || (file.path.endsWith('.json') ? false : text.startsWith('#!'));
    if (executable) {
      executableFiles += 1;
      findings.push(...analyzeExecutableScript(text, file.path));
    }
    if (file.path === 'package.json' || file.path.endsWith('/package.json')) {
      findings.push(...analyzePackageManifest(text, file.path));
    }
  }

  findings.sort(compareFindings);
  const decision = decisionFor(findings);
  const blockers = [...new Set(findings.filter((finding) => finding.severity !== 'info').map((finding) => finding.rule))].sort();
  return {
    decision,
    importAllowed: decision === 'clean',
    findings,
    blockers,
    counts: {
      files: files.length,
      bytes,
      findings: findings.length,
      skipped,
      executableFiles,
      bySeverity: {
        block: findings.filter((finding) => finding.severity === 'block').length,
        warn: findings.filter((finding) => finding.severity === 'warn').length,
        info: findings.filter((finding) => finding.severity === 'info').length,
      },
    },
  };
}

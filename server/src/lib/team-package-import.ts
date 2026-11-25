/**
 * MAUS-E-03: isolated parsing with size, YAML alias, depth, CPU and path traversal limits —
 * for importing a portable team package (Markdown/YAML) without letting the file itself
 * become an attack: a billion-laughs alias bomb, unbounded recursion, or a path that writes
 * outside the import sandbox.
 *
 * This does not use js-yaml's own loader on untrusted input (its alias/anchor expansion is
 * exactly the billion-laughs vector) — it walks a minimal, safe YAML/front-matter subset by
 * hand and refuses anything it doesn't recognize, which is the only way to bound the limits
 * below deterministically.
 */
export class TeamPackageParseError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface ParseLimits {
  maxBytes: number;
  maxDepth: number;
  maxAliasExpansions: number;
  maxParseMs: number;
}

export const DEFAULT_LIMITS: ParseLimits = {
  maxBytes: 256 * 1024, // 256KB — a team package is text, not a dataset
  maxDepth: 12,
  maxAliasExpansions: 0, // YAML aliases (&anchor / *ref) are refused outright, not bounded
  maxParseMs: 500,
};

/** Rejects a path that would escape the import sandbox: absolute, `..`, or a drive letter. */
export function rejectPathTraversal(p: string): void {
  if (!p || typeof p !== 'string') throw new TeamPackageParseError('path_invalid', 'empty or non-string path');
  if (p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p)) throw new TeamPackageParseError('path_absolute', `absolute path not allowed: ${p}`);
  const parts = p.split(/[\\/]/);
  if (parts.includes('..')) throw new TeamPackageParseError('path_traversal', `path escapes sandbox: ${p}`);
  if (parts.some((seg) => seg.includes('\0'))) throw new TeamPackageParseError('path_nul', 'null byte in path');
}

type YamlValue = string | number | boolean | null | YamlValue[] | { [k: string]: YamlValue };

/**
 * A deliberately minimal YAML subset parser: maps, lists, scalars, nested indentation.
 * No anchors (&x), no aliases (*x), no tags (!!type), no merge keys (<<), no multi-document
 * streams. Any of those throw immediately — this is a safety boundary, not a compatibility
 * layer, and an upstream package using real YAML features should be rejected, not guessed at.
 */
export function parseSafeYaml(text: string, limits: ParseLimits = DEFAULT_LIMITS): YamlValue {
  const started = Date.now();
  if (Buffer.byteLength(text, 'utf8') > limits.maxBytes) {
    throw new TeamPackageParseError('size_exceeded', `input exceeds ${limits.maxBytes} bytes`);
  }
  if (/[&*]\s*\w|<<\s*:|!!\w/.test(text)) {
    throw new TeamPackageParseError('yaml_feature_refused', 'anchors, aliases, merge keys and tags are not supported — refused, not approximated');
  }
  const lines = text.split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));

  function checkTime() {
    if (Date.now() - started > limits.maxParseMs) throw new TeamPackageParseError('parse_timeout', `parse exceeded ${limits.maxParseMs}ms`);
  }

  function indentOf(line: string) {
    const m = line.match(/^ */);
    return m ? m[0].length : 0;
  }

  function parseBlock(startIdx: number, indent: number, depth: number): { value: YamlValue; next: number } {
    checkTime();
    if (depth > limits.maxDepth) throw new TeamPackageParseError('depth_exceeded', `nesting exceeds ${limits.maxDepth} levels`);
    if (startIdx >= lines.length) return { value: null, next: startIdx };

    const first = lines[startIdx];
    const firstIndent = indentOf(first);
    if (firstIndent < indent) return { value: null, next: startIdx };

    const isList = first.trim().startsWith('- ');
    if (isList) {
      const items: YamlValue[] = [];
      let i = startIdx;
      while (i < lines.length && indentOf(lines[i]) === firstIndent && lines[i].trim().startsWith('- ')) {
        checkTime();
        const rest = lines[i].trim().slice(2);
        const itemIndent = firstIndent + 2;
        const colonIdx = rest.indexOf(':');
        if (colonIdx > -1) {
          const obj: Record<string, YamlValue> = {};
          const key = rest.slice(0, colonIdx).trim();
          const val = rest.slice(colonIdx + 1).trim();
          if (val) { obj[key] = scalar(val); i += 1; } else {
            const nested = parseBlock(i + 1, itemIndent + 2, depth + 1);
            obj[key] = nested.value;
            i = nested.next;
          }
          // Continuation lines: more keys of this same list item's map, at itemIndent.
          while (i < lines.length && indentOf(lines[i]) === itemIndent && !lines[i].trim().startsWith('- ')) {
            checkTime();
            const line2 = lines[i];
            const c2 = line2.indexOf(':');
            if (c2 === -1) throw new TeamPackageParseError('yaml_syntax', `expected "key: value" at: ${line2}`);
            const key2 = line2.slice(itemIndent, c2).trim();
            const val2 = line2.slice(c2 + 1).trim();
            if (val2) { obj[key2] = scalar(val2); i += 1; } else {
              const nested2 = parseBlock(i + 1, itemIndent + 2, depth + 1);
              obj[key2] = nested2.value;
              i = nested2.next;
            }
          }
          items.push(obj);
        } else {
          items.push(scalar(rest));
          i += 1;
        }
      }
      return { value: items, next: i };
    }

    const obj: Record<string, YamlValue> = {};
    let i = startIdx;
    while (i < lines.length && indentOf(lines[i]) === firstIndent) {
      checkTime();
      const line = lines[i];
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) throw new TeamPackageParseError('yaml_syntax', `expected "key: value" at: ${line}`);
      const key = line.slice(indentOf(line), colonIdx).trim();
      const rest = line.slice(colonIdx + 1).trim();
      if (rest === '') {
        const nested = parseBlock(i + 1, firstIndent + 2, depth + 1);
        obj[key] = nested.value;
        i = Math.max(nested.next, i + 1);
      } else {
        obj[key] = scalar(rest);
        i += 1;
      }
    }
    return { value: obj, next: i };
  }

  function scalar(s: string): YamlValue {
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (s === 'null' || s === '~') return null;
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    return s.replace(/^["']|["']$/g, '');
  }

  const result = parseBlock(0, 0, 0);
  return result.value;
}

/** Full team-package import check: safe-parse the manifest, then validate every referenced
 *  file path stays inside the sandbox before anything is written to disk. */
export function validateTeamPackage(manifestYaml: string, filePaths: string[], limits: ParseLimits = DEFAULT_LIMITS): { manifest: YamlValue; safePaths: string[] } {
  const manifest = parseSafeYaml(manifestYaml, limits);
  const safePaths: string[] = [];
  for (const p of filePaths) {
    rejectPathTraversal(p);
    safePaths.push(p);
  }
  return { manifest, safePaths };
}

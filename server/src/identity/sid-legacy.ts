/**
 * sid/0.1 — legacy verifier for the historical agent birth certificate.
 *
 * Ported unchanged in behaviour from `cryptonomicsed-byte/sid` @ 756d8d8
 * (implementations/typescript/src/{canonical,sid}.ts, MIT, copyright 2026
 * card-protocol contributors). Only verification is ported: emitting SID.md and
 * signing the Nostr birth event stay in that repository.
 *
 * Why it lives here: a neutral `sid/0.2` identity may only inherit a legacy
 * record whose historical bytes still verify (V6-04-01/V6-04-02). The verdicts
 * are pinned by the vendored conformance vectors in tests/fixtures/sid-0.1; if
 * this file drifts from them, historical identities silently stop verifying.
 */
import { createHash } from 'node:crypto';

export const SID_LEGACY_FORMAT = 'sid/0.1';

/** Keys an agent may ACT on; a re-anchor never forces a reload. */
export const SID_LEGACY_ACTING_KEYS = ['identity', 'capabilities', 'memory', 'lifecycle', 'status'] as const;

export const SID_LEGACY_STATUSES = ['cast', 'live', 'suspended', 'retired'] as const;

const HEX64 = /^[0-9a-f]{64}$/;
const ID_RE = /^sid_[a-z0-9][a-z0-9-]*$/;
const SECRET_KEYS = ['seed', 'mnemonic', 'private_key', 'nsec', 'secret'] as const;

/**
 * Canonical JSON with the sid/0.1 contract: sorted keys, Python
 * `ensure_ascii` escaping, non-finite numbers refused, and empty arrays/objects
 * pruned from values (\"skills\": [] is identical to no skills).
 */
export function canonicalSidJson(value: unknown): string {
  return canonValue(prune(value));
}

function canonValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonValue).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(key => `${canonStr(key)}:${canonValue(record[key])}`)
      .join(',')}}`;
  }
  if (typeof value === 'string') return canonStr(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number in certificate');
    return JSON.stringify(value);
  }
  return JSON.stringify(value);
}

function prune(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(prune);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const pruned = prune((value as Record<string, unknown>)[key]);
      if (Array.isArray(pruned) && pruned.length === 0) continue;
      if (pruned !== null && typeof pruned === 'object' && Object.keys(pruned).length === 0) continue;
      out[key] = pruned;
    }
    return out;
  }
  return value;
}

function canonStr(value: string): string {
  const inner = JSON.stringify(value).slice(1, -1);
  let out = '';
  for (const character of inner) {
    const codePoint = character.codePointAt(0) as number;
    if (codePoint < 128) out += character;
    else if (codePoint < 65536) out += `\\u${codePoint.toString(16).padStart(4, '0')}`;
    else {
      const offset = codePoint - 65536;
      const high = 55296 + (offset >> 10);
      const low = 56320 + (offset & 1023);
      out += `\\u${high.toString(16).padStart(4, '0')}\\u${low.toString(16).padStart(4, '0')}`;
    }
  }
  return `"${out}"`;
}

/** SHA-256 hex of the canonical body, excluding `hash` and `_`-prefixed fields. */
export function canonicalSidHash(document: unknown): string {
  const body: Record<string, unknown> = {};
  for (const key of Object.keys(document as Record<string, unknown>)) {
    if (key !== 'hash' && key.charAt(0) !== '_') body[key] = (document as Record<string, unknown>)[key];
  }
  return createHash('sha256').update(canonicalSidJson(body), 'utf8').digest('hex');
}

/** SHA-256 hex over the acting keys only. */
export function actingHashLegacy(certificate: Record<string, unknown>): string {
  const body: Record<string, unknown> = {};
  for (const key of SID_LEGACY_ACTING_KEYS) {
    if (certificate[key] !== undefined) body[key] = certificate[key];
  }
  return createHash('sha256').update(canonicalSidJson(body), 'utf8').digest('hex');
}

/** SHA-256 hex over the full canonical body (minus `hash` and `_`-prefixed keys). */
export function sidHashLegacy(certificate: Record<string, unknown>): string {
  return canonicalSidHash(certificate);
}

/**
 * Verify one legacy certificate. Returns every problem found, not the first.
 * For v>1 the caller supplies the previous version to check the chain link.
 */
export function verifySidLegacy(
  certificate: unknown,
  previous?: Record<string, unknown>,
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const add = (message: string) => errors.push(message);
  if (!certificate || typeof certificate !== 'object') return { ok: false, errors: ['not an object'] };
  const cert = certificate as Record<string, any>;

  if (cert.format !== SID_LEGACY_FORMAT) add(`format must be ${SID_LEGACY_FORMAT}`);
  if (typeof cert.id !== 'string' || !ID_RE.test(cert.id)) add('id must match sid_<slug>');
  if (!Number.isInteger(cert.version) || cert.version < 1) add('version must be an integer >= 1');
  if (!(SID_LEGACY_STATUSES as readonly string[]).includes(cert.status)) add('status must be cast|live|suspended|retired');
  if (typeof cert.born_at !== 'string' || !cert.born_at) add('born_at is required');

  const identity = cert.identity;
  if (!identity || typeof identity !== 'object') {
    add('identity is required');
  } else {
    if (identity.type !== 'agent') add('identity.type must be "agent"');
    if (!Number.isInteger(identity.odu_primary) || identity.odu_primary < 0 || identity.odu_primary > 255)
      add('identity.odu_primary must be 0-255');
    if (!Number.isInteger(identity.odu_secondary) || identity.odu_secondary < 0 || identity.odu_secondary > 255)
      add('identity.odu_secondary must be 0-255');
    if (Number.isInteger(identity.odu_primary) && Number.isInteger(identity.odu_secondary)) {
      const expected = (identity.odu_primary << 8) | identity.odu_secondary;
      if (identity.odu_link !== expected)
        add(`identity.odu_link ${identity.odu_link} != (odu_primary<<8|odu_secondary) ${expected}`);
    }
    const calabash = identity.calabash;
    if (calabash !== undefined) {
      if (!calabash || typeof calabash !== 'object') {
        add('identity.calabash must be an object');
      } else {
        if (!Number.isInteger(calabash.id) || !Number.isInteger(calabash.top) || !Number.isInteger(calabash.bottom)) {
          add('identity.calabash id/top/bottom must be integers');
        } else if (calabash.id !== identity.odu_link || calabash.top !== identity.odu_primary || calabash.bottom !== identity.odu_secondary) {
          add(
            `identity.calabash ${calabash.id}/${calabash.top}/${calabash.bottom} disagrees with the Odu fields ` +
              `${identity.odu_link}/${identity.odu_primary}/${identity.odu_secondary}`,
          );
        }
        if (typeof calabash.vessel !== 'string' || !calabash.vessel)
          add('identity.calabash.vessel must name one of the 16 Action Vessels');
      }
    }
  }

  if (!HEX64.test(String(cert.hash || ''))) add('hash must be 64-hex');
  else if (sidHashLegacy(cert) !== cert.hash) add('hash does not match the canonical body');
  if (!HEX64.test(String(cert.acting_hash || ''))) add('acting_hash must be 64-hex');
  else if (actingHashLegacy(cert) !== cert.acting_hash) add('acting_hash does not match the acting keys');

  if (cert.version === 1) {
    if (cert.previous_version !== null) add('v1 must have previous_version = null');
    if (cert.previous_hash !== 'none' && cert.previous_hash !== null) add('v1 must have previous_hash = "none"');
  } else {
    if (cert.previous_version !== cert.version - 1) add('previous_version must be version - 1');
    if (!HEX64.test(String(cert.previous_hash || ''))) add('previous_hash must be 64-hex for v>1');
  }

  if (previous) {
    if (cert.previous_hash !== previous.hash) add('previous_hash does not match the hash of the supplied previous version');
    if (cert.version !== (previous.version as number) + 1) add('version is not previous.version + 1');
  }

  if (cert.lifecycle && cert.lifecycle.state !== undefined && cert.lifecycle.state !== cert.status)
    add('lifecycle.state must equal status');

  const time = cert.time;
  if (time) {
    if (time.anchored === true && !time.ots_proof) add('time.anchored = true requires time.ots_proof');
    // A fresh OTS stamp is a commitment to a calendar server, not a Bitcoin
    // attestation. Claiming anchored on it is an overclaim.
    if (time.anchored === true && time.ots_status !== 'complete')
      add('time.anchored = true requires time.ots_status = "complete"');
    if (time.anchored === true && time.clock_source !== 'okf')
      add('time.anchored = true requires time.clock_source = "okf"');
    if (time.calendar !== undefined) {
      if (!time.calendar || typeof time.calendar !== 'object') {
        add('time.calendar must be an object');
      } else {
        for (const key of ['epoch', 'cycle', 'phase']) {
          const value = time.calendar[key];
          if (!Number.isInteger(value) || value < 0) add(`time.calendar.${key} must be a non-negative integer`);
        }
      }
    }
  }

  for (const forbidden of SECRET_KEYS) {
    if (cert.genesis && cert.genesis[forbidden] !== undefined) add(`genesis must not carry ${forbidden}`);
    if (cert.identity && cert.identity[forbidden] !== undefined) add(`identity must not carry ${forbidden}`);
  }

  return { ok: errors.length === 0, errors };
}

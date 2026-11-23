/**
 * SID identity service (V6-04-03/04/06).
 *
 * The database owns issuance: `uap.issue_sid_instance` refuses cross-tenant SIDs,
 * duplicate SIDs, duplicate installations and moved role template digests, and
 * derives the identity hash from the stored document. This module only validates
 * the shape of the call, names the failures for callers, and reads back the row.
 *
 * A SID is issued per activated specialist instance. There is deliberately no
 * "issue one identity for this repo/prompt/job" path, and no argument that lets a
 * caller supply an identity hash.
 */
import type { PoolClient } from 'pg';

export type SidRuntime = 'hermes' | 'elixir-worker' | 'rust-executor';

export interface SidRoleTemplate {
  id: string;
  version: number;
  digest: string;
}

export interface SidIssuanceInput {
  sid: string;
  displayName: string;
  roleTemplate: SidRoleTemplate;
  installation: { id: string; ref: string; runtime: SidRuntime };
  model: { id: string; provider: string; model: string; epoch?: number };
  identityDocument: Record<string, unknown>;
  lineageParentId?: string | null;
}

export interface SidIssuance {
  sid: string;
  installationId: string;
  modelSelectionId: string;
  identityHash: string;
  lineageVersion: number;
}

export interface SidIdentity {
  sid: string;
  organizationId: string;
  displayName: string;
  status: 'active' | 'paused' | 'revoked' | 'archived';
  lineageParentId: string | null;
  lineageVersion: number;
  roleTemplateId: string;
  roleTemplateVersion: number;
  identityHash: string;
  modelSelectionId: string;
  identityDocument: Record<string, unknown>;
}

export type SidIssuanceFailure =
  | 'tenant_forbidden'
  | 'sid_foreign_tenant'
  | 'sid_already_issued'
  | 'installation_exists'
  | 'role_digest_mismatch'
  | 'lineage_parent_missing'
  | 'sid_missing'
  | 'sid_not_active'
  | 'input_invalid'
  | 'unknown';

export class SidIssuanceError extends Error {
  readonly code: SidIssuanceFailure;

  constructor(code: SidIssuanceFailure, message: string) {
    super(message);
    this.name = 'SidIssuanceError';
    this.code = code;
  }
}

/** Stable SID grammar: `sid_` plus a lowercase slug. Underscores are legal
 *  inside the slug (the blueprint's canonical example is `sid_example_immutable`). */
const SID_RE = /^sid_[a-z0-9][a-z0-9_-]{0,62}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const RUNTIMES: readonly SidRuntime[] = ['hermes', 'elixir-worker', 'rust-executor'];

function requireText(value: unknown, field: string, max = 200): string {
  if (typeof value !== 'string' || !value || value.length > max) {
    throw new SidIssuanceError('input_invalid', `${field} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function validate(input: SidIssuanceInput): void {
  if (!SID_RE.test(input.sid ?? '')) throw new SidIssuanceError('input_invalid', 'sid must match sid_<slug>');
  requireText(input.displayName, 'displayName');
  if (!input.roleTemplate || typeof input.roleTemplate !== 'object') throw new SidIssuanceError('input_invalid', 'roleTemplate is required');
  requireText(input.roleTemplate.id, 'roleTemplate.id');
  if (!Number.isInteger(input.roleTemplate.version) || input.roleTemplate.version < 1) {
    throw new SidIssuanceError('input_invalid', 'roleTemplate.version must be a positive integer');
  }
  if (!DIGEST_RE.test(input.roleTemplate.digest ?? '')) {
    throw new SidIssuanceError('input_invalid', 'roleTemplate.digest must be a 64-hex sha256');
  }
  if (!input.installation || typeof input.installation !== 'object') throw new SidIssuanceError('input_invalid', 'installation is required');
  requireText(input.installation.id, 'installation.id');
  requireText(input.installation.ref, 'installation.ref');
  if (!RUNTIMES.includes(input.installation.runtime)) {
    throw new SidIssuanceError('input_invalid', `installation.runtime must be one of ${RUNTIMES.join(', ')}`);
  }
  if (!input.model || typeof input.model !== 'object') throw new SidIssuanceError('input_invalid', 'model is required');
  requireText(input.model.id, 'model.id');
  requireText(input.model.provider, 'model.provider', 100);
  requireText(input.model.model, 'model.model');
  if (!input.identityDocument || typeof input.identityDocument !== 'object' || Array.isArray(input.identityDocument)) {
    throw new SidIssuanceError('input_invalid', 'identityDocument must be an object');
  }
  if (input.identityDocument.format !== 'uap-sid/0.2') {
    throw new SidIssuanceError('input_invalid', 'identityDocument.format must be uap-sid/0.2');
  }
  if (input.lineageParentId !== undefined && input.lineageParentId !== null) {
    if (!SID_RE.test(input.lineageParentId)) throw new SidIssuanceError('input_invalid', 'lineageParentId must match sid_<slug>');
    if (input.lineageParentId === input.sid) throw new SidIssuanceError('input_invalid', 'a SID cannot be its own lineage parent');
  }
}

const FAILURES: readonly SidIssuanceFailure[] = [
  'tenant_forbidden', 'sid_foreign_tenant', 'sid_already_issued', 'installation_exists',
  'role_digest_mismatch', 'lineage_parent_missing', 'sid_missing', 'sid_not_active', 'input_invalid',
];

/** Names a database refusal. The function raises stable message tokens; an
 *  unrecognised error is rethrown rather than flattened into a generic failure. */
function translate(error: unknown): never {
  if (error instanceof SidIssuanceError) throw error;
  const code = (error as { code?: string } | null)?.code;
  const message = String((error as { message?: string } | null)?.message ?? '');
  const named = FAILURES.find(failure => message.includes(failure));
  if (named) throw new SidIssuanceError(named, message);
  if (code === '42501') throw new SidIssuanceError('tenant_forbidden', 'issuance is not permitted for this tenant');
  if (code === 'P0003') throw new SidIssuanceError('input_invalid', 'issuance input is invalid');
  throw error;
}

export async function issueSidInstance(
  client: PoolClient,
  scope: { organizationId: string },
  input: SidIssuanceInput,
): Promise<SidIssuance> {
  validate(input);
  try {
    const result = await client.query<{
      sid: string; installation_id: string; model_selection_id: string; identity_hash: string; lineage_version: number;
    }>(
      `SELECT * FROM uap.issue_sid_instance($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)`,
      [
        scope.organizationId, input.sid, input.displayName,
        input.roleTemplate.id, input.roleTemplate.version, input.roleTemplate.digest,
        input.installation.id, input.installation.ref, input.installation.runtime,
        input.model.id, input.model.provider, input.model.model,
        input.identityDocument, input.lineageParentId ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new SidIssuanceError('unknown', 'issuance returned no row');
    return {
      sid: row.sid,
      installationId: row.installation_id,
      modelSelectionId: row.model_selection_id,
      identityHash: row.identity_hash,
      lineageVersion: row.lineage_version,
    };
  } catch (error) {
    translate(error);
  }
}

/** Records the next Hermes model selection for a SID. The SID, its role template
 *  version and its identity hash are untouched by a provider switch. */
export async function recordSidModelSelection(
  client: PoolClient,
  scope: { organizationId: string },
  input: { sid: string; modelSelectionId: string; provider: string; model: string },
): Promise<{ modelSelectionId: string; epoch: number }> {
  try {
    const result = await client.query<{ model_selection_id: string; epoch: number }>(
      'SELECT * FROM uap.record_sid_model_selection($1,$2,$3,$4,$5)',
      [scope.organizationId, input.sid, input.modelSelectionId, input.provider, input.model],
    );
    const row = result.rows[0];
    if (!row) throw new SidIssuanceError('unknown', 'model selection returned no row');
    return { modelSelectionId: row.model_selection_id, epoch: row.epoch };
  } catch (error) {
    translate(error);
  }
}

/** Reads one SID for the caller's tenant. Row-level security already hides other
 *  tenants; an explicit organization filter keeps the intent readable. */
export async function readSidInstance(client: PoolClient, sid: string): Promise<SidIdentity | null> {
  const result = await client.query<{
    sid: string; organization_id: string; display_name: string; status: SidIdentity['status'];
    lineage_parent_id: string | null; lineage_version: number; role_template_id: string;
    role_template_version: number; identity_hash: string; model_selection_id: string;
    identity_document: Record<string, unknown>;
  }>(
    `SELECT sid, organization_id, display_name, status, lineage_parent_id, lineage_version,
       role_template_id, role_template_version, identity_hash, model_selection_id, identity_document
     FROM uap.sid_identities WHERE sid=$1`, [sid]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    sid: row.sid,
    organizationId: row.organization_id,
    displayName: row.display_name,
    status: row.status,
    lineageParentId: row.lineage_parent_id,
    lineageVersion: row.lineage_version,
    roleTemplateId: row.role_template_id,
    roleTemplateVersion: row.role_template_version,
    identityHash: row.identity_hash,
    modelSelectionId: row.model_selection_id,
    identityDocument: row.identity_document,
  };
}

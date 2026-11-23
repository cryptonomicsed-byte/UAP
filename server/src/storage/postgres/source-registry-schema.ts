import type { PostgresMigration } from './schema.js';

/**
 * B-20 / V6-02-01..06: source registry and ingestion-run ledger.
 *
 * The catalog holds public source metadata only: supplied URL, canonical
 * identity, observed access, pinned commit, SHA-256 manifest digest, declared
 * licence and classification. It deliberately has no instructions, tool grants
 * or role-template columns — a source is not a role, and V6-02-11 forbids
 * synthesizing one before an independent audit.
 *
 * `trust_status` defaults to USER_SUPPLIED_UNVERIFIED. The CHECK constraint
 * makes every promotion carry a reviewer signature, so B-22 cannot promote a
 * source in SQL without the proof it is supposed to require. Ingestion runs are
 * append-only evidence of what was observed and when.
 */
export const SOURCE_REGISTRY_MIGRATION: PostgresMigration = {
  id: 12,
  name: 'source_registry_and_ingest_runs',
  sql: `
CREATE TABLE uap.source_repositories (
  source_id text PRIMARY KEY CHECK (source_id ~ '^src_[a-f0-9]{16}$'),
  provider text NOT NULL CHECK (provider IN ('github','unknown')),
  canonical_url text NOT NULL UNIQUE CHECK (canonical_url ~ '^https://github\\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$'),
  original_url text NOT NULL CHECK (length(original_url) BETWEEN 8 AND 500),
  canonical_slug text NOT NULL CHECK (canonical_slug ~ '^[a-z0-9][a-z0-9._-]{0,99}/[a-z0-9][a-z0-9._-]{0,99}$'),
  owner text NOT NULL CHECK (owner = lower(owner) AND owner ~ '^[a-z0-9][a-z0-9-]{0,38}$'),
  repo_name text NOT NULL CHECK (repo_name = lower(repo_name) AND length(repo_name) BETWEEN 1 AND 100),
  owner_display text NOT NULL CHECK (length(owner_display) BETWEEN 1 AND 100),
  repo_display text NOT NULL CHECK (length(repo_display) BETWEEN 1 AND 100),
  group_label text NOT NULL CHECK (length(group_label) BETWEEN 1 AND 200),
  proposed_use text NOT NULL CHECK (length(proposed_use) BETWEEN 1 AND 500),
  user_supplied_status text NOT NULL CHECK (length(user_supplied_status) BETWEEN 1 AND 200),
  kind text NOT NULL DEFAULT 'unknown' CHECK (kind IN ('meta-list','agent-skill','dataset','standalone-software','documentation','unknown')),
  kind_confidence text NOT NULL DEFAULT 'low' CHECK (kind_confidence IN ('high','medium','low')),
  kind_evidence jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(kind_evidence) = 'array'),
  access_status text NOT NULL CHECK (access_status IN ('ok','not-found','auth-required','forbidden','rate-limited','moved','network-error')),
  access_detail text NOT NULL CHECK (length(access_detail) BETWEEN 1 AND 200),
  http_status integer CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  archived boolean NOT NULL DEFAULT false,
  redirect_url text CHECK (redirect_url IS NULL OR redirect_url ~ '^https://'),
  default_branch text,
  pinned_commit text CHECK (pinned_commit IS NULL OR pinned_commit ~ '^[a-f0-9]{40}([a-f0-9]{24})?$'),
  pin_kind text CHECK (pin_kind IS NULL OR pin_kind IN ('commit','tag')),
  manifest_digest text CHECK (manifest_digest IS NULL OR manifest_digest ~ '^[a-f0-9]{64}$'),
  manifest_file_count integer CHECK (manifest_file_count IS NULL OR manifest_file_count >= 0),
  manifest_total_bytes bigint CHECK (manifest_total_bytes IS NULL OR manifest_total_bytes >= 0),
  license_spdx text,
  license_source text NOT NULL DEFAULT 'none' CHECK (license_source IN ('license-file','api','none')),
  notices jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(notices) = 'array'),
  commercial_use text NOT NULL DEFAULT 'unknown' CHECK (commercial_use IN ('allowed','restricted','unknown')),
  license_obligations jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(license_obligations) = 'array'),
  license_approval text NOT NULL DEFAULT 'not-reviewed' CHECK (license_approval = 'not-reviewed'),
  risk_class text NOT NULL DEFAULT 'unclassified' CHECK (risk_class IN ('low','medium','high','critical','unclassified')),
  domains text[] NOT NULL DEFAULT '{}',
  supported_tools text[] NOT NULL DEFAULT '{}',
  availability text NOT NULL CHECK (availability IN ('available','unavailable')),
  unavailable_reason text,
  trust_status text NOT NULL DEFAULT 'USER_SUPPLIED_UNVERIFIED' CHECK (trust_status IN (
    'USER_SUPPLIED_UNVERIFIED','PUBLIC_LOCATED','PINNED_SHA','LICENSE_APPROVED','STATIC_AUDITED','SANDBOX_EVALUATED','PUBLISHED')),
  reviewer_signature jsonb CHECK (reviewer_signature IS NULL OR jsonb_typeof(reviewer_signature) = 'object'),
  first_seen_at bigint NOT NULL CHECK (first_seen_at >= 0),
  last_seen_at bigint NOT NULL CHECK (last_seen_at >= first_seen_at),
  last_audited_at bigint CHECK (last_audited_at IS NULL OR last_audited_at >= 0),
  created_at bigint NOT NULL CHECK (created_at >= 0),
  updated_at bigint NOT NULL CHECK (updated_at >= created_at),
  CHECK (trust_status = 'USER_SUPPLIED_UNVERIFIED' OR reviewer_signature IS NOT NULL),
  CHECK (availability = 'available' OR manifest_digest IS NULL)
);
CREATE INDEX source_repositories_slug ON uap.source_repositories(canonical_slug);
CREATE INDEX source_repositories_kind ON uap.source_repositories(kind, trust_status);
CREATE INDEX source_repositories_risk ON uap.source_repositories(risk_class);

CREATE TABLE uap.source_ingest_runs (
  run_id text PRIMARY KEY CHECK (run_id ~ '^ing_[a-f0-9]{32}$'),
  started_at bigint NOT NULL CHECK (started_at >= 0),
  finished_at bigint NOT NULL CHECK (finished_at >= started_at),
  candidate_count integer NOT NULL CHECK (candidate_count >= 0),
  recorded_count integer NOT NULL CHECK (recorded_count >= 0),
  unavailable_count integer NOT NULL CHECK (unavailable_count >= 0),
  duplicate_count integer NOT NULL CHECK (duplicate_count >= 0),
  report jsonb NOT NULL CHECK (jsonb_typeof(report) = 'object' AND octet_length(report::text) <= 1048576),
  created_at bigint NOT NULL CHECK (created_at >= 0)
);

ALTER TABLE uap.source_repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE uap.source_repositories FORCE ROW LEVEL SECURITY;
ALTER TABLE uap.source_ingest_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE uap.source_ingest_runs FORCE ROW LEVEL SECURITY;

-- The catalog is public source metadata, not tenant data: every application
-- session may read it, and the tenant's own policy filter (V6-02-10) narrows
-- what it sees. Writes are controlled by table grants below, not by RLS.
CREATE POLICY source_repositories_reader ON uap.source_repositories FOR SELECT USING (true);
CREATE POLICY source_ingest_runs_reader ON uap.source_ingest_runs FOR SELECT USING (true);
CREATE POLICY source_repositories_writer ON uap.source_repositories FOR INSERT WITH CHECK (true);
CREATE POLICY source_repositories_updater ON uap.source_repositories FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY source_ingest_runs_writer ON uap.source_ingest_runs FOR INSERT WITH CHECK (true);

CREATE FUNCTION uap.source_ingest_runs_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='source_ingest_runs_append_only';
END
$function$;

CREATE TRIGGER source_ingest_runs_no_update BEFORE UPDATE ON uap.source_ingest_runs
  FOR EACH ROW EXECUTE FUNCTION uap.source_ingest_runs_append_only();
CREATE TRIGGER source_ingest_runs_no_delete BEFORE DELETE ON uap.source_ingest_runs
  FOR EACH ROW EXECUTE FUNCTION uap.source_ingest_runs_append_only();
CREATE TRIGGER source_ingest_runs_no_truncate BEFORE TRUNCATE ON uap.source_ingest_runs
  FOR EACH STATEMENT EXECUTE FUNCTION uap.source_ingest_runs_append_only();

REVOKE ALL ON uap.source_repositories,uap.source_ingest_runs FROM PUBLIC;
REVOKE ALL ON FUNCTION uap.source_ingest_runs_append_only() FROM PUBLIC;
`,
};

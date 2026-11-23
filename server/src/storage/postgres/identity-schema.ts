/**
 * Per-instance SID identity records (V6-04-03/04/06).
 *
 * A SID is the persistent principal of one *activated specialist instance* —
 * never of a prompt, a source repo or a short-lived job. The identity, the
 * installation it runs on, the role template version it was hired from and the
 * Hermes model selection it currently uses are separate records joined by id, so
 * a provider switch or a reinstall cannot rewrite who the agent is.
 *
 * Historical `sid/0.1` certificates are never migrated by rewriting them: a new
 * identity may only record `lineage_parent_id`, and the legacy bytes stay
 * verifiable via server/src/identity/sid-legacy.ts.
 */
import type { PostgresMigration } from './schema.js';

export const IDENTITY_MIGRATION: PostgresMigration = {
  id: 9,
  name: 'sid_identity_and_issuance',
  sql: `
CREATE TABLE uap.role_template_versions (
  organization_id text NOT NULL REFERENCES uap.organizations(id) ON DELETE RESTRICT,
  role_template_id text NOT NULL CHECK (length(role_template_id) BETWEEN 1 AND 200),
  version integer NOT NULL CHECK (version > 0),
  source_digest text NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  created_at bigint NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (organization_id, role_template_id, version)
);

CREATE TABLE uap.sid_identities (
  sid text PRIMARY KEY CHECK (sid ~ '^sid_[a-z0-9][a-z0-9_-]{0,62}$'),
  organization_id text NOT NULL REFERENCES uap.organizations(id) ON DELETE RESTRICT,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','revoked','archived')),
  lineage_parent_id text REFERENCES uap.sid_identities(sid) ON DELETE RESTRICT,
  lineage_version integer NOT NULL DEFAULT 1 CHECK (lineage_version > 0),
  role_template_id text NOT NULL,
  role_template_version integer NOT NULL CHECK (role_template_version > 0),
  identity_hash text NOT NULL CHECK (identity_hash ~ '^[a-f0-9]{64}$'),
  identity_document jsonb NOT NULL CHECK (
    jsonb_typeof(identity_document) = 'object' AND octet_length(identity_document::text) <= 262144),
  model_selection_id text,
  created_at bigint NOT NULL CHECK (created_at >= 0),
  updated_at bigint NOT NULL CHECK (updated_at >= created_at),
  FOREIGN KEY (organization_id, role_template_id, role_template_version)
    REFERENCES uap.role_template_versions(organization_id, role_template_id, version) ON DELETE RESTRICT,
  CHECK (lineage_parent_id IS NULL OR lineage_parent_id <> sid),
  UNIQUE (organization_id, sid)
);

CREATE TABLE uap.agent_installations (
  installation_id text PRIMARY KEY CHECK (length(installation_id) BETWEEN 1 AND 200),
  organization_id text NOT NULL,
  sid text NOT NULL,
  installation_ref text NOT NULL CHECK (length(installation_ref) BETWEEN 1 AND 200),
  runtime text NOT NULL CHECK (runtime IN ('hermes','elixir-worker','rust-executor')),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','draining','removed')),
  created_at bigint NOT NULL CHECK (created_at >= 0),
  FOREIGN KEY (organization_id, sid) REFERENCES uap.sid_identities(organization_id, sid) ON DELETE RESTRICT,
  UNIQUE (organization_id, sid, installation_ref)
);

CREATE TABLE uap.hermes_model_selections (
  model_selection_id text PRIMARY KEY CHECK (length(model_selection_id) BETWEEN 1 AND 200),
  organization_id text NOT NULL,
  sid text NOT NULL,
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 100),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
  epoch integer NOT NULL CHECK (epoch > 0),
  created_at bigint NOT NULL CHECK (created_at >= 0),
  FOREIGN KEY (organization_id, sid) REFERENCES uap.sid_identities(organization_id, sid) ON DELETE RESTRICT,
  UNIQUE (organization_id, sid, epoch)
);

ALTER TABLE uap.sid_identities
  ADD CONSTRAINT sid_identities_current_model_selection
  FOREIGN KEY (model_selection_id) REFERENCES uap.hermes_model_selections(model_selection_id) ON DELETE RESTRICT;

ALTER TABLE uap.role_template_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE uap.role_template_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE uap.sid_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE uap.sid_identities FORCE ROW LEVEL SECURITY;
ALTER TABLE uap.agent_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE uap.agent_installations FORCE ROW LEVEL SECURITY;
ALTER TABLE uap.hermes_model_selections ENABLE ROW LEVEL SECURITY;
ALTER TABLE uap.hermes_model_selections FORCE ROW LEVEL SECURITY;

CREATE POLICY role_template_versions_member_read ON uap.role_template_versions FOR SELECT USING (
  uap.has_org_role(organization_id, ARRAY['owner','admin','member','viewer'])
);
CREATE POLICY role_template_versions_writer ON uap.role_template_versions FOR INSERT WITH CHECK (
  uap.has_org_role(organization_id, ARRAY['owner','admin','member'])
);
CREATE POLICY sid_identities_member_read ON uap.sid_identities FOR SELECT USING (
  uap.has_org_role(organization_id, ARRAY['owner','admin','member','viewer'])
);
CREATE POLICY sid_identities_writer ON uap.sid_identities FOR INSERT WITH CHECK (
  uap.has_org_role(organization_id, ARRAY['owner','admin','member'])
);
CREATE POLICY sid_identities_updater ON uap.sid_identities FOR UPDATE USING (
  uap.has_org_role(organization_id, ARRAY['owner','admin','member'])
) WITH CHECK (
  uap.has_org_role(organization_id, ARRAY['owner','admin','member'])
);
CREATE POLICY agent_installations_member_read ON uap.agent_installations FOR SELECT USING (
  uap.has_org_role(organization_id, ARRAY['owner','admin','member','viewer'])
);
CREATE POLICY agent_installations_writer ON uap.agent_installations FOR INSERT WITH CHECK (
  uap.has_org_role(organization_id, ARRAY['owner','admin','member'])
);
CREATE POLICY hermes_model_selections_member_read ON uap.hermes_model_selections FOR SELECT USING (
  uap.has_org_role(organization_id, ARRAY['owner','admin','member','viewer'])
);
CREATE POLICY hermes_model_selections_writer ON uap.hermes_model_selections FOR INSERT WITH CHECK (
  uap.has_org_role(organization_id, ARRAY['owner','admin','member'])
);

-- One SID per activated specialist instance. The identity hash is derived here,
-- from the document as PostgreSQL stores it, so no caller supplies a hash that
-- could disagree with the bytes; the caller only supplies the document.
CREATE FUNCTION uap.issue_sid_instance(
  p_organization_id text,
  p_sid text,
  p_display_name text,
  p_role_template_id text,
  p_role_template_version integer,
  p_role_template_digest text,
  p_installation_id text,
  p_installation_ref text,
  p_runtime text,
  p_model_selection_id text,
  p_model_provider text,
  p_model_name text,
  p_identity_document jsonb,
  p_lineage_parent_id text
)
RETURNS TABLE(
  sid text,
  installation_id text,
  model_selection_id text,
  identity_hash text,
  lineage_version integer
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, uap
SET row_security = on
AS $function$
DECLARE
  actor_id text := nullif(current_setting('uap.actor_id',true),'');
  request_organization text := nullif(current_setting('uap.organization_id',true),'');
  v_now bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  stored_digest text;
  parent uap.sid_identities%ROWTYPE;
  v_lineage integer := 1;
  v_hash text;
BEGIN
  IF request_organization IS DISTINCT FROM p_organization_id
    OR actor_id IS NULL
    OR NOT uap.has_org_role(p_organization_id, ARRAY['owner','admin','member']) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='tenant_forbidden';
  END IF;

  IF p_sid IS NULL OR p_sid !~ '^sid_[a-z0-9][a-z0-9_-]{0,62}$'
    OR p_display_name IS NULL OR length(p_display_name) NOT BETWEEN 1 AND 200
    OR p_role_template_id IS NULL OR length(p_role_template_id) NOT BETWEEN 1 AND 200
    OR p_role_template_version IS NULL OR p_role_template_version < 1
    OR p_role_template_digest IS NULL OR p_role_template_digest !~ '^[a-f0-9]{64}$'
    OR p_installation_id IS NULL OR length(p_installation_id) NOT BETWEEN 1 AND 200
    OR p_installation_ref IS NULL OR length(p_installation_ref) NOT BETWEEN 1 AND 200
    OR p_runtime IS NULL OR p_runtime NOT IN ('hermes','elixir-worker','rust-executor')
    OR p_model_selection_id IS NULL OR length(p_model_selection_id) NOT BETWEEN 1 AND 200
    OR p_model_provider IS NULL OR length(p_model_provider) NOT BETWEEN 1 AND 100
    OR p_model_name IS NULL OR length(p_model_name) NOT BETWEEN 1 AND 200
    OR p_identity_document IS NULL OR jsonb_typeof(p_identity_document) <> 'object'
    OR p_identity_document->>'format' IS DISTINCT FROM 'uap-sid/0.2' THEN
    RAISE EXCEPTION USING ERRCODE='P0003', MESSAGE='sid_input_invalid';
  END IF;

  -- A SID owned by another tenant is never revealed as "taken": the attempt is
  -- refused as unauthorized, and the stored row is not touched.
  IF EXISTS (SELECT 1 FROM uap.sid_identities AS identity
    WHERE identity.sid = p_sid AND identity.organization_id IS DISTINCT FROM p_organization_id) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='sid_foreign_tenant';
  END IF;
  IF EXISTS (SELECT 1 FROM uap.sid_identities AS identity WHERE identity.sid = p_sid) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='sid_already_issued';
  END IF;
  IF EXISTS (SELECT 1 FROM uap.agent_installations AS installation WHERE installation.installation_id = p_installation_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='installation_exists';
  END IF;

  -- A role template version is immutable: the first issuance pins its digest and
  -- a later activation that presents a different digest for the same version is
  -- refused instead of being silently re-bound.
  INSERT INTO uap.role_template_versions(organization_id, role_template_id, version, source_digest, created_at)
  VALUES (p_organization_id, p_role_template_id, p_role_template_version, p_role_template_digest, v_now)
  ON CONFLICT (organization_id, role_template_id, version) DO NOTHING;
  SELECT template.source_digest INTO stored_digest FROM uap.role_template_versions AS template
  WHERE template.organization_id = p_organization_id
    AND template.role_template_id = p_role_template_id
    AND template.version = p_role_template_version;
  IF stored_digest IS DISTINCT FROM p_role_template_digest THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='role_digest_mismatch';
  END IF;

  IF p_lineage_parent_id IS NOT NULL THEN
    SELECT * INTO parent FROM uap.sid_identities AS identity
    WHERE identity.sid = p_lineage_parent_id AND identity.organization_id = p_organization_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='lineage_parent_missing';
    END IF;
    v_lineage := parent.lineage_version + 1;
  END IF;

  v_hash := encode(sha256(convert_to(p_identity_document::text, 'UTF8')), 'hex');

  INSERT INTO uap.sid_identities(sid, organization_id, display_name, status, lineage_parent_id,
    lineage_version, role_template_id, role_template_version, identity_hash, identity_document,
    created_at, updated_at)
  VALUES (p_sid, p_organization_id, p_display_name, 'active', p_lineage_parent_id, v_lineage,
    p_role_template_id, p_role_template_version, v_hash, p_identity_document, v_now, v_now);

  INSERT INTO uap.agent_installations(installation_id, organization_id, sid, installation_ref, runtime, state, created_at)
  VALUES (p_installation_id, p_organization_id, p_sid, p_installation_ref, p_runtime, 'active', v_now);

  INSERT INTO uap.hermes_model_selections(model_selection_id, organization_id, sid, provider, model, epoch, created_at)
  VALUES (p_model_selection_id, p_organization_id, p_sid, p_model_provider, p_model_name, 1, v_now);

  UPDATE uap.sid_identities AS identity SET model_selection_id = p_model_selection_id, updated_at = v_now
  WHERE identity.sid = p_sid;

  RETURN QUERY SELECT p_sid, p_installation_id, p_model_selection_id, v_hash, v_lineage;
END
$function$;

-- Provider switching is a new selection record; it never changes the SID or the
-- identity hash it was issued with.
CREATE FUNCTION uap.record_sid_model_selection(
  p_organization_id text,
  p_sid text,
  p_model_selection_id text,
  p_provider text,
  p_model_name text
)
RETURNS TABLE(model_selection_id text, epoch integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, uap
SET row_security = on
AS $function$
DECLARE
  actor_id text := nullif(current_setting('uap.actor_id',true),'');
  request_organization text := nullif(current_setting('uap.organization_id',true),'');
  v_now bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  target uap.sid_identities%ROWTYPE;
  next_epoch integer;
BEGIN
  IF request_organization IS DISTINCT FROM p_organization_id
    OR actor_id IS NULL
    OR NOT uap.has_org_role(p_organization_id, ARRAY['owner','admin','member']) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='tenant_forbidden';
  END IF;
  IF p_model_selection_id IS NULL OR length(p_model_selection_id) NOT BETWEEN 1 AND 200
    OR p_provider IS NULL OR length(p_provider) NOT BETWEEN 1 AND 100
    OR p_model_name IS NULL OR length(p_model_name) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION USING ERRCODE='P0003', MESSAGE='sid_input_invalid';
  END IF;

  SELECT * INTO target FROM uap.sid_identities AS identity
  WHERE identity.sid = p_sid AND identity.organization_id = p_organization_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='sid_missing';
  END IF;
  IF target.status <> 'active' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='sid_not_active';
  END IF;

  SELECT coalesce(max(selection.epoch), 0) + 1 INTO next_epoch
  FROM uap.hermes_model_selections AS selection WHERE selection.sid = p_sid;

  INSERT INTO uap.hermes_model_selections(model_selection_id, organization_id, sid, provider, model, epoch, created_at)
  VALUES (p_model_selection_id, p_organization_id, p_sid, p_provider, p_model_name, next_epoch, v_now);
  UPDATE uap.sid_identities AS identity SET model_selection_id = p_model_selection_id, updated_at = v_now
  WHERE identity.sid = p_sid;

  RETURN QUERY SELECT p_model_selection_id, next_epoch;
END
$function$;

REVOKE ALL ON FUNCTION
  uap.issue_sid_instance(text,text,text,text,integer,text,text,text,text,text,text,text,jsonb,text),
  uap.record_sid_model_selection(text,text,text,text,text)
FROM PUBLIC;
REVOKE ALL ON uap.role_template_versions,uap.sid_identities,uap.agent_installations,uap.hermes_model_selections FROM PUBLIC;
`,
};

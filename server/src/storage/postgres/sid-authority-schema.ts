/**
 * SID authority: issuer keys, signed credentials, revocation and two-party
 * ownership transfer (V6-04-05).
 *
 * Division of responsibility:
 *  - PostgreSQL owns authority: which Ed25519 keys an organization trusts, that
 *    a credential may only attest the identity hash the SID actually has, that a
 *    credential replaces exactly the current one, that revocation is one-way,
 *    and that a transfer needs an owner on each side and a live, unexpired
 *    request.
 *  - The service (server/src/identity/issuer.ts) owns the signature bytes: it
 *    signs a newline-delimited payload and verifies it against the trusted key
 *    before the row is written. A stored signature is re-verifiable from the row.
 *
 * The identity hash is never rewritten by a re-sign or a transfer: a new key
 * attests the same hash, and the credential it supersedes stays in place, so a
 * historical SID keeps a verifiable old identity while current control changes
 * explicitly (FACT-E2E-015).
 */
import type { PostgresMigration } from './schema.js';

export const SID_AUTHORITY_MIGRATION: PostgresMigration = {
  id: 10,
  name: 'sid_authority_signature_revocation_transfer',
  sql: `
CREATE TABLE uap.sid_issuers (
  issuer_id text PRIMARY KEY CHECK (length(issuer_id) BETWEEN 1 AND 200),
  organization_id text NOT NULL REFERENCES uap.organizations(id) ON DELETE RESTRICT,
  key_id text NOT NULL CHECK (length(key_id) BETWEEN 1 AND 200),
  public_key text NOT NULL CHECK (public_key ~ '^[A-Za-z0-9+/]{43}=$'),
  status text NOT NULL DEFAULT 'trusted' CHECK (status IN ('trusted','revoked')),
  created_at bigint NOT NULL CHECK (created_at >= 0),
  revoked_at bigint,
  UNIQUE (organization_id, key_id),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);

CREATE TABLE uap.sid_credentials (
  credential_id text PRIMARY KEY CHECK (length(credential_id) BETWEEN 1 AND 200),
  sid text NOT NULL REFERENCES uap.sid_identities(sid) ON DELETE RESTRICT,
  issuer_organization_id text NOT NULL REFERENCES uap.organizations(id) ON DELETE RESTRICT,
  key_id text NOT NULL,
  identity_hash text NOT NULL CHECK (identity_hash ~ '^[a-f0-9]{64}$'),
  issued_at bigint NOT NULL CHECK (issued_at >= 0),
  supersedes_credential_id text REFERENCES uap.sid_credentials(credential_id) ON DELETE RESTRICT,
  signature text NOT NULL CHECK (signature ~ '^[A-Za-z0-9+/]{86}==$'),
  created_at bigint NOT NULL CHECK (created_at >= 0),
  CHECK (supersedes_credential_id IS NULL OR supersedes_credential_id <> credential_id)
);

ALTER TABLE uap.sid_identities
  ADD COLUMN current_credential_id text REFERENCES uap.sid_credentials(credential_id) ON DELETE RESTRICT;

CREATE TABLE uap.sid_revocations (
  sid text PRIMARY KEY REFERENCES uap.sid_identities(sid) ON DELETE RESTRICT,
  organization_id text NOT NULL REFERENCES uap.organizations(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  revoked_by text NOT NULL,
  revoked_at bigint NOT NULL CHECK (revoked_at >= 0),
  epoch integer NOT NULL DEFAULT 1 CHECK (epoch > 0)
);

CREATE TABLE uap.sid_transfers (
  transfer_id text PRIMARY KEY CHECK (length(transfer_id) BETWEEN 1 AND 200),
  sid text NOT NULL REFERENCES uap.sid_identities(sid) ON DELETE RESTRICT,
  from_organization_id text NOT NULL REFERENCES uap.organizations(id) ON DELETE RESTRICT,
  to_organization_id text NOT NULL REFERENCES uap.organizations(id) ON DELETE RESTRICT,
  identity_hash text NOT NULL CHECK (identity_hash ~ '^[a-f0-9]{64}$'),
  supersedes_credential_id text REFERENCES uap.sid_credentials(credential_id) ON DELETE RESTRICT,
  requested_by text NOT NULL,
  requested_at bigint NOT NULL CHECK (requested_at >= 0),
  expires_at bigint NOT NULL CHECK (expires_at > 0),
  accepted_by text,
  accepted_at bigint,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','cancelled','expired')),
  CHECK (from_organization_id <> to_organization_id),
  CHECK ((status = 'accepted') = (accepted_at IS NOT NULL AND accepted_by IS NOT NULL))
);
CREATE UNIQUE INDEX sid_transfers_one_pending ON uap.sid_transfers(sid) WHERE status = 'pending';

ALTER TABLE uap.sid_issuers ENABLE ROW LEVEL SECURITY;
ALTER TABLE uap.sid_issuers FORCE ROW LEVEL SECURITY;
ALTER TABLE uap.sid_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE uap.sid_credentials FORCE ROW LEVEL SECURITY;
ALTER TABLE uap.sid_revocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE uap.sid_revocations FORCE ROW LEVEL SECURITY;
ALTER TABLE uap.sid_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE uap.sid_transfers FORCE ROW LEVEL SECURITY;

CREATE POLICY sid_issuers_member_read ON uap.sid_issuers FOR SELECT USING (
  uap.has_org_role(organization_id, ARRAY['owner','admin','member','viewer'])
);
CREATE POLICY sid_issuers_admin_write ON uap.sid_issuers FOR INSERT WITH CHECK (
  uap.has_org_role(organization_id, ARRAY['owner','admin'])
);
-- The credential history follows the SID, so a new owner can verify the old
-- attestation instead of receiving a rewritten identity.
CREATE POLICY sid_credentials_member_read ON uap.sid_credentials FOR SELECT USING (
  EXISTS (SELECT 1 FROM uap.sid_identities AS identity
    WHERE identity.sid = sid_credentials.sid
      AND uap.has_org_role(identity.organization_id, ARRAY['owner','admin','member','viewer']))
);
CREATE POLICY sid_credentials_service_write ON uap.sid_credentials FOR INSERT WITH CHECK (
  uap.has_org_role(issuer_organization_id, ARRAY['owner','admin','member'])
);
CREATE POLICY sid_revocations_member_read ON uap.sid_revocations FOR SELECT USING (
  EXISTS (SELECT 1 FROM uap.sid_identities AS identity
    WHERE identity.sid = sid_revocations.sid
      AND uap.has_org_role(identity.organization_id, ARRAY['owner','admin','member','viewer']))
);
CREATE POLICY sid_revocations_admin_write ON uap.sid_revocations FOR INSERT WITH CHECK (
  uap.has_org_role(organization_id, ARRAY['owner','admin'])
);
CREATE POLICY sid_transfers_party_read ON uap.sid_transfers FOR SELECT USING (
  uap.has_org_role(from_organization_id, ARRAY['owner','admin','member','viewer'])
  OR uap.has_org_role(to_organization_id, ARRAY['owner','admin','member','viewer'])
);
CREATE POLICY sid_transfers_source_write ON uap.sid_transfers FOR INSERT WITH CHECK (
  uap.has_org_role(from_organization_id, ARRAY['owner','admin'])
);
CREATE POLICY sid_transfers_target_update ON uap.sid_transfers FOR UPDATE USING (
  uap.has_org_role(to_organization_id, ARRAY['owner','admin'])
) WITH CHECK (
  uap.has_org_role(to_organization_id, ARRAY['owner','admin'])
);

-- Transferred installations and model selections move with their SID inside one
-- transaction; the composite foreign keys are checked at commit.
ALTER TABLE uap.agent_installations
  ALTER CONSTRAINT agent_installations_organization_id_sid_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE uap.hermes_model_selections
  ALTER CONSTRAINT hermes_model_selections_organization_id_sid_fkey DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION uap.register_sid_issuer(
  p_organization_id text,
  p_issuer_id text,
  p_key_id text,
  p_public_key text
) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, uap
SET row_security = on
AS $function$
DECLARE
  actor_id text := nullif(current_setting('uap.actor_id',true),'');
  request_organization text := nullif(current_setting('uap.organization_id',true),'');
  v_now bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
BEGIN
  IF request_organization IS DISTINCT FROM p_organization_id OR actor_id IS NULL
    OR NOT uap.has_org_role(p_organization_id, ARRAY['owner','admin']) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='issuer_forbidden';
  END IF;
  IF p_issuer_id IS NULL OR length(p_issuer_id) NOT BETWEEN 1 AND 200
    OR p_key_id IS NULL OR length(p_key_id) NOT BETWEEN 1 AND 200
    OR p_public_key IS NULL OR p_public_key !~ '^[A-Za-z0-9+/]{43}=$' THEN
    RAISE EXCEPTION USING ERRCODE='P0003', MESSAGE='issuer_input_invalid';
  END IF;
  BEGIN
    INSERT INTO uap.sid_issuers(issuer_id, organization_id, key_id, public_key, status, created_at)
    VALUES (p_issuer_id, p_organization_id, p_key_id, p_public_key, 'trusted', v_now);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='issuer_exists';
  END;
  RETURN p_key_id;
END
$function$;

CREATE FUNCTION uap.set_sid_issuer_status(
  p_organization_id text,
  p_key_id text,
  p_status text
) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, uap
SET row_security = on
AS $function$
DECLARE
  actor_id text := nullif(current_setting('uap.actor_id',true),'');
  request_organization text := nullif(current_setting('uap.organization_id',true),'');
  v_now bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  current_status text;
BEGIN
  IF request_organization IS DISTINCT FROM p_organization_id OR actor_id IS NULL
    OR NOT uap.has_org_role(p_organization_id, ARRAY['owner','admin']) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='issuer_forbidden';
  END IF;
  IF p_status IS DISTINCT FROM 'revoked' THEN
    RAISE EXCEPTION USING ERRCODE='P0003', MESSAGE='issuer_status_invalid';
  END IF;
  SELECT status INTO current_status FROM uap.sid_issuers AS issuer
  WHERE issuer.organization_id = p_organization_id AND issuer.key_id = p_key_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='issuer_missing';
  END IF;
  IF current_status = 'revoked' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='issuer_revoked';
  END IF;
  UPDATE uap.sid_issuers AS issuer SET status = 'revoked', revoked_at = v_now
  WHERE issuer.organization_id = p_organization_id AND issuer.key_id = p_key_id;
  RETURN p_key_id;
END
$function$;

CREATE FUNCTION uap.record_sid_credential(
  p_organization_id text,
  p_sid text,
  p_credential_id text,
  p_key_id text,
  p_issued_at bigint,
  p_signature text,
  p_supersedes_credential_id text
) RETURNS TABLE(credential_id text, identity_hash text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, uap
SET row_security = on
AS $function$
DECLARE
  actor_id text := nullif(current_setting('uap.actor_id',true),'');
  request_organization text := nullif(current_setting('uap.organization_id',true),'');
  v_now bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  target uap.sid_identities%ROWTYPE;
  issuer_status text;
  supersedes_sid text;
BEGIN
  IF request_organization IS DISTINCT FROM p_organization_id OR actor_id IS NULL
    OR NOT uap.has_org_role(p_organization_id, ARRAY['owner','admin','member']) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='tenant_forbidden';
  END IF;
  IF p_credential_id IS NULL OR length(p_credential_id) NOT BETWEEN 1 AND 200
    OR p_key_id IS NULL OR length(p_key_id) NOT BETWEEN 1 AND 200
    OR p_issued_at IS NULL OR p_issued_at < 0
    OR p_signature IS NULL OR p_signature !~ '^[A-Za-z0-9+/]{86}==$' THEN
    RAISE EXCEPTION USING ERRCODE='P0003', MESSAGE='credential_input_invalid';
  END IF;

  SELECT issuer.status INTO issuer_status FROM uap.sid_issuers AS issuer
  WHERE issuer.organization_id = p_organization_id AND issuer.key_id = p_key_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='issuer_untrusted';
  END IF;
  IF issuer_status <> 'trusted' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='issuer_revoked';
  END IF;

  SELECT * INTO target FROM uap.sid_identities AS identity WHERE identity.sid = p_sid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='sid_missing';
  END IF;
  IF target.organization_id IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='sid_foreign_tenant';
  END IF;
  IF target.status <> 'active' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='sid_not_active';
  END IF;

  -- A re-sign replaces exactly the credential in force, never an arbitrary
  -- historical one, so the chain of attestations stays linear.
  IF p_supersedes_credential_id IS NOT NULL THEN
    SELECT credential.sid INTO supersedes_sid FROM uap.sid_credentials AS credential
    WHERE credential.credential_id = p_supersedes_credential_id;
    IF NOT FOUND OR supersedes_sid <> p_sid THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='credential_supersedes_mismatch';
    END IF;
    IF target.current_credential_id IS DISTINCT FROM p_supersedes_credential_id THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='credential_supersedes_mismatch';
    END IF;
  ELSIF target.current_credential_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='credential_supersedes_required';
  END IF;

  BEGIN
    INSERT INTO uap.sid_credentials(credential_id, sid, issuer_organization_id, key_id, identity_hash,
      issued_at, supersedes_credential_id, signature, created_at)
    VALUES (p_credential_id, p_sid, p_organization_id, p_key_id, target.identity_hash,
      p_issued_at, p_supersedes_credential_id, p_signature, v_now);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='credential_exists';
  END;
  UPDATE uap.sid_identities AS identity SET current_credential_id = p_credential_id, updated_at = v_now
  WHERE identity.sid = p_sid;
  RETURN QUERY SELECT p_credential_id, target.identity_hash;
END
$function$;

CREATE FUNCTION uap.revoke_sid_identity(
  p_organization_id text,
  p_sid text,
  p_reason text
) RETURNS TABLE(status text, revoked_at bigint, epoch integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, uap
SET row_security = on
AS $function$
DECLARE
  actor_id text := nullif(current_setting('uap.actor_id',true),'');
  request_organization text := nullif(current_setting('uap.organization_id',true),'');
  v_now bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  target uap.sid_identities%ROWTYPE;
BEGIN
  IF request_organization IS DISTINCT FROM p_organization_id OR actor_id IS NULL
    OR NOT uap.has_org_role(p_organization_id, ARRAY['owner','admin']) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='revoke_forbidden';
  END IF;
  IF p_reason IS NULL OR length(p_reason) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION USING ERRCODE='P0003', MESSAGE='revocation_input_invalid';
  END IF;
  SELECT * INTO target FROM uap.sid_identities AS identity WHERE identity.sid = p_sid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='sid_missing';
  END IF;
  IF target.organization_id IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='sid_foreign_tenant';
  END IF;
  IF target.status = 'revoked' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='already_revoked';
  END IF;

  INSERT INTO uap.sid_revocations(sid, organization_id, reason, revoked_by, revoked_at, epoch)
  VALUES (p_sid, p_organization_id, p_reason, actor_id, v_now, 1);
  UPDATE uap.sid_identities AS identity SET status = 'revoked', updated_at = v_now
  WHERE identity.sid = p_sid;
  RETURN QUERY SELECT 'revoked'::text, v_now, 1;
END
$function$;

CREATE FUNCTION uap.request_sid_transfer(
  p_transfer_id text,
  p_organization_id text,
  p_sid text,
  p_to_organization_id text,
  p_expires_at bigint
) RETURNS TABLE(transfer_id text, status text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, uap
SET row_security = on
AS $function$
DECLARE
  actor_id text := nullif(current_setting('uap.actor_id',true),'');
  request_organization text := nullif(current_setting('uap.organization_id',true),'');
  v_now bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  target uap.sid_identities%ROWTYPE;
BEGIN
  IF request_organization IS DISTINCT FROM p_organization_id OR actor_id IS NULL
    OR NOT uap.has_org_role(p_organization_id, ARRAY['owner','admin']) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='transfer_forbidden';
  END IF;
  IF p_transfer_id IS NULL OR length(p_transfer_id) NOT BETWEEN 1 AND 200
    OR p_to_organization_id IS NULL OR p_to_organization_id = p_organization_id
    OR p_expires_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0003', MESSAGE='transfer_input_invalid';
  END IF;
  IF p_expires_at <= v_now THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='transfer_expired';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM uap.organizations AS organization WHERE organization.id = p_to_organization_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='transfer_org_missing';
  END IF;

  SELECT * INTO target FROM uap.sid_identities AS identity WHERE identity.sid = p_sid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='sid_missing';
  END IF;
  IF target.organization_id IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='sid_foreign_tenant';
  END IF;
  IF target.status <> 'active' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='sid_not_active';
  END IF;
  IF EXISTS (SELECT 1 FROM uap.sid_transfers AS transfer WHERE transfer.sid = p_sid AND transfer.status = 'pending') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='transfer_exists';
  END IF;

  INSERT INTO uap.sid_transfers(transfer_id, sid, from_organization_id, to_organization_id,
    identity_hash, supersedes_credential_id, requested_by, requested_at, expires_at, status)
  VALUES (p_transfer_id, p_sid, p_organization_id, p_to_organization_id,
    target.identity_hash, target.current_credential_id, actor_id, v_now, p_expires_at, 'pending');
  RETURN QUERY SELECT p_transfer_id, 'pending'::text;
END
$function$;

CREATE FUNCTION uap.accept_sid_transfer(
  p_transfer_id text,
  p_organization_id text,
  p_credential_id text,
  p_key_id text,
  p_issued_at bigint,
  p_signature text
) RETURNS TABLE(sid text, credential_id text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, uap
SET row_security = on
AS $function$
DECLARE
  actor_id text := nullif(current_setting('uap.actor_id',true),'');
  request_organization text := nullif(current_setting('uap.organization_id',true),'');
  v_now bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  transfer uap.sid_transfers%ROWTYPE;
  target uap.sid_identities%ROWTYPE;
  issuer_status text;
  template_digest text;
  old_credential text;
BEGIN
  IF request_organization IS DISTINCT FROM p_organization_id OR actor_id IS NULL
    OR NOT uap.has_org_role(p_organization_id, ARRAY['owner','admin']) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='transfer_forbidden';
  END IF;
  IF p_credential_id IS NULL OR length(p_credential_id) NOT BETWEEN 1 AND 200
    OR p_key_id IS NULL OR length(p_key_id) NOT BETWEEN 1 AND 200
    OR p_issued_at IS NULL OR p_issued_at < 0
    OR p_signature IS NULL OR p_signature !~ '^[A-Za-z0-9+/]{86}==$' THEN
    RAISE EXCEPTION USING ERRCODE='P0003', MESSAGE='credential_input_invalid';
  END IF;

  SELECT * INTO transfer FROM uap.sid_transfers AS request
  WHERE request.transfer_id = p_transfer_id AND request.to_organization_id = p_organization_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='transfer_missing';
  END IF;
  IF transfer.status <> 'pending' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='transfer_not_pending';
  END IF;
  IF transfer.expires_at <= v_now THEN
    UPDATE uap.sid_transfers AS request SET status = 'expired' WHERE request.transfer_id = p_transfer_id;
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='transfer_expired';
  END IF;

  SELECT issuer.status INTO issuer_status FROM uap.sid_issuers AS issuer
  WHERE issuer.organization_id = p_organization_id AND issuer.key_id = p_key_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='issuer_untrusted';
  END IF;
  IF issuer_status <> 'trusted' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='issuer_revoked';
  END IF;

  SELECT * INTO target FROM uap.sid_identities AS identity WHERE identity.sid = transfer.sid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='sid_missing';
  END IF;
  IF target.status <> 'active' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='sid_not_active';
  END IF;

  -- The receiving tenant must hold the same role template version with the same
  -- digest; a transfer never re-binds a role silently.
  SELECT template.source_digest INTO template_digest FROM uap.role_template_versions AS template
  WHERE template.organization_id = p_organization_id
    AND template.role_template_id = target.role_template_id
    AND template.version = target.role_template_version;
  IF FOUND AND template_digest IS DISTINCT FROM (
    SELECT template.source_digest FROM uap.role_template_versions AS template
    WHERE template.organization_id = transfer.from_organization_id
      AND template.role_template_id = target.role_template_id
      AND template.version = target.role_template_version) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='role_digest_mismatch';
  END IF;
  INSERT INTO uap.role_template_versions(organization_id, role_template_id, version, source_digest, created_at)
  SELECT p_organization_id, template.role_template_id, template.version, template.source_digest, v_now
  FROM uap.role_template_versions AS template
  WHERE template.organization_id = transfer.from_organization_id
    AND template.role_template_id = target.role_template_id
    AND template.version = target.role_template_version
  ON CONFLICT (organization_id, role_template_id, version) DO NOTHING;

  SET CONSTRAINTS ALL DEFERRED;
  UPDATE uap.agent_installations AS installation SET organization_id = p_organization_id
  WHERE installation.sid = transfer.sid;
  UPDATE uap.hermes_model_selections AS selection SET organization_id = p_organization_id
  WHERE selection.sid = transfer.sid;
  UPDATE uap.sid_identities AS identity SET organization_id = p_organization_id, updated_at = v_now
  WHERE identity.sid = transfer.sid;

  old_credential := transfer.supersedes_credential_id;
  IF old_credential IS DISTINCT FROM target.current_credential_id THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='credential_supersedes_mismatch';
  END IF;
  BEGIN
    INSERT INTO uap.sid_credentials(credential_id, sid, issuer_organization_id, key_id, identity_hash,
      issued_at, supersedes_credential_id, signature, created_at)
    VALUES (p_credential_id, transfer.sid, p_organization_id, p_key_id, transfer.identity_hash,
      p_issued_at, old_credential, p_signature, v_now);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='credential_exists';
  END;
  UPDATE uap.sid_identities AS identity SET current_credential_id = p_credential_id, updated_at = v_now
  WHERE identity.sid = transfer.sid;
  UPDATE uap.sid_transfers AS request SET status = 'accepted', accepted_by = actor_id, accepted_at = v_now
  WHERE request.transfer_id = p_transfer_id;

  RETURN QUERY SELECT transfer.sid, p_credential_id;
END
$function$;

REVOKE ALL ON FUNCTION
  uap.register_sid_issuer(text,text,text,text),
  uap.set_sid_issuer_status(text,text,text),
  uap.record_sid_credential(text,text,text,text,bigint,text,text),
  uap.revoke_sid_identity(text,text,text),
  uap.request_sid_transfer(text,text,text,text,bigint),
  uap.accept_sid_transfer(text,text,text,text,bigint,text)
FROM PUBLIC;
REVOKE ALL ON uap.sid_issuers,uap.sid_credentials,uap.sid_revocations,uap.sid_transfers FROM PUBLIC;
`,
};

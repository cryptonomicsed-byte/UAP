/**
 * SID lifecycle: pause / resume / archive (V6-04-09).
 *
 * Pause is not deletion. A paused agent keeps its SID, its identity hash, its
 * installation records and its memory namespace; the status is what stops new
 * work from being admitted. Resume returns to `active` from `paused` only — it
 * never re-issues an identity. Archive is the end of service: the SID becomes
 * read-only, its live installations are marked `removed`, and it cannot be
 * resumed — a replacement is a new SID with `lineage_parent_id` pointing here.
 *
 * A revoked SID is final (revocation is D-14's authority): no lifecycle call
 * moves it, and every attempt is refused rather than silently ignored.
 *
 * Every transition appends one row to uap.sid_lifecycle_events, which the
 * database refuses to update, delete or truncate — including for its owner.
 */
import type { PostgresMigration } from './schema.js';

export const LIFECYCLE_MIGRATION: PostgresMigration = {
  id: 11,
  name: 'sid_lifecycle_pause_resume_archive',
  sql: `
CREATE TABLE uap.sid_lifecycle_events (
  organization_id text NOT NULL REFERENCES uap.organizations(id) ON DELETE RESTRICT,
  sid text NOT NULL,
  seq integer NOT NULL CHECK (seq > 0),
  event_type text NOT NULL CHECK (event_type IN ('paused','resumed','archived')),
  from_status text NOT NULL CHECK (from_status IN ('active','paused','archived')),
  to_status text NOT NULL CHECK (to_status IN ('active','paused','archived')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 200),
  occurred_at bigint NOT NULL CHECK (occurred_at >= 0),
  PRIMARY KEY (organization_id, sid, seq),
  FOREIGN KEY (organization_id, sid) REFERENCES uap.sid_identities(organization_id, sid) ON DELETE RESTRICT
);

ALTER TABLE uap.sid_lifecycle_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE uap.sid_lifecycle_events FORCE ROW LEVEL SECURITY;

CREATE POLICY sid_lifecycle_events_member_read ON uap.sid_lifecycle_events FOR SELECT USING (
  uap.has_org_role(organization_id, ARRAY['owner','admin','member','viewer'])
);
CREATE POLICY sid_lifecycle_events_writer ON uap.sid_lifecycle_events FOR INSERT WITH CHECK (
  uap.has_org_role(organization_id, ARRAY['owner','admin','member'])
);
-- Archiving must be able to retire live installations; nothing else may update them.
CREATE POLICY agent_installations_updater ON uap.agent_installations FOR UPDATE USING (
  uap.has_org_role(organization_id, ARRAY['owner','admin','member'])
) WITH CHECK (
  uap.has_org_role(organization_id, ARRAY['owner','admin','member'])
);

CREATE FUNCTION uap.sid_lifecycle_events_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='sid_lifecycle_events_append_only';
END
$function$;

CREATE TRIGGER sid_lifecycle_events_no_update BEFORE UPDATE ON uap.sid_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION uap.sid_lifecycle_events_append_only();
CREATE TRIGGER sid_lifecycle_events_no_delete BEFORE DELETE ON uap.sid_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION uap.sid_lifecycle_events_append_only();
CREATE TRIGGER sid_lifecycle_events_no_truncate BEFORE TRUNCATE ON uap.sid_lifecycle_events
  FOR EACH STATEMENT EXECUTE FUNCTION uap.sid_lifecycle_events_append_only();

-- The state machine lives in one place so the three entry points cannot drift.
CREATE FUNCTION uap.apply_sid_lifecycle(
  p_organization_id text,
  p_sid text,
  p_action text,
  p_reason text
)
RETURNS TABLE(sid text, status text, affected_installations integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, uap
SET row_security = on
AS $function$
DECLARE
  v_now bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  target uap.sid_identities%ROWTYPE;
  v_seq integer;
  v_from text;
  v_status text;
  v_event text;
  v_installations integer := 0;
BEGIN
  SELECT * INTO target FROM uap.sid_identities AS identity
  WHERE identity.sid = p_sid AND identity.organization_id = p_organization_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='sid_missing';
  END IF;
  IF target.status = 'revoked' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='sid_revoked';
  END IF;
  v_from := target.status;

  IF p_action = 'pause' THEN
    IF v_from = 'archived' THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='sid_archived';
    END IF;
    IF v_from <> 'active' THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='sid_not_active';
    END IF;
    v_status := 'paused';
    v_event := 'paused';
  ELSIF p_action = 'resume' THEN
    IF v_from = 'archived' THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='sid_archived';
    END IF;
    IF v_from <> 'paused' THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='sid_not_paused';
    END IF;
    v_status := 'active';
    v_event := 'resumed';
  ELSIF p_action = 'archive' THEN
    IF v_from = 'archived' THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='sid_already_archived';
    END IF;
    v_status := 'archived';
    v_event := 'archived';
    UPDATE uap.agent_installations AS installation
    SET state = 'removed'
    WHERE installation.organization_id = p_organization_id
      AND installation.sid = p_sid
      AND installation.state <> 'removed';
    GET DIAGNOSTICS v_installations = ROW_COUNT;
  ELSE
    RAISE EXCEPTION USING ERRCODE='P0003', MESSAGE='lifecycle_action_invalid';
  END IF;

  UPDATE uap.sid_identities AS identity
  SET status = v_status, updated_at = v_now
  WHERE identity.sid = p_sid;

  SELECT coalesce(max(event.seq), 0) + 1 INTO v_seq
  FROM uap.sid_lifecycle_events AS event WHERE event.sid = p_sid;

  INSERT INTO uap.sid_lifecycle_events(
    organization_id, sid, seq, event_type, from_status, to_status, reason, actor_id, occurred_at)
  VALUES (p_organization_id, p_sid, v_seq, v_event, v_from, v_status, p_reason,
    nullif(current_setting('uap.actor_id', true), ''), v_now);

  RETURN QUERY SELECT p_sid, v_status, v_installations;
END
$function$;

CREATE FUNCTION uap.pause_sid_instance(
  p_organization_id text,
  p_sid text,
  p_reason text
)
RETURNS TABLE(sid text, status text, affected_installations integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, uap
SET row_security = on
AS $function$
DECLARE
  actor_id text := nullif(current_setting('uap.actor_id', true), '');
  request_organization text := nullif(current_setting('uap.organization_id', true), '');
BEGIN
  IF request_organization IS DISTINCT FROM p_organization_id
    OR actor_id IS NULL
    OR NOT uap.has_org_role(p_organization_id, ARRAY['owner','admin','member']) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='tenant_forbidden';
  END IF;
  IF p_sid IS NULL OR p_sid !~ '^sid_[a-z0-9][a-z0-9_-]{0,62}$'
    OR p_reason IS NULL OR length(p_reason) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION USING ERRCODE='P0003', MESSAGE='sid_input_invalid';
  END IF;
  RETURN QUERY SELECT * FROM uap.apply_sid_lifecycle(p_organization_id, p_sid, 'pause', p_reason);
END
$function$;

CREATE FUNCTION uap.resume_sid_instance(
  p_organization_id text,
  p_sid text
)
RETURNS TABLE(sid text, status text, affected_installations integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, uap
SET row_security = on
AS $function$
DECLARE
  actor_id text := nullif(current_setting('uap.actor_id', true), '');
  request_organization text := nullif(current_setting('uap.organization_id', true), '');
BEGIN
  IF request_organization IS DISTINCT FROM p_organization_id
    OR actor_id IS NULL
    OR NOT uap.has_org_role(p_organization_id, ARRAY['owner','admin','member']) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='tenant_forbidden';
  END IF;
  IF p_sid IS NULL OR p_sid !~ '^sid_[a-z0-9][a-z0-9_-]{0,62}$' THEN
    RAISE EXCEPTION USING ERRCODE='P0003', MESSAGE='sid_input_invalid';
  END IF;
  RETURN QUERY SELECT * FROM uap.apply_sid_lifecycle(p_organization_id, p_sid, 'resume', 'resumed by operator');
END
$function$;

-- Archiving retires an agent for good, so it is narrower than pause/resume.
CREATE FUNCTION uap.archive_sid_instance(
  p_organization_id text,
  p_sid text,
  p_reason text
)
RETURNS TABLE(sid text, status text, affected_installations integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, uap
SET row_security = on
AS $function$
DECLARE
  actor_id text := nullif(current_setting('uap.actor_id', true), '');
  request_organization text := nullif(current_setting('uap.organization_id', true), '');
BEGIN
  IF request_organization IS DISTINCT FROM p_organization_id
    OR actor_id IS NULL
    OR NOT uap.has_org_role(p_organization_id, ARRAY['owner','admin']) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='tenant_forbidden';
  END IF;
  IF p_sid IS NULL OR p_sid !~ '^sid_[a-z0-9][a-z0-9_-]{0,62}$'
    OR p_reason IS NULL OR length(p_reason) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION USING ERRCODE='P0003', MESSAGE='sid_input_invalid';
  END IF;
  RETURN QUERY SELECT * FROM uap.apply_sid_lifecycle(p_organization_id, p_sid, 'archive', p_reason);
END
$function$;

REVOKE ALL ON FUNCTION
  uap.sid_lifecycle_events_append_only(),
  uap.apply_sid_lifecycle(text,text,text,text),
  uap.pause_sid_instance(text,text,text),
  uap.resume_sid_instance(text,text),
  uap.archive_sid_instance(text,text,text)
FROM PUBLIC;
REVOKE ALL ON uap.sid_lifecycle_events FROM PUBLIC;
`,
};

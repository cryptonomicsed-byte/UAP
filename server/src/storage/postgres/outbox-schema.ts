import type { PostgresMigration } from './schema.js';

/**
 * Transactional outbox for the single durable task queue (V6-06-03).
 *
 * Decision: `uap.task_jobs` + `uap.job_events` in PostgreSQL remain the one queue
 * and one ledger authority. Delivery to other processes (UI stream, metrics,
 * settlement) is never attempted from inside a transition; instead every committed
 * event row is mirrored into `uap.job_outbox` by an AFTER INSERT trigger, in the
 * same transaction as the state change. A relay claims unpublished rows with
 * `FOR UPDATE SKIP LOCKED`, publishes at-least-once, then marks them published.
 *
 * Guarantees this migration is responsible for:
 *   * no phantom delivery — a rolled-back transition leaves no outbox row;
 *   * exclusive delivery leases with an owner fence (`locked_by`), so a relay that
 *     lost its lease cannot mark or release somebody else's row;
 *   * bounded retries with backoff and an explicit dead-letter state;
 *   * at-least-once, never exactly-once: a crash after publish but before the mark
 *     republishes, which is why consumers key on `event_id`.
 */
export const OUTBOX_MIGRATION: PostgresMigration = {
  id: 8,
  name: 'durable_task_outbox',
  sql: `
CREATE TABLE uap.job_outbox (
  event_id text PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 200),
  organization_id text NOT NULL,
  job_id text NOT NULL CHECK (length(job_id) BETWEEN 1 AND 200),
  seq bigint NOT NULL CHECK (seq >= 1),
  event_type text NOT NULL CHECK (event_type ~ '^[a-z0-9][a-z0-9._-]{0,99}$'),
  created_at bigint NOT NULL CHECK (created_at >= 0),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at bigint NOT NULL CHECK (next_attempt_at >= 0),
  locked_by text CHECK (locked_by IS NULL OR length(locked_by) BETWEEN 1 AND 200),
  locked_until bigint CHECK (locked_until IS NULL OR locked_until >= 0),
  published_at bigint CHECK (published_at IS NULL OR published_at >= created_at),
  dead_lettered_at bigint CHECK (dead_lettered_at IS NULL OR dead_lettered_at >= created_at),
  last_error text CHECK (last_error IS NULL OR octet_length(last_error) <= 4096),
  FOREIGN KEY (organization_id, event_id)
    REFERENCES uap.job_events(organization_id, event_id) ON DELETE RESTRICT,
  CHECK ((locked_by IS NULL) = (locked_until IS NULL)),
  CHECK (published_at IS NULL OR dead_lettered_at IS NULL),
  CHECK (published_at IS NULL OR locked_by IS NULL)
);
CREATE INDEX job_outbox_deliverable
  ON uap.job_outbox(next_attempt_at, created_at, event_id)
  WHERE published_at IS NULL AND dead_lettered_at IS NULL;
REVOKE ALL ON uap.job_outbox FROM PUBLIC;

-- One outbox row per committed event, written in the inserting transaction and
-- nowhere else. Callers cannot forget it and cannot write it directly.
CREATE FUNCTION uap.job_events_enqueue_outbox()
RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, uap
SET row_security = on
AS $function$
BEGIN
  INSERT INTO uap.job_outbox(
    event_id,organization_id,job_id,seq,event_type,created_at,next_attempt_at
  ) VALUES (
    NEW.event_id,NEW.organization_id,NEW.job_id,NEW.seq,NEW.event_type,NEW.created_at,
    floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
  ) ON CONFLICT (event_id) DO NOTHING;
  RETURN NULL;
END
$function$;
CREATE TRIGGER job_events_outbox_after_insert
  AFTER INSERT ON uap.job_events
  FOR EACH ROW EXECUTE FUNCTION uap.job_events_enqueue_outbox();

CREATE FUNCTION uap.claim_job_outbox(
  p_relay_id text,
  p_limit integer,
  p_lock_ms bigint
)
RETURNS TABLE(
  event_id text,
  organization_id text,
  job_id text,
  seq bigint,
  event_type text,
  payload jsonb,
  provenance jsonb,
  trace_id text,
  attempts integer,
  created_at bigint
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, uap
SET row_security = on
AS $function$
DECLARE
  v_now bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
BEGIN
  IF p_relay_id IS NULL OR length(p_relay_id) NOT BETWEEN 1 AND 200
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500
    OR p_lock_ms IS NULL OR p_lock_ms NOT BETWEEN 1000 AND 600000 THEN
    RAISE EXCEPTION USING ERRCODE='P0003', MESSAGE='outbox claim input is invalid';
  END IF;
  RETURN QUERY
  WITH deliverable AS (
    SELECT outbox.event_id
    FROM uap.job_outbox AS outbox
    WHERE outbox.published_at IS NULL
      AND outbox.dead_lettered_at IS NULL
      AND outbox.next_attempt_at <= v_now
      AND (outbox.locked_by IS NULL OR outbox.locked_until <= v_now)
    ORDER BY outbox.next_attempt_at, outbox.created_at, outbox.event_id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  ), locked AS (
    UPDATE uap.job_outbox AS outbox
    SET locked_by=p_relay_id, locked_until=v_now+p_lock_ms
    FROM deliverable
    WHERE outbox.event_id=deliverable.event_id
    RETURNING outbox.event_id, outbox.organization_id, outbox.job_id, outbox.seq,
      outbox.event_type, outbox.attempts, outbox.created_at
  )
  SELECT locked.event_id, locked.organization_id, locked.job_id, locked.seq,
    locked.event_type, event.payload, event.provenance, event.trace_id,
    locked.attempts, locked.created_at
  FROM locked
  JOIN uap.job_events AS event
    ON event.organization_id=locked.organization_id AND event.event_id=locked.event_id
  ORDER BY locked.created_at, locked.event_id;
END
$function$;

CREATE FUNCTION uap.mark_job_outbox_published(
  p_event_id text,
  p_relay_id text
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, uap
SET row_security = on
AS $function$
DECLARE
  v_now bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
BEGIN
  IF p_event_id IS NULL OR length(p_event_id) NOT BETWEEN 1 AND 200
    OR p_relay_id IS NULL OR length(p_relay_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION USING ERRCODE='P0003', MESSAGE='outbox mark input is invalid';
  END IF;
  UPDATE uap.job_outbox
  SET published_at=v_now, locked_by=NULL, locked_until=NULL, last_error=NULL
  WHERE event_id=p_event_id AND locked_by=p_relay_id
    AND published_at IS NULL AND dead_lettered_at IS NULL;
  RETURN FOUND;
END
$function$;

CREATE FUNCTION uap.release_job_outbox(
  p_event_id text,
  p_relay_id text,
  p_retry_in_ms bigint,
  p_error text,
  p_max_attempts integer
)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, uap
SET row_security = on
AS $function$
DECLARE
  v_now bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  selected uap.job_outbox%ROWTYPE;
  next_attempts integer;
BEGIN
  IF p_event_id IS NULL OR length(p_event_id) NOT BETWEEN 1 AND 200
    OR p_relay_id IS NULL OR length(p_relay_id) NOT BETWEEN 1 AND 200
    OR p_retry_in_ms IS NULL OR p_retry_in_ms NOT BETWEEN 0 AND 3600000
    OR p_max_attempts IS NULL OR p_max_attempts NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION USING ERRCODE='P0003', MESSAGE='outbox release input is invalid';
  END IF;
  SELECT * INTO selected FROM uap.job_outbox WHERE event_id=p_event_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'missing'; END IF;
  IF selected.locked_by IS DISTINCT FROM p_relay_id THEN RETURN 'stale'; END IF;
  IF selected.published_at IS NOT NULL OR selected.dead_lettered_at IS NOT NULL THEN RETURN 'settled'; END IF;
  next_attempts := selected.attempts + 1;
  IF next_attempts >= p_max_attempts THEN
    UPDATE uap.job_outbox
    SET attempts=next_attempts, locked_by=NULL, locked_until=NULL,
      dead_lettered_at=v_now, last_error=left(coalesce(p_error,''),4096)
    WHERE event_id=p_event_id;
    RETURN 'dead';
  END IF;
  UPDATE uap.job_outbox
  SET attempts=next_attempts, locked_by=NULL, locked_until=NULL,
    next_attempt_at=v_now+p_retry_in_ms, last_error=left(coalesce(p_error,''),4096)
  WHERE event_id=p_event_id;
  RETURN 'retry';
END
$function$;

-- Truthful delivery state for the worker health surface (V6-06-12 input).
CREATE FUNCTION uap.job_outbox_state()
RETURNS TABLE(
  pending bigint,
  locked bigint,
  published bigint,
  dead_lettered bigint,
  oldest_pending_at bigint,
  oldest_pending_age_ms bigint
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, uap
SET row_security = on
AS $function$
DECLARE
  v_now bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
BEGIN
  RETURN QUERY
  SELECT
    count(*) FILTER (WHERE published_at IS NULL AND dead_lettered_at IS NULL),
    count(*) FILTER (WHERE published_at IS NULL AND dead_lettered_at IS NULL AND locked_by IS NOT NULL),
    count(*) FILTER (WHERE published_at IS NOT NULL),
    count(*) FILTER (WHERE dead_lettered_at IS NOT NULL),
    min(created_at) FILTER (WHERE published_at IS NULL AND dead_lettered_at IS NULL),
    CASE WHEN min(created_at) FILTER (WHERE published_at IS NULL AND dead_lettered_at IS NULL) IS NULL
      THEN NULL ELSE v_now - min(created_at) FILTER (WHERE published_at IS NULL AND dead_lettered_at IS NULL) END
  FROM uap.job_outbox;
END
$function$;

REVOKE ALL ON FUNCTION
  uap.job_events_enqueue_outbox(),
  uap.claim_job_outbox(text,integer,bigint),
  uap.mark_job_outbox_published(text,text),
  uap.release_job_outbox(text,text,bigint,text,integer),
  uap.job_outbox_state()
FROM PUBLIC;
`,
};

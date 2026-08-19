CREATE TABLE growth_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  event_type text NOT NULL CHECK (
    event_type IN (
      'PAYMENT_SETTLED_SENT',
      'PAYMENT_SETTLED_RECEIVED'
    )
  ),

  actor_account_id uuid NOT NULL
    REFERENCES accounts(account_id)
    ON DELETE RESTRICT,

  source_domain text NOT NULL CHECK (
    source_domain IN ('PAYMENT')
  ),

  source_id text NOT NULL
    CHECK (
      length(source_id) BETWEEN 1 AND 128
      AND btrim(source_id) = source_id
    ),

  source_event_id text NOT NULL
    CHECK (
      length(source_event_id) BETWEEN 1 AND 128
      AND btrim(source_event_id) = source_event_id
    ),

  occurred_at timestamptz NOT NULL,

  synthetic boolean NOT NULL,

  schema_version smallint NOT NULL
    CHECK (schema_version = 1),

  context jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(context) = 'object'),

  recorded_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT growth_events_source_actor_unique
    UNIQUE (
      source_domain,
      source_id,
      source_event_id,
      event_type,
      actor_account_id
    )
);

CREATE INDEX growth_events_actor_time_idx
  ON growth_events (
    actor_account_id,
    occurred_at DESC,
    event_id DESC
  );

CREATE INDEX growth_events_source_idx
  ON growth_events (
    source_domain,
    source_id,
    source_event_id
  );

CREATE FUNCTION reject_growth_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'growth events are append-only';
END;
$$;

CREATE TRIGGER growth_events_append_only
  BEFORE UPDATE OR DELETE ON growth_events
  FOR EACH ROW
  EXECUTE FUNCTION reject_growth_event_mutation();

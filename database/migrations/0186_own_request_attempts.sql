CREATE TABLE own_request_attempts (
  id text PRIMARY KEY,
  source_id text,
  url text NOT NULL,
  phase text NOT NULL,
  http_status integer,
  response bytea,
  response_sha256 text,
  error text,
  note text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK (phase IN ('started', 'succeeded', 'failed', 'unverified'))
);

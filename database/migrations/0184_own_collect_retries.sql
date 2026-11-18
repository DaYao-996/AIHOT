CREATE TABLE own_collect_retries (
  source_id text NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  identity_key text NOT NULL,
  url text NOT NULL,
  state text NOT NULL CHECK (state IN ('retryable', 'page_has_no_time')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, identity_key)
);

CREATE TABLE own_detail_responses (
  source_id text NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  url text NOT NULL,
  http_status integer,
  response bytea,
  response_sha256 text NOT NULL,
  truncated boolean NOT NULL DEFAULT false,
  extracted_bytes integer,
  extraction_note text,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, url, fetched_at)
);

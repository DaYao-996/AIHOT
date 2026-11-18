-- Append-only evidence for one article. A later supplement inserts a new version
-- and leaves every earlier raw payload in place.
CREATE TABLE own_evidence_versions (
  article_id text NOT NULL REFERENCES articles (id),
  version integer NOT NULL CHECK (version >= 1),
  article_revision integer NOT NULL,
  raw jsonb,
  body_text text,
  quoted_text text,
  x_post jsonb,
  evidence_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (article_id, version)
);

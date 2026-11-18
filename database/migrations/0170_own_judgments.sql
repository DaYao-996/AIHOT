-- Own selection judgements, stored apart from the editorial judgement rows.
-- A row is one identity of article revision, evidence, ruleset, prompt and model.
-- It never grants publication.
CREATE TABLE own_judgments (
  id text PRIMARY KEY,
  article_id text NOT NULL REFERENCES articles (id),
  input_revision integer NOT NULL,
  evidence_hash text NOT NULL,
  ruleset_version text NOT NULL,
  prompt_version text,
  model_version text,
  information_type_id text,
  content_line text CHECK (content_line IN ('line1', 'line2')),
  material_status text NOT NULL CHECK (material_status IN ('complete', 'missing_body', 'missing_quote', 'missing_article_body')),
  fact_status text NOT NULL CHECK (fact_status IN ('unchecked', 'source_claim', 'checked')),
  value_status text NOT NULL CHECK (value_status IN ('incomplete_material', 'reference_only')),
  release_status text NOT NULL DEFAULT 'not_licensed' CHECK (release_status = 'not_licensed'),
  reasons jsonb NOT NULL,
  stale boolean NOT NULL DEFAULT false,
  recorded_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (article_id, input_revision, evidence_hash, ruleset_version, prompt_version, model_version),
  CHECK (material_status = 'complete' OR value_status = 'incomplete_material')
);

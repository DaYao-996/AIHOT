-- Where a judgement came from. Deterministic rules may omit model versions.
-- A model judgement still has to name its prompt and model in those columns.
ALTER TABLE own_judgments ADD COLUMN origin text NOT NULL DEFAULT 'deterministic';

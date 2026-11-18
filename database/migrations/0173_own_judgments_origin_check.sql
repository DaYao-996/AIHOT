ALTER TABLE own_judgments ADD CONSTRAINT own_judgments_origin_check CHECK (origin IN ('deterministic', 'model') AND (origin <> 'model' OR (prompt_version <> '' AND model_version <> ''))) NOT VALID;

-- File-byte hash and canonical JSON hash stay side by side. Neither replaces the other.
ALTER TABLE own_evidence_versions ADD COLUMN raw_identity jsonb;

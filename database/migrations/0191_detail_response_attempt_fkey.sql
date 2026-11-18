ALTER TABLE own_detail_responses ADD CONSTRAINT own_detail_responses_attempt_id_fkey FOREIGN KEY (attempt_id) REFERENCES own_request_attempts (id) NOT VALID;

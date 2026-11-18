ALTER TABLE own_request_attempts ADD CONSTRAINT own_request_attempts_article_id_fkey FOREIGN KEY (article_id) REFERENCES articles (id) NOT VALID;

-- AiFlows: allow storing captured page source (raw HTML) next to screenshots in
-- the same private `aiflow-screenshots` bucket. The run "investigate" view links
-- a "View page source" URL for each step screenshot so an owner can inspect the
-- exact markup behind a failure (e.g. why a selector no longer matched).
--
-- Stored as text/plain (not text/html) so the browser shows the raw markup and
-- never executes the captured third-party page when the owner opens the signed
-- URL. Only the service role writes the bucket and it stays private, so no RLS
-- changes are needed.

update storage.buckets
set allowed_mime_types = array['image/jpeg', 'text/plain']
where id = 'aiflow-screenshots';

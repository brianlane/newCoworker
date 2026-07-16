-- Allow WebVTT meeting transcripts (Zoom/Meet/Teams recording transcripts)
-- into the business-docs bucket. The upload routes canonicalize .vtt files
-- to text/vtt (browsers often report "" or application/octet-stream for
-- them) and the ingest/agent pipelines convert cue soup into readable
-- "Speaker: sentence" text before prompting.
update storage.buckets
set allowed_mime_types = array[
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/vtt'
]
where id = 'business-docs';

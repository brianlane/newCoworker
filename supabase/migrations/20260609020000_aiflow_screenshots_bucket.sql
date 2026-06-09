-- AiFlows: private storage bucket for browse_extract screenshots.
--
-- The ai-flow-worker (service role) uploads a JPEG of the browsed lead page to
-- `${businessId}/${runId}/step-${index}.jpg`, publishes a 7-day signed URL as
-- {{vars.screenshot_url}}, and the send_email step downloads by path to attach
-- it. No RLS policies are added on storage.objects for this bucket: only the
-- service role reads/writes it, and the bucket is private, so client access
-- stays denied by default.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'aiflow-screenshots',
  'aiflow-screenshots',
  false,
  10485760, -- 10 MB, comfortably above the render service's height-capped JPEGs
  array['image/jpeg']
)
on conflict (id) do nothing;

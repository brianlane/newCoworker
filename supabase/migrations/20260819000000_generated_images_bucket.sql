-- AI image generation: private storage bucket for coworker-generated images.
--
-- The platform (service role) uploads generated images to
-- `${businessId}/${uuid}.png`. Dashboard chat reads them through the
-- owner-authenticated proxy route (/api/dashboard/images/*); MMS delivery
-- publishes a short-TTL signed URL for Telnyx to fetch. No RLS policies are
-- added on storage.objects for this bucket: only the service role
-- reads/writes it, and the bucket is private, so client access stays denied
-- by default (same posture as aiflow-screenshots).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'generated-images',
  'generated-images',
  false,
  20971520, -- 20 MB, comfortably above a 1K PNG
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do nothing;

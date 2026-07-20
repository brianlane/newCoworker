-- Published Instagram posts keep their public permalink so the dashboard
-- can link straight to the post (fetched best-effort after media_publish).
alter table public.social_posts
  add column if not exists ig_permalink text;

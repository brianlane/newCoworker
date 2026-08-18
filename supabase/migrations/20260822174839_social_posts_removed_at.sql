-- A published Instagram post can be deleted on Instagram's side, and until
-- now nothing ever noticed: the row stayed `published` forever with a
-- permalink that 404s, so the Marketing page kept showing a post that no
-- longer exists.
--
-- `removed_at` records when our sweep first saw Meta report the media as
-- gone. Deliberately a timestamp beside the status rather than a new status
-- value: the post WAS published (that history is true and worth keeping),
-- and every existing query that filters on status keeps working untouched.
--
-- Column-only change: social_posts already carries its Data API grants.

alter table public.social_posts
  add column if not exists removed_at timestamptz,
  add column if not exists removed_check_at timestamptz;

comment on column public.social_posts.removed_at is
  'Set when the publish sweep saw Meta report this media as gone (owner deleted the post on Instagram). Null while the post is still live. Only a definitive Meta error code 100 sets this: a timeout, 5xx, rate limit, or expired token must never mark a live post removed.';

comment on column public.social_posts.removed_check_at is
  'When the sweep last asked Meta whether this media still exists, stamped on every look including inconclusive ones and skips. Rotating the queue by this column is what stops one disconnected tenant''s posts from filling every batch forever.';

-- The sweep runs every minute; the re-check pass takes the stalest few rows
-- that are still live and past their re-check interval, so it must reach
-- them without a full table scan.
create index if not exists idx_social_posts_recheck_queue
  on public.social_posts (removed_check_at nulls first, published_at desc)
  where removed_at is null and ig_media_id is not null and status = 'published';

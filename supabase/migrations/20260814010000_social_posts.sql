-- ---------------------------------------------------------------------------
-- Instagram content publishing: owner-scheduled posts on the Marketing page.
--
--   social_posts - one row per post: caption + image URL, a draft →
--                  scheduled → publishing → published lifecycle (or
--                  failed / cancelled), and the published IG media id.
--                  Published via the Instagram Graph API two-step
--                  (media container → media_publish) using the tenant's
--                  meta_connections page token and linked IG professional
--                  account.
--
-- Security posture: RLS on with NO policies — service-role only, identical
-- to email_campaigns. Every access goes through the Next.js server after
-- its own auth checks.
--
-- Call chain for publishing (mirrors the email-campaign sweep):
--   pg_cron (per minute) → Edge `social-post-sweep`
--                        → Next.js POST /api/internal/social-post-sweep
--                        → src/lib/social/publish.ts (Graph API)
-- ---------------------------------------------------------------------------

create table if not exists public.social_posts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  caption text not null default '',
  -- Publicly fetchable image URL (Meta downloads it server-side). v1 is
  -- single-image feed posts; reels/carousels extend media_type later.
  media_url text not null,
  media_type text not null default 'image' check (media_type in ('image')),
  status text not null default 'draft'
    check (status in ('draft', 'scheduled', 'publishing', 'published', 'failed', 'cancelled')),
  publish_at timestamptz,
  started_at timestamptz,
  published_at timestamptz,
  -- The media container (creation) id from publish step 1. Persisted BEFORE
  -- media_publish so an interrupted publish can be resolved truthfully: the
  -- stale sweep checks the container's status_code with Meta instead of
  -- guessing whether the post went live.
  ig_creation_id text,
  -- The IG media id Meta returns on publish — the permalink handle.
  ig_media_id text,
  error_detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_social_posts_business
  on public.social_posts (business_id, created_at desc);

-- The sweep's due-scan: scheduled posts whose publish time has passed, plus
-- posts mid-publish (crash recovery).
create index if not exists idx_social_posts_due
  on public.social_posts (status, publish_at);

alter table public.social_posts enable row level security;
-- No policies: service_role bypasses RLS; anon/authenticated denied by design.

comment on table public.social_posts is
  'Owner-composed Instagram posts. draft → scheduled → publishing → published lifecycle; the per-minute social-post-sweep promotes due posts and publishes them through the Instagram Graph API (container → media_publish) with the tenant''s meta_connections page token.';
comment on column public.social_posts.ig_media_id is
  'Instagram media id returned by media_publish. Null until published.';

-- ---------------------------------------------------------------------------
-- Schedule the sweep (mirrors 20260811173000_email_campaigns): per minute —
-- publishing is a two-Graph-call pipeline, so cadence is the pace.
-- ---------------------------------------------------------------------------

do $unschedule$
begin
  perform cron.unschedule('edge-social-post-sweep')
  where exists (
    select 1 from cron.job where jobname = 'edge-social-post-sweep'
  );
end
$unschedule$;

select cron.schedule(
  'edge-social-post-sweep',
  '* * * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/social-post-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 280000
  );
  $$
);

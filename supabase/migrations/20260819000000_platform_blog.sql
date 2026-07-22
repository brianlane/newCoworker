-- ---------------------------------------------------------------------------
-- Platform blog: DB-backed posts on newcoworker.com/blog.
--
--   blog_posts       - one row per post: markdown content + optional Spanish
--                      translation, category, featured image (blog-images
--                      bucket), and a draft → scheduled → published
--                      lifecycle. `source`/`digest_week` mark the weekly
--                      auto-generated PR-digest posts (digest_week unique =
--                      cron idempotency).
--   blog_settings    - single fixed row of operator toggles: the weekly
--                      digest (enabled / draft-instead-of-schedule / image)
--                      and the Instagram cross-post (which business's
--                      composer receives it, publish immediately vs draft).
--   blog_subscribers - emails collected by the public subscribe box; each
--                      publish fans out a notification with a tokenized
--                      one-click unsubscribe.
--
-- Security posture: RLS on with NO policies — service-role only, identical
-- to social_posts / email_campaigns. Every access goes through the Next.js
-- server after its own auth checks (public pages read published rows
-- server-side; admin CRUD sits behind requireAdmin).
--
-- Call chains:
--   pg_cron (5 min)  → Edge `blog-publish-sweep`  → POST /api/internal/blog-publish-sweep
--   pg_cron (weekly) → Edge `blog-weekly-digest`  → POST /api/internal/blog-weekly-digest
-- ---------------------------------------------------------------------------

create table if not exists public.blog_posts (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  excerpt text not null default '',
  content text not null default '',
  -- Optional Spanish translation: the post appears on /es/blog only when
  -- translated; untranslated posts fall back to English there.
  title_es text,
  excerpt_es text,
  content_es text,
  category text not null default 'announcement'
    check (category in ('feature', 'tutorial', 'announcement', 'business-tips', 'spotlight', 'platform-updates')),
  author_name text not null default 'New Coworker Team',
  status text not null default 'draft'
    check (status in ('draft', 'scheduled', 'published')),
  published_at timestamptz,
  scheduled_for timestamptz,
  -- Storage path within the public blog-images bucket, e.g. `<uuid>.png`.
  featured_image_path text,
  featured_image_alt text,
  source text not null default 'manual'
    check (source in ('manual', 'weekly_digest')),
  -- ISO week key (e.g. 2026-W30) for weekly-digest posts; unique so the
  -- digest cron is idempotent per week.
  digest_week text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_blog_posts_published
  on public.blog_posts (status, published_at desc);

-- The publish sweep's due-scan: scheduled posts whose time has passed.
create index if not exists idx_blog_posts_due
  on public.blog_posts (status, scheduled_for);

create unique index if not exists uq_blog_posts_digest_week
  on public.blog_posts (digest_week)
  where digest_week is not null;

alter table public.blog_posts enable row level security;
-- No policies: service_role bypasses RLS; anon/authenticated denied by design.

comment on table public.blog_posts is
  'newcoworker.com blog posts (markdown + optional Spanish translation). draft → scheduled → published lifecycle; the 5-minute blog-publish-sweep promotes due posts and runs publish side effects (subscriber email + Instagram cross-post). source=weekly_digest rows are created by the weekly PR-digest cron, idempotent per digest_week.';

-- Single fixed row (id must be true) of operator toggles.
create table if not exists public.blog_settings (
  id boolean primary key default true check (id),
  digest_enabled boolean not null default true,
  digest_as_draft boolean not null default false,
  digest_include_image boolean not null default true,
  -- The business whose Marketing composer receives the Instagram cross-post
  -- (normally the internal HQ tenant). Null = cross-posting off.
  instagram_business_id uuid references public.businesses(id) on delete set null,
  -- Off (default) = the cross-post lands as a composer DRAFT for human
  -- review; on = it is scheduled immediately and the social-post-sweep
  -- publishes it straight to Instagram.
  instagram_publish_immediately boolean not null default false,
  updated_at timestamptz not null default now()
);

insert into public.blog_settings (id) values (true)
on conflict (id) do nothing;

alter table public.blog_settings enable row level security;
-- No policies: service_role only.

comment on table public.blog_settings is
  'Single-row operator toggles for the platform blog: weekly PR-digest behavior and the Instagram cross-post target/mode.';

create table if not exists public.blog_subscribers (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  locale text not null default 'en' check (locale in ('en', 'es')),
  unsubscribe_token text not null unique,
  created_at timestamptz not null default now(),
  unsubscribed_at timestamptz
);

alter table public.blog_subscribers enable row level security;
-- No policies: service_role only.

comment on table public.blog_subscribers is
  'Public blog-notification opt-ins. Each publish emails active subscribers with a tokenized one-click unsubscribe; unsubscribed_at set = suppressed.';

-- Public bucket for featured images: the marketing site serves them
-- directly and Meta downloads them server-side for Instagram cross-posts.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'blog-images',
  'blog-images',
  true,
  10485760, -- 10 MB
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Schedule the sweeps (mirrors 20260814010000_social_posts).
--   blog-publish-sweep: every 5 minutes — scheduled posts publish on a
--   5-minute grain, which is plenty for a blog.
--   blog-weekly-digest: Mondays 15:00 UTC (~8am Phoenix) — summarizes the
--   prior week's merged PRs when they clear the volume bar.
-- ---------------------------------------------------------------------------

do $unschedule$
begin
  perform cron.unschedule('edge-blog-publish-sweep')
  where exists (
    select 1 from cron.job where jobname = 'edge-blog-publish-sweep'
  );
  perform cron.unschedule('edge-blog-weekly-digest')
  where exists (
    select 1 from cron.job where jobname = 'edge-blog-weekly-digest'
  );
end
$unschedule$;

select cron.schedule(
  'edge-blog-publish-sweep',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/blog-publish-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 280000
  );
  $$
);

select cron.schedule(
  'edge-blog-weekly-digest',
  '0 15 * * 1',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/blog-weekly-digest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 280000
  );
  $$
);

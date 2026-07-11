-- Tracked SMS short links (concept ported from BizBlasts' SmsLinkShortener).
--
-- Outbound lead-facing texts rewrite long URLs to `<app>/s/<code>` redirects
-- so link engagement is measurable per business / flow / run. Rows are
-- written ONLY by the platform's own send paths (AiFlow send_sms step, voice
-- send_follow_up_sms tool) from owner-authored message bodies; the public
-- redirect route resolves + counts clicks through the service-role RPC below.
--
-- Security posture matches the other service-role-only content tables
-- (calendly_connections, sms_outbound_log): RLS on with NO policies —
-- anon/authenticated get an unconditional deny; every access goes through
-- the Next.js server / Edge worker with the service role.

create table if not exists public.sms_links (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  short_code text not null,
  original_url text not null,
  -- Recipient (customer-side) number when the send had a single destination;
  -- null for group sends.
  to_e164 text,
  -- Send surface, mirroring sms_outbound_log.source ('ai_flow',
  -- 'voice_follow_up', ...).
  source text not null default 'ai_flow',
  -- AiFlow attribution — the flow-funnel analytics read clicks per flow.
  flow_id uuid,
  run_id uuid,
  click_count integer not null default 0,
  first_clicked_at timestamptz,
  last_clicked_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists uq_sms_links_short_code
  on public.sms_links (short_code);

create index if not exists idx_sms_links_business_created
  on public.sms_links (business_id, created_at desc);

-- Funnel aggregation scans clicks per flow; partial index keeps it cheap
-- (voice follow-ups carry no flow).
create index if not exists idx_sms_links_flow
  on public.sms_links (flow_id)
  where flow_id is not null;

alter table public.sms_links enable row level security;
-- No policies: service_role bypasses RLS; anon/authenticated get an
-- unconditional deny by design (see README "RLS enabled, no policies").

-- Atomic click: increment + stamp + resolve in one statement so concurrent
-- clicks never lose counts. Returns {ok:false} for unknown codes so the
-- redirect route can fall back to the homepage without a second query.
create or replace function public.sms_link_click(p_short_code text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_url text;
begin
  if p_short_code is null or length(trim(p_short_code)) = 0 then
    return jsonb_build_object('ok', false);
  end if;

  update public.sms_links
     set click_count = click_count + 1,
         first_clicked_at = coalesce(first_clicked_at, now()),
         last_clicked_at = now()
   where short_code = trim(p_short_code)
   returning original_url into v_url;

  if v_url is null then
    return jsonb_build_object('ok', false);
  end if;

  return jsonb_build_object('ok', true, 'url', v_url);
end;
$$;

revoke execute on function public.sms_link_click(text) from public;
revoke execute on function public.sms_link_click(text) from anon, authenticated;
grant execute on function public.sms_link_click(text) to service_role;

comment on table public.sms_links is
  'Tracked short links embedded in outbound SMS (/s/<code> redirects). Service-role only; click counts feed per-flow conversion analytics.';

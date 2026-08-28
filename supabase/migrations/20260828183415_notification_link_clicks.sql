-- Capture the owner/teammate click we already collect and throw away.
--
-- Owner alerts carry a shortened dashboard link, and that link resolves
-- through our own /s/<code> redirect. 20260822074746 added
-- `sms_links.tracked` so those redirects work WITHOUT being counted: an
-- owner clicking his own alert is not lead engagement, and counting it would
-- inflate the exact click-through numbers the flow funnels report.
--
-- That decision was right for analytics and it is why the click is
-- discarded. But an owner click is the strongest evidence available anywhere
-- in this system: it proves a specific human opened a specific alert that
-- arrived on a specific channel. Delivery receipts cannot make that claim,
-- and a reply cannot either (an owner who reads every alert and never
-- answers looks identical to one who has stopped receiving them).
--
-- So: record it in its OWN table, strictly outside the lead funnel that
-- `tracked` exists to protect. Nothing in src/lib/analytics or
-- src/lib/db/sms-links.ts reads this table, and nothing should; its only
-- consumer is the channel-liveness check.
--
-- PREFETCH IS CARRIED OVER DELIBERATELY. The tracked path flags clicks
-- inside a 60-second window after send, because messaging apps and carrier
-- security scanners fetch every link on delivery, in production within
-- seconds. Recording those as human attention would manufacture precisely
-- the false liveness signal this feature exists to eliminate, so the flag is
-- stored here too and the liveness read excludes it. (The route's
-- link-preview-bot and HEAD short-circuits are the first layer; this is the
-- second, and neither is sufficient alone.)

create table if not exists public.notification_link_clicks (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  link_id uuid not null references public.sms_links(id) on delete cascade,
  -- Which of the owner's channels carried the alert. Every row is 'sms'
  -- today because sms_links IS the SMS shortener and the untracked rows are
  -- only ever written by the owner_notify / team-alert send paths. The
  -- column exists so the liveness read can filter by channel from the start
  -- rather than assuming, since assuming is how the WhatsApp leg of this
  -- same check first read a lead's message as the owner's.
  channel text not null default 'sms',
  -- The sms_links.source that created the link, e.g. 'owner_notify'.
  --
  -- NO RECIPIENT COLUMN, deliberately. Copying to_e164 here was the obvious
  -- shape and it is the wrong one: the liveness check asks "did a human on
  -- this tenant's alert audience open an alert", which the link_id already
  -- answers, so a phone number would be staff PII stored for no reader. Its
  -- absence also keeps this table on exactly the footing sms_link_clicks
  -- already has with the privacy guard (FK cascade from sms_links, no person
  -- columns of its own), instead of opening a second erasure surface.
  source text,
  clicked_at timestamptz not null default now(),
  -- True when the click landed inside the post-send prefetch window: a
  -- link-preview card or a carrier scanner, not a person. Stored, never
  -- counted as a human signal.
  likely_prefetch boolean not null default false
);

comment on table public.notification_link_clicks is
  'Owner/teammate taps on UNTRACKED notification short links. Deliberately separate from sms_link_clicks: these are never lead engagement and must never reach the flow funnel reads that sms_links.tracked protects. Read only by the channel-liveness check.';

create index if not exists notification_link_clicks_business_clicked_idx
  on public.notification_link_clicks (business_id, clicked_at desc);

alter table public.notification_link_clicks enable row level security;

-- Service-role only, RLS on with zero policies: the default posture. The
-- owner has no reason to read their own click log, and the tenant-facing
-- surfaces must not learn this table exists.
grant select, insert, update, delete on table public.notification_link_clicks to service_role;

-- Click RPC: the untracked branch now records the click before it returns.
--
-- Unchanged from 20260822074746 apart from that insert. Every guarantee the
-- untracked branch made still holds: no sms_link_clicks row, no click_count
-- bump, no first/last_clicked_at, no notified_at stamp, should_notify
-- explicitly false. The analytics reads see exactly what they saw before.
create or replace function public.sms_link_click(p_short_code text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_link public.sms_links%rowtype;
  v_is_first boolean;
  v_is_prefetch boolean;
  v_should_notify boolean;
  c_prefetch_window interval := interval '60 seconds';
begin
  if p_short_code is null or length(trim(p_short_code)) = 0 then
    return jsonb_build_object('ok', false);
  end if;

  select * into v_link
    from public.sms_links
   where short_code = trim(p_short_code)
   for update;

  if not found then
    return jsonb_build_object('ok', false);
  end if;

  -- Untracked (owner/teammate) link: record the human signal, then get out.
  -- The prefetch window is evaluated the same way as on the tracked path, so
  -- a preview card fetched on delivery is stored flagged rather than counted.
  if not v_link.tracked then
    insert into public.notification_link_clicks
      (business_id, link_id, channel, source, likely_prefetch)
    values (
      v_link.business_id,
      v_link.id,
      'sms',
      v_link.source,
      (now() - v_link.created_at) < c_prefetch_window
    );
    return jsonb_build_object(
      'ok', true,
      'url', v_link.original_url,
      'business_id', v_link.business_id,
      'link_id', v_link.id,
      'short_code', v_link.short_code,
      'should_notify', false,
      'tracked', false
    );
  end if;

  v_is_first := (v_link.click_count = 0);
  v_is_prefetch := (now() - v_link.created_at) < c_prefetch_window;
  v_should_notify := (not v_is_prefetch) and v_link.notified_at is null;

  insert into public.sms_link_clicks (link_id, business_id, likely_prefetch)
  values (v_link.id, v_link.business_id, v_is_prefetch);

  update public.sms_links
     set click_count = click_count + 1,
         first_clicked_at = coalesce(first_clicked_at, now()),
         last_clicked_at = now(),
         notified_at = case when v_should_notify then now() else notified_at end
   where id = v_link.id;

  return jsonb_build_object(
    'ok', true,
    'url', v_link.original_url,
    'business_id', v_link.business_id,
    'link_id', v_link.id,
    'short_code', v_link.short_code,
    'click_count', v_link.click_count + 1,
    'to_e164', v_link.to_e164,
    'original_url', v_link.original_url,
    'flow_id', v_link.flow_id,
    'run_id', v_link.run_id,
    'is_first_click', v_is_first,
    'is_prefetch', v_is_prefetch,
    'should_notify', v_should_notify,
    'tracked', true
  );
end;
$$;

revoke execute on function public.sms_link_click(text) from public;
revoke execute on function public.sms_link_click(text) from anon, authenticated;
grant execute on function public.sms_link_click(text) to service_role;

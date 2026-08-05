-- Untracked short links for owner and teammate notifications.
--
-- Owner alerts (notify_owner / notify_lead_owner) never carried a link at all:
-- the text told Brian a sales email had arrived and left him to go find it.
-- Adding one means shortening it, or a Gmail permalink turns a one-segment
-- alert into two. But the existing shortener is a TRACKING shortener, and the
-- owner clicking his own alert is not lead engagement. Counting it would
-- inflate exactly the click-through numbers the flow funnels report
-- (src/lib/analytics/sms-link-stats.ts), which is why the send path had
-- deliberately excluded teammate texts from shortening entirely.
--
-- `tracked` splits the two concerns: shortening for length, tracking for
-- engagement. An untracked link redirects normally and records nothing.

alter table public.sms_links
  add column if not exists tracked boolean not null default true;

comment on column public.sms_links.tracked is
  'False for owner/teammate notification links: the /s/ redirect works, but the click is never logged, counted, or alerted on, and the analytics reads skip the row. True (the default) is the lead-facing tracked link.';

-- Click RPC: short-circuit an untracked link before it can touch any stats.
--
-- Unchanged from 20260814030000 apart from the untracked branch. Everything
-- after it (prefetch window, notified_at stamping, should_notify) is the
-- tracked path exactly as it was.
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

  -- Untracked (owner/teammate) link: resolve and get out. No sms_link_clicks
  -- row, no click_count bump, no first/last_clicked_at, no notified_at stamp.
  -- should_notify is returned explicitly false rather than left absent: the
  -- route's alert gate reads it, and "the key happens not to be there" is a
  -- fragile thing for a no-alert guarantee to rest on.
  if not v_link.tracked then
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

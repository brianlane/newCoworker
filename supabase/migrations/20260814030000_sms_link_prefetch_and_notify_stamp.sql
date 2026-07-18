-- Truthful link-click owner alerts (Jul 18 incident: three "opened your
-- booking link" alerts fired for link-preview PREFETCH hits seconds after
-- delivery — machines, not the lead).
--
--   - sms_links.notified_at: the alert-dedupe stamp. Replaces the old
--     "notify on the first click" rule (is_first_click), which broke once
--     prefetch suppression existed — if the first click is a suppressed
--     prefetch, that link would never alert. Now: the first NON-prefetch
--     click notifies, exactly once, stamped atomically inside the RPC.
--   - sms_link_clicks.likely_prefetch: clicks inside the prefetch window are
--     still logged (honest raw data) but flagged, so the dashboard timeline
--     and CSV can label them and the alert path can ignore them.
--   - sms_link_click RPC: computes the prefetch window server-side and
--     returns should_notify; known preview-bot user agents never reach this
--     RPC at all (the route resolves them without counting).

alter table public.sms_links
  add column if not exists notified_at timestamptz;

alter table public.sms_link_clicks
  add column if not exists likely_prefetch boolean not null default false;

comment on column public.sms_links.notified_at is
  'When the owner was alerted about this link''s first human-looking click. Null = not yet alerted.';
comment on column public.sms_link_clicks.likely_prefetch is
  'Click landed within the prefetch window of the link''s creation — almost certainly a link-preview/scanner fetch on delivery, not a human tap.';

-- Clicks within this many seconds of the link being minted are treated as
-- delivery-time preview prefetch (observed: 3-16s after send in production).
-- Atomic click: log event (flagged), increment aggregate, and decide the
-- owner alert in one locked transaction. should_notify is true exactly once
-- per link — for the first click outside the prefetch window — because
-- notified_at is stamped in the same statement that reports it.
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
    'should_notify', v_should_notify
  );
end;
$$;

revoke execute on function public.sms_link_click(text) from public;
revoke execute on function public.sms_link_click(text) from anon, authenticated;
grant execute on function public.sms_link_click(text) to service_role;

-- Backfill: links that already alerted under the old first-click rule must
-- not alert again when their next human click arrives.
update public.sms_links
   set notified_at = first_clicked_at
 where notified_at is null
   and first_clicked_at is not null;

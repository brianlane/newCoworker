-- Per-click SMS link event log + exact outbound-message pairing.
--
-- sms_links.sms_outbound_log_id ties each tracked short link to the
-- sms_outbound_log row for the SMS that contained it (nullable: links mint
-- before the log row exists; residency-moved outbound rows may not backfill).
--
-- sms_link_clicks records every redirect hop; sms_link_click RPC is extended
-- to insert an event row and return metadata for owner notifications.

alter table public.sms_links
  add column if not exists sms_outbound_log_id uuid
    references public.sms_outbound_log(id) on delete set null;

create index if not exists idx_sms_links_outbound_log
  on public.sms_links (sms_outbound_log_id)
  where sms_outbound_log_id is not null;

create table if not exists public.sms_link_clicks (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references public.sms_links(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  clicked_at timestamptz not null default now()
);

create index if not exists idx_sms_link_clicks_link
  on public.sms_link_clicks (link_id, clicked_at desc);

create index if not exists idx_sms_link_clicks_business
  on public.sms_link_clicks (business_id, clicked_at desc);

alter table public.sms_link_clicks enable row level security;
-- No policies: service_role only (same posture as sms_links).

comment on table public.sms_link_clicks is
  'Per-click event log for tracked SMS short links (/s/<code> redirects). Service-role only.';

-- Atomic click: log event, increment aggregate, return metadata for notifications.
create or replace function public.sms_link_click(p_short_code text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_link public.sms_links%rowtype;
  v_is_first boolean;
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

  insert into public.sms_link_clicks (link_id, business_id)
  values (v_link.id, v_link.business_id);

  update public.sms_links
     set click_count = click_count + 1,
         first_clicked_at = coalesce(first_clicked_at, now()),
         last_clicked_at = now()
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
    'is_first_click', v_is_first
  );
end;
$$;

revoke execute on function public.sms_link_click(text) from public;
revoke execute on function public.sms_link_click(text) from anon, authenticated;
grant execute on function public.sms_link_click(text) to service_role;

-- §7: Per-IP webhook rate buckets (Postgres-backed; survives cold Edge isolates).
-- Concurrent Telnyx deliveries: claim_until single-flight per event_id (FOR UPDATE).

alter table telnyx_webhook_events
  add column if not exists claim_until timestamptz;

comment on column telnyx_webhook_events.claim_until is
  'In-flight lease: while > now(), telnyx_webhook_try_begin returns busy. Cleared in telnyx_webhook_mark_complete.';

create table if not exists telnyx_webhook_ip_rate (
  route_bucket text not null,
  window_epoch bigint not null,
  hit_count int not null default 0,
  primary key (route_bucket, window_epoch)
);

create index if not exists idx_telnyx_webhook_ip_rate_prune
  on telnyx_webhook_ip_rate (window_epoch);

alter table telnyx_webhook_ip_rate enable row level security;

create policy "Service role manages telnyx_webhook_ip_rate"
  on telnyx_webhook_ip_rate for all
  using (auth.role() = 'service_role');

create or replace function telnyx_webhook_rate_check(
  p_ip text,
  p_route text,
  p_max_per_window int default 240,
  p_window_seconds int default 60
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  key text := md5(
    coalesce(nullif(trim(p_ip), ''), 'unknown') || ':' || coalesce(nullif(trim(p_route), ''), 'all')
  );
  w bigint := (
    floor(extract(epoch from clock_timestamp()) / greatest(p_window_seconds, 1)) * greatest(p_window_seconds, 1)
  )::bigint;
  cnt int;
begin
  if p_max_per_window <= 0 then
    return jsonb_build_object('ok', true, 'disabled', true);
  end if;

  insert into telnyx_webhook_ip_rate (route_bucket, window_epoch, hit_count)
  values (key, w, 1)
  on conflict (route_bucket, window_epoch)
  do update set hit_count = telnyx_webhook_ip_rate.hit_count + 1
  returning hit_count into cnt;

  delete from telnyx_webhook_ip_rate
  where window_epoch < (extract(epoch from clock_timestamp())::bigint - 86400);

  if cnt > p_max_per_window then
    return jsonb_build_object('ok', false, 'hits', cnt, 'max', p_max_per_window);
  end if;
  return jsonb_build_object('ok', true, 'hits', cnt);
end;
$$;

grant execute on function telnyx_webhook_rate_check(text, text, integer, integer) to service_role;

create or replace function telnyx_webhook_try_begin(p_event_id text, p_event_type text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r telnyx_webhook_events%rowtype;
  claim_ttl interval := interval '2 minutes';
begin
  if p_event_id is null or length(trim(p_event_id)) = 0 then
    return jsonb_build_object('status', 'error', 'reason', 'missing_event_id');
  end if;

  insert into telnyx_webhook_events (event_id, event_type)
  values (p_event_id, p_event_type)
  on conflict (event_id) do nothing;

  select * into r from telnyx_webhook_events where event_id = p_event_id for update;
  if not found then
    return jsonb_build_object('status', 'error', 'reason', 'no_row');
  end if;

  if r.completed_at is not null then
    return jsonb_build_object('status', 'done');
  end if;

  if r.claim_until is not null and r.claim_until > now() then
    return jsonb_build_object('status', 'busy');
  end if;

  update telnyx_webhook_events
  set
    claim_until = now() + claim_ttl,
    event_type = case
      when p_event_type is not null and length(trim(p_event_type)) > 0 then p_event_type
      else telnyx_webhook_events.event_type
    end
  where event_id = p_event_id;

  return jsonb_build_object('status', 'work');
end;
$$;

grant execute on function telnyx_webhook_try_begin(text, text) to service_role;

create or replace function telnyx_webhook_mark_complete(p_event_id text)
returns void
language sql
security definer
set search_path = public
as $$
  update telnyx_webhook_events
  set
    completed_at = coalesce(completed_at, now()),
    claim_until = null
  where event_id = p_event_id and completed_at is null;
$$;

grant execute on function telnyx_webhook_mark_complete(text) to service_role;

drop function if exists telnyx_webhook_try_dedupe(text, text);

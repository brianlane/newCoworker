-- Gemini spend ledger + billed-actuals reconciliation (admin observability).
--
-- Context: `owner_chat_model_spend` is ONE cumulative row per (business,
-- period) — perfect as the cap fuse, useless for "what did Gemini cost per
-- tenant per day/surface/model?" (the admin showed $2.08 while Google AI
-- Studio billed $18+ the same week, and nothing could break that down).
-- This migration adds:
--
--   1. `gemini_spend_events` — an append-only, day-keyed event ledger, one
--      row per metered Gemini call. Written INSIDE the two existing spend
--      RPCs (`owner_chat_record_spend`, `owner_chat_ai_settle`) so every
--      surface that meters (platform Next.js surfaces, the per-tenant
--      llm-router callback, Gemini Live settle, the ai-flow-worker) lands
--      in the ledger with zero new call sites. The fuse pool + cap
--      semantics are byte-identical; the new RPC params are optional and
--      default so not-yet-redeployed callers keep working (they just don't
--      ledger — no worse than before).
--   2. `gemini_spend_daily` — a security_invoker roll-up view the admin
--      Gemini page reads (per day / business / surface / model), pageable
--      through PostgREST like telnyx_cost_daily.
--   3. `gemini_billed_daily` — Google's ACTUAL billed cost per UTC day +
--      GCP project, synced from the Cloud Billing BigQuery export (Google
--      exposes no direct spend API). The admin reconciliation card compares
--      it against the metered ledger.
--
-- Access: service-role only everywhere (RLS on, no policies), matching
-- telnyx_cost_daily. Nothing bills from these rows — operator telemetry.

-- ---------------------------------------------------------------------------
-- 1) Append-only per-call ledger.
-- ---------------------------------------------------------------------------
create table if not exists public.gemini_spend_events (
  id bigint generated always as identity primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  occurred_at timestamptz not null default now(),
  -- UTC day for calendar roll-ups (matches AI Studio's daily bars).
  day date not null default (now() at time zone 'utc')::date,
  -- Telemetry label, e.g. 'vps_rowboat' | 'vps_voice_live' | 'webchat' |
  -- 'aiflow_extract' | 'website_ingest' | …
  surface text not null,
  model text not null,
  prompt_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  prompt_audio_tokens bigint not null default 0,
  output_audio_tokens bigint not null default 0,
  cost_micros bigint not null,
  -- 'exact' = billed usageMetadata tokens; 'estimate' = chars/4 fallback;
  -- 'override' = flat per-unit price (image generation).
  pricing_source text not null default 'exact'
    check (pricing_source in ('exact', 'estimate', 'override'))
);

create index if not exists idx_gemini_spend_events_day
  on public.gemini_spend_events (day desc);
create index if not exists idx_gemini_spend_events_business_day
  on public.gemini_spend_events (business_id, day desc);

alter table public.gemini_spend_events enable row level security;
-- No policies on purpose: anon/authenticated get zero access; the service
-- role bypasses RLS. Same posture as telnyx_cost_daily.

comment on table public.gemini_spend_events is
  'Append-only ledger: one row per metered Gemini call (day/surface/model/tokens/cost in micro-USD). Written inside owner_chat_record_spend / owner_chat_ai_settle; feeds the admin Gemini spend views. Pruned past ~200 days.';

-- Roll-up view for the admin pages. security_invoker so the base table
-- deny-all RLS applies to anon/authenticated; the service role reads through.
create or replace view public.gemini_spend_daily
with (security_invoker = true) as
select
  day,
  business_id,
  surface,
  model,
  pricing_source,
  count(*)::bigint as call_count,
  sum(prompt_tokens)::bigint as prompt_tokens,
  sum(output_tokens)::bigint as output_tokens,
  sum(cost_micros)::bigint as cost_micros
from public.gemini_spend_events
group by day, business_id, surface, model, pricing_source;

comment on view public.gemini_spend_daily is
  'Per-day/business/surface/model roll-up of gemini_spend_events (micro-USD). Service-role read via PostgREST for the admin Gemini page.';

-- Retention: the admin views cover at most 90 days; keep double that and
-- prune the rest. Called best-effort from the daily platform-cost sync.
create or replace function public.gemini_spend_events_prune(
  p_keep_days integer default 200
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  removed bigint;
begin
  delete from public.gemini_spend_events
    where day < ((now() at time zone 'utc')::date - greatest(p_keep_days, 90));
  get diagnostics removed = row_count;
  return removed;
end;
$$;

comment on function public.gemini_spend_events_prune is
  'Delete gemini_spend_events older than p_keep_days (floored at 90 so a bad arg cannot wipe the admin views). Returns rows removed.';

revoke all on function public.gemini_spend_events_prune(integer) from public, anon, authenticated;
grant execute on function public.gemini_spend_events_prune(integer) to service_role;

-- ---------------------------------------------------------------------------
-- 2) Extend owner_chat_record_spend with optional ledger params.
--
-- Postgres cannot alter an argument list in place, so drop + recreate inside
-- this migration's transaction (no visible gap). The original 4-arg calls
-- keep working via defaults; when p_model is present and the cost is
-- positive, the same transaction appends the ledger event — the fuse math is
-- unchanged from 20260604000000_owner_chat_spend_cap.sql.
-- ---------------------------------------------------------------------------
drop function if exists public.owner_chat_record_spend(uuid, timestamptz, bigint, bigint);

create or replace function public.owner_chat_record_spend(
  p_business_id uuid,
  p_period_start timestamptz,
  p_cost_micros bigint,
  p_cap_micros bigint,
  p_model text default null,
  p_surface text default null,
  p_prompt_tokens bigint default 0,
  p_output_tokens bigint default 0,
  p_prompt_audio_tokens bigint default 0,
  p_output_audio_tokens bigint default 0,
  p_pricing_source text default 'exact'
)
returns table (spend_micros bigint, turn_count integer, fuse_newly_tripped boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_was_tripped boolean;
  v_new_total bigint;
  v_new_count integer;
  v_now_tripped boolean;
begin
  insert into owner_chat_model_spend (business_id, period_start, spend_micros, turn_count, updated_at)
  values (p_business_id, p_period_start, greatest(p_cost_micros, 0), 1, now())
  on conflict (business_id, period_start) do update
    set spend_micros = owner_chat_model_spend.spend_micros + greatest(p_cost_micros, 0),
        turn_count = owner_chat_model_spend.turn_count + 1,
        updated_at = now()
  returning
    owner_chat_model_spend.spend_micros,
    owner_chat_model_spend.turn_count,
    (owner_chat_model_spend.fuse_tripped_at is not null)
  into v_new_total, v_new_count, v_was_tripped;

  -- Trip the fuse the first time we're at/over the cap this period.
  v_now_tripped := false;
  if not v_was_tripped and v_new_total >= p_cap_micros then
    update owner_chat_model_spend
      set fuse_tripped_at = now()
      where business_id = p_business_id and period_start = p_period_start;
    v_now_tripped := true;
  end if;

  -- Ledger event (observability only — never affects the fuse). Old callers
  -- pass no model and skip this; zero-cost calls carry no spend to ledger.
  if p_model is not null and greatest(p_cost_micros, 0) > 0 then
    insert into gemini_spend_events (
      business_id, surface, model,
      prompt_tokens, output_tokens, prompt_audio_tokens, output_audio_tokens,
      cost_micros, pricing_source
    ) values (
      p_business_id, coalesce(p_surface, 'unknown'), p_model,
      greatest(coalesce(p_prompt_tokens, 0), 0),
      greatest(coalesce(p_output_tokens, 0), 0),
      greatest(coalesce(p_prompt_audio_tokens, 0), 0),
      greatest(coalesce(p_output_audio_tokens, 0), 0),
      greatest(p_cost_micros, 0),
      case when p_pricing_source in ('exact', 'estimate', 'override')
           then p_pricing_source else 'exact' end
    );
  end if;

  spend_micros := v_new_total;
  turn_count := v_new_count;
  fuse_newly_tripped := v_now_tripped;
  return next;
end;
$$;

comment on function public.owner_chat_record_spend is
  'Atomically add Gemini model cost (micro-USD) to the period meter, bump the turn count, trip the fuse on first cap crossing, and (when p_model is given) append the gemini_spend_events ledger row. Returns new total + whether this call tripped the fuse.';

revoke all on function public.owner_chat_record_spend(uuid, timestamptz, bigint, bigint, text, text, bigint, bigint, bigint, bigint, text) from public, anon, authenticated;
grant execute on function public.owner_chat_record_spend(uuid, timestamptz, bigint, bigint, text, text, bigint, bigint, bigint, bigint, text) to service_role;

-- ---------------------------------------------------------------------------
-- 3) Extend owner_chat_ai_settle the same way (live-voice teardown).
--    Body otherwise identical to 20260712000000_owner_chat_ai_budget_reservations.sql.
-- ---------------------------------------------------------------------------
drop function if exists public.owner_chat_ai_settle(uuid, timestamptz, text, bigint, bigint);

create or replace function public.owner_chat_ai_settle(
  p_business_id uuid,
  p_period_start timestamptz,
  p_call_control_id text,
  p_actual_micros bigint,
  p_cap_micros bigint,
  p_model text default null,
  p_surface text default null,
  p_prompt_tokens bigint default 0,
  p_output_tokens bigint default 0,
  p_prompt_audio_tokens bigint default 0,
  p_output_audio_tokens bigint default 0,
  p_pricing_source text default 'exact'
)
returns table (spend_micros bigint, fuse_newly_tripped boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_was_tripped boolean;
  v_new_total bigint;
  v_now_tripped boolean;
begin
  perform pg_advisory_xact_lock(hashtext(p_business_id::text));

  update owner_chat_spend_reservations
    set state = 'settled', reserved_micros = 0, updated_at = now()
    where call_control_id = p_call_control_id;

  if coalesce(p_actual_micros, 0) <= 0 then
    select coalesce(spend_micros, 0) into v_new_total
      from owner_chat_model_spend
      where business_id = p_business_id and period_start = p_period_start;
    spend_micros := coalesce(v_new_total, 0);
    fuse_newly_tripped := false;
    return next;
    return;
  end if;

  insert into owner_chat_model_spend (business_id, period_start, spend_micros, turn_count, updated_at)
  values (p_business_id, p_period_start, p_actual_micros, 1, now())
  on conflict (business_id, period_start) do update
    set spend_micros = owner_chat_model_spend.spend_micros + p_actual_micros,
        turn_count = owner_chat_model_spend.turn_count + 1,
        updated_at = now()
  returning
    owner_chat_model_spend.spend_micros,
    (owner_chat_model_spend.fuse_tripped_at is not null)
  into v_new_total, v_was_tripped;

  v_now_tripped := false;
  if not v_was_tripped and v_new_total >= p_cap_micros then
    update owner_chat_model_spend
      set fuse_tripped_at = now()
      where business_id = p_business_id and period_start = p_period_start;
    v_now_tripped := true;
  end if;

  -- Ledger event for the settled call (positive-cost branch only — the
  -- zero-cost early return above releases the hold without spend).
  if p_model is not null then
    insert into gemini_spend_events (
      business_id, surface, model,
      prompt_tokens, output_tokens, prompt_audio_tokens, output_audio_tokens,
      cost_micros, pricing_source
    ) values (
      p_business_id, coalesce(p_surface, 'vps_voice_live'), p_model,
      greatest(coalesce(p_prompt_tokens, 0), 0),
      greatest(coalesce(p_output_tokens, 0), 0),
      greatest(coalesce(p_prompt_audio_tokens, 0), 0),
      greatest(coalesce(p_output_audio_tokens, 0), 0),
      p_actual_micros,
      case when p_pricing_source in ('exact', 'estimate', 'override')
           then p_pricing_source else 'exact' end
    );
  end if;

  spend_micros := v_new_total;
  fuse_newly_tripped := v_now_tripped;
  return next;
end;
$$;

comment on function public.owner_chat_ai_settle is
  'Release a live-voice AI-budget reservation, add the exact metered Gemini Live spend to the shared meter (fuse on first crossing), and (when p_model is given) append the gemini_spend_events ledger row. Returns new total + whether this settle tripped the fuse.';

revoke all on function public.owner_chat_ai_settle(uuid, timestamptz, text, bigint, bigint, text, text, bigint, bigint, bigint, bigint, text) from public, anon, authenticated;
grant execute on function public.owner_chat_ai_settle(uuid, timestamptz, text, bigint, bigint, text, text, bigint, bigint, bigint, bigint, text) to service_role;

-- ---------------------------------------------------------------------------
-- 4) Google billed actuals (Cloud Billing BigQuery export sync).
--    Idempotency is delete+insert over the synced rolling window inside one
--    transaction, same rationale as replace_telnyx_cost_window.
-- ---------------------------------------------------------------------------
create table if not exists public.gemini_billed_daily (
  id bigint generated always as identity primary key,
  day date not null,
  gcp_project_id text not null,
  cost_micros bigint not null default 0,
  synced_at timestamptz not null default now(),
  unique (day, gcp_project_id)
);

create index if not exists idx_gemini_billed_daily_day
  on public.gemini_billed_daily (day desc);

alter table public.gemini_billed_daily enable row level security;
-- No policies on purpose (service-role only), matching telnyx_cost_daily.

comment on table public.gemini_billed_daily is
  'Google''s billed Generative Language API cost per UTC day + GCP project (micro-USD), synced from the Cloud Billing BigQuery export. Feeds the admin metered-vs-billed reconciliation; nothing bills from it.';

create or replace function public.replace_gemini_billed_window(
  p_window_start date,
  p_rows jsonb
) returns integer
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  inserted integer;
begin
  delete from public.gemini_billed_daily where day >= p_window_start;
  insert into public.gemini_billed_daily (day, gcp_project_id, cost_micros)
  select
    (r->>'day')::date,
    r->>'gcp_project_id',
    coalesce((r->>'cost_micros')::bigint, 0)
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as r;
  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

revoke execute on function public.replace_gemini_billed_window(date, jsonb)
  from public, anon, authenticated;

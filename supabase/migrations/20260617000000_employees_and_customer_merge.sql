-- ---------------------------------------------------------------------------
-- Employees (team roster working info + time off) and customer profile merge.
--
-- Part 1 — employees:
--   ai_flow_team_members grows optional working-info columns (email,
--   weekly_schedule, preferred_windows) and a sibling employee_time_off
--   table. The ai-flow-worker reads these during route_to_team selection:
--   time off covering "today" (business-local) is a hard skip that
--   supersedes even pinned routing; being outside weekly_schedule (when one
--   is set) is a hard skip; preferred_windows only reorders the rotation
--   (members inside a preferred window are offered first).
--
-- Part 2 — customer merge:
--   One person reaching out from two numbers (landline call + cell text) is
--   two customer_memories rows. merge_customer_memories() folds the "from"
--   row into the "into" row and records the merged-away number in
--   alias_e164s so future lookups AND interaction writes from the old
--   number resolve to the surviving profile.
-- ---------------------------------------------------------------------------

-- 1a) Working-info columns. All nullable: absent = no constraint, which is
-- exactly how existing rosters behave today.
alter table public.ai_flow_team_members
  add column if not exists email text,
  add column if not exists weekly_schedule jsonb,
  add column if not exists preferred_windows jsonb;

comment on column public.ai_flow_team_members.email is
  'Optional contact email. Used by the shared NewCoworker calendar (read-access grants); never required for SMS routing.';
comment on column public.ai_flow_team_members.weekly_schedule is
  'Optional per-weekday working windows, e.g. {"mon":[["09:00","17:00"]]}. When set, route_to_team hard-skips the member outside these windows (evaluated in the business timezone). Null/empty = always available.';
comment on column public.ai_flow_team_members.preferred_windows is
  'Optional per-weekday PREFERRED lead-time windows (same shape as weekly_schedule). Soft priority only: members currently inside a preferred window are offered leads first; never excludes anyone.';

-- 1b) Time off. Date-granular (whole days) because that matches how owners
-- think about "Gabrielle is out Thursday–Sunday"; intra-day absence is what
-- weekly_schedule is for.
create table if not exists public.employee_time_off (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  member_id uuid not null references public.ai_flow_team_members(id) on delete cascade,
  starts_on date not null,
  ends_on date not null,
  note text,
  created_at timestamptz not null default now(),
  check (ends_on >= starts_on)
);

-- Worker hot path: "who is out today for this business" — covering range scan.
create index if not exists employee_time_off_active_idx
  on public.employee_time_off (business_id, starts_on, ends_on);

alter table public.employee_time_off enable row level security;

drop policy if exists "Owner reads own employee_time_off" on public.employee_time_off;
create policy "Owner reads own employee_time_off"
  on public.employee_time_off for select
  using (business_id in (select id from public.businesses where owner_email = auth.email()));

drop policy if exists "Owner inserts own employee_time_off" on public.employee_time_off;
create policy "Owner inserts own employee_time_off"
  on public.employee_time_off for insert
  with check (business_id in (select id from public.businesses where owner_email = auth.email()));

drop policy if exists "Owner updates own employee_time_off" on public.employee_time_off;
create policy "Owner updates own employee_time_off"
  on public.employee_time_off for update
  using (business_id in (select id from public.businesses where owner_email = auth.email()));

drop policy if exists "Owner deletes own employee_time_off" on public.employee_time_off;
create policy "Owner deletes own employee_time_off"
  on public.employee_time_off for delete
  using (business_id in (select id from public.businesses where owner_email = auth.email()));

comment on table public.employee_time_off is
  'Whole-day out-of-office ranges per ai_flow_team_members row. route_to_team hard-skips members with a range covering the business-local "today" — this supersedes everything, including pinned routing.';

-- 2a) Merged-away numbers live on the surviving row so every lookup path
-- (dashboard, SMS worker, voice bridge) can resolve the old number.
alter table public.customer_memories
  add column if not exists alias_e164s text[] not null default '{}';

create index if not exists idx_customer_memories_alias_gin
  on public.customer_memories using gin (alias_e164s);

comment on column public.customer_memories.alias_e164s is
  'E.164 numbers merged into this profile via merge_customer_memories(). Lookups and record_customer_interaction() match customer_e164 OR any alias, so contact from a merged-away number keeps feeding the surviving row.';

-- 2b) Interaction recorder learns alias resolution: an inbound from a
-- merged-away number must bump the surviving row, otherwise the next text
-- from the old number silently recreates the profile the owner just merged.
-- The alias UPDATE runs first (matches ~never, costs one GIN probe); the
-- original upsert is untouched.
create or replace function public.record_customer_interaction(
  p_business_id uuid,
  p_customer_e164 text,
  p_channel text,
  p_display_name text default null
)
returns public.customer_memories
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  result public.customer_memories;
begin
  if p_channel not in ('sms', 'voice', 'dashboard') then
    raise exception 'record_customer_interaction: invalid channel %', p_channel;
  end if;

  update public.customer_memories
     set interaction_count = customer_memories.interaction_count + 1,
         total_interaction_count = customer_memories.total_interaction_count + 1,
         last_interaction_at = now(),
         last_channel = p_channel,
         display_name = coalesce(customer_memories.display_name, p_display_name),
         updated_at = now()
   where business_id = p_business_id
     and alias_e164s @> array[p_customer_e164]
  returning * into result;
  if found then
    return result;
  end if;

  insert into public.customer_memories (
    business_id, customer_e164, display_name,
    interaction_count, total_interaction_count,
    last_interaction_at, last_channel
  ) values (
    p_business_id, p_customer_e164, p_display_name,
    1, 1,
    now(), p_channel
  )
  on conflict (business_id, customer_e164) do update
    set interaction_count = customer_memories.interaction_count + 1,
        total_interaction_count = customer_memories.total_interaction_count + 1,
        last_interaction_at = now(),
        last_channel = excluded.last_channel,
        display_name = coalesce(customer_memories.display_name, excluded.display_name),
        updated_at = now()
  returning * into result;

  return result;
end;
$$;

revoke all on function public.record_customer_interaction(uuid, text, text, text) from public;
grant execute on function public.record_customer_interaction(uuid, text, text, text)
  to service_role;

-- 2c) The merge itself. Owner-driven (rare), called via the dashboard API
-- route with the service role after requireOwner(). Locks both rows, folds
-- "from" into "into", and deletes the "from" row in one transaction.
--
-- Field semantics (mirrors the plan):
--   * summary_md / pinned_md: into-first concatenation, capped (4000/2000
--     chars) so two long profiles can't blow the prompt budget;
--   * display_name: keep into's unless it's blank;
--   * counters: summed; first-seen (created_at): earliest of the two;
--   * last_interaction_at / last_channel: whichever interaction is newest;
--   * alias_e164s: union of both rows' aliases + the from number itself.
create or replace function public.merge_customer_memories(
  p_business_id uuid,
  p_from_e164 text,
  p_into_e164 text
)
returns public.customer_memories
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_from public.customer_memories;
  v_into public.customer_memories;
  v_summary text;
  v_pinned text;
  v_from_last timestamptz;
  v_into_last timestamptz;
begin
  if p_from_e164 = p_into_e164 then
    raise exception 'merge_customer_memories: cannot merge a customer into itself';
  end if;

  -- Deterministic lock order (by e164) so two concurrent opposite-direction
  -- merges deadlock-proof into "second one errors on a missing row" instead.
  if p_from_e164 < p_into_e164 then
    select * into v_from from public.customer_memories
      where business_id = p_business_id and customer_e164 = p_from_e164 for update;
    select * into v_into from public.customer_memories
      where business_id = p_business_id and customer_e164 = p_into_e164 for update;
  else
    select * into v_into from public.customer_memories
      where business_id = p_business_id and customer_e164 = p_into_e164 for update;
    select * into v_from from public.customer_memories
      where business_id = p_business_id and customer_e164 = p_from_e164 for update;
  end if;

  if v_from.id is null then
    raise exception 'merge_customer_memories: source customer % not found', p_from_e164;
  end if;
  if v_into.id is null then
    raise exception 'merge_customer_memories: target customer % not found', p_into_e164;
  end if;

  v_summary := left(
    nullif(concat_ws(e'\n\n',
      nullif(trim(coalesce(v_into.summary_md, '')), ''),
      nullif(trim(coalesce(v_from.summary_md, '')), '')
    ), ''),
    4000
  );
  v_pinned := left(
    nullif(concat_ws(e'\n\n',
      nullif(trim(coalesce(v_into.pinned_md, '')), ''),
      nullif(trim(coalesce(v_from.pinned_md, '')), '')
    ), ''),
    2000
  );
  v_from_last := coalesce(v_from.last_interaction_at, '-infinity'::timestamptz);
  v_into_last := coalesce(v_into.last_interaction_at, '-infinity'::timestamptz);

  update public.customer_memories
     set display_name = coalesce(nullif(trim(coalesce(v_into.display_name, '')), ''), v_from.display_name),
         summary_md = v_summary,
         pinned_md = v_pinned,
         interaction_count = v_into.interaction_count + v_from.interaction_count,
         total_interaction_count = v_into.total_interaction_count + v_from.total_interaction_count,
         last_interaction_at = nullif(greatest(v_from_last, v_into_last), '-infinity'::timestamptz),
         last_channel = case
           when v_from_last > v_into_last then coalesce(v_from.last_channel, v_into.last_channel)
           else coalesce(v_into.last_channel, v_from.last_channel)
         end,
         created_at = least(v_into.created_at, v_from.created_at),
         alias_e164s = (
           select coalesce(array_agg(distinct a), '{}'::text[])
           from unnest(v_into.alias_e164s || v_from.alias_e164s || array[v_from.customer_e164]) as a
           where a is not null and a <> v_into.customer_e164
         ),
         updated_at = now()
   where id = v_into.id
  returning * into v_into;

  delete from public.customer_memories where id = v_from.id;

  return v_into;
end;
$$;

revoke all on function public.merge_customer_memories(uuid, text, text) from public;
grant execute on function public.merge_customer_memories(uuid, text, text)
  to service_role;

comment on function public.merge_customer_memories(uuid, text, text) is
  'Folds customer_memories(from) into customer_memories(into) for one business: concatenated summary/pinned (capped), summed counters, earliest first-seen, newest last-interaction, and the from-number recorded in alias_e164s. Deletes the from row. Service-role only; the API route enforces ownership.';

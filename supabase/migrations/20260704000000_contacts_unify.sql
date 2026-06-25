-- ---------------------------------------------------------------------------
-- Unify contacts: collapse `customer_memories` + `contact_overrides` into ONE
-- `contacts` table with a required `type` column.
--
-- Why: the dashboard listed two separate tables — `customer_memories` (the AI's
-- cross-channel memory: rolling summary, pinned notes, counters, aliases) and
-- `contact_overrides` (a thin owner-set name/email label). The same number could
-- appear in both, owner/employee numbers showed up as "customers", and there was
-- no single place to see every contact with its kind. After this migration there
-- is one row per (business_id, number) carrying everything, tagged with a `type`.
--
-- Scope (decided with the owner): only these two tables merge physically.
--   * Employees stay in `ai_flow_team_members` (the routing roster — active,
--     last_offered_at, weekly_schedule, preferred_windows drive route_to_team).
--     They are surfaced in the Contacts UI as type=employee via the read-time
--     overlay in src/lib/db/contact-names.ts; routing code is untouched.
--   * Owner is derived at read time from businesses.owner_name/phone,
--     business_telnyx_settings.forward_to_e164, and
--     notification_preferences.phone_number. Surfaced as type=owner.
--
-- Implementation choices that keep this safe on a live system:
--   * The table is RENAMED (not recreated), so all data, indexes, triggers,
--     constraints and the unique (business_id, customer_e164) carry over intact.
--   * Column names are KEPT (customer_e164, display_name) so the ~30 code paths
--     that read those columns need only swap the table name, not every field.
--   * The two RPCs keep their names (record_customer_interaction,
--     merge_customer_memories) so every rpc() caller is unchanged; only their
--     bodies + return type move to `contacts`.
--   * A temporary backward-compat VIEW `customer_memories` is created so the
--     independently-deployed voice-bridge VPS keeps reading until it is
--     redeployed. Dropped in a follow-up migration after that redeploy.
-- ---------------------------------------------------------------------------

-- 1) Rename the table. Indexes (idx_customer_memories_*), the updated_at trigger,
--    the unique constraint and RLS all follow the table automatically.
alter table public.customer_memories rename to contacts;

-- 2) The new required classifier. Default 'customer' so every existing memory row
--    (and any future auto-created profile) is a customer unless re-tagged. The
--    check is the canonical set; extend it here + in the app list to add a type.
alter table public.contacts
  add column if not exists type text not null default 'customer';

alter table public.contacts
  drop constraint if exists contacts_type_chk;
alter table public.contacts
  add constraint contacts_type_chk
  check (type in ('owner', 'employee', 'customer', 'tester', 'service', 'other'));

comment on column public.contacts.type is
  'Contact classification: customer (default; auto-created from SMS/voice), owner/employee (also surfaced via the read-time overlay from their authoritative tables), tester (owner''s own test numbers), service (lead sources / short codes), other (vendors, reps). NOT NULL.';

comment on column public.contacts.customer_e164 is
  'The contact''s E.164 number, or a bare 3-8 digit short code for service/lead-source rows. Name kept from the customer_memories era to avoid churning every read path; (business_id, customer_e164) is unique.';

-- 3) Fold contact_overrides in. The override is the owner''s manual label, so its
--    name/email win; a number that had no memory becomes a fresh type='other'
--    row (owner can re-tag to service/tester). Email never clobbers an existing
--    address. type is left untouched for rows that already existed (a real
--    customer who also had a manual label stays type='customer').
insert into public.contacts (
  business_id, customer_e164, display_name, email, type, created_at, updated_at
)
select
  co.business_id, co.e164, co.name, co.email, 'other', co.created_at, co.updated_at
from public.contact_overrides co
on conflict (business_id, customer_e164) do update
  set display_name = excluded.display_name,
      email = coalesce(contacts.email, excluded.email),
      updated_at = now();

-- 4) The override table is now fully absorbed. Its RLS policies + email index
--    drop with it.
drop table public.contact_overrides;

-- 5) Recreate the two RPCs against `contacts` (return type + table refs). These
--    are byte-for-byte the latest definitions from
--    20260629000000_contacts_email.sql with customer_memories -> contacts and the
--    return type updated. The `type` column has a default so the INSERT branch
--    need not set it (a new auto-created profile is a 'customer').
create or replace function public.record_customer_interaction(
  p_business_id uuid,
  p_customer_e164 text,
  p_channel text,
  p_display_name text default null
)
returns public.contacts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  result public.contacts;
begin
  if p_channel not in ('sms', 'voice', 'dashboard', 'email') then
    raise exception 'record_customer_interaction: invalid channel %', p_channel;
  end if;

  -- Alias resolution first: an interaction from a merged-away number must bump
  -- the surviving profile, not recreate the merged one.
  update public.contacts
     set interaction_count = contacts.interaction_count + 1,
         total_interaction_count = contacts.total_interaction_count + 1,
         last_interaction_at = now(),
         last_channel = p_channel,
         display_name = coalesce(contacts.display_name, p_display_name),
         updated_at = now()
   where business_id = p_business_id
     and alias_e164s @> array[p_customer_e164]
  returning * into result;
  if found then
    return result;
  end if;

  insert into public.contacts (
    business_id, customer_e164, display_name,
    interaction_count, total_interaction_count,
    last_interaction_at, last_channel
  ) values (
    p_business_id, p_customer_e164, p_display_name,
    1, 1,
    now(), p_channel
  )
  on conflict (business_id, customer_e164) do update
    set interaction_count = contacts.interaction_count + 1,
        total_interaction_count = contacts.total_interaction_count + 1,
        last_interaction_at = now(),
        last_channel = excluded.last_channel,
        display_name = coalesce(contacts.display_name, excluded.display_name),
        updated_at = now()
  returning * into result;

  return result;
end;
$$;

revoke all on function public.record_customer_interaction(uuid, text, text, text) from public;
grant execute on function public.record_customer_interaction(uuid, text, text, text)
  to service_role;

create or replace function public.merge_customer_memories(
  p_business_id uuid,
  p_from_e164 text,
  p_into_e164 text
)
returns public.contacts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_from public.contacts;
  v_into public.contacts;
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
    select * into v_from from public.contacts
      where business_id = p_business_id and customer_e164 = p_from_e164 for update;
    select * into v_into from public.contacts
      where business_id = p_business_id and customer_e164 = p_into_e164 for update;
  else
    select * into v_into from public.contacts
      where business_id = p_business_id and customer_e164 = p_into_e164 for update;
    select * into v_from from public.contacts
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

  update public.contacts
     set display_name = coalesce(nullif(trim(coalesce(v_into.display_name, '')), ''), v_from.display_name),
         summary_md = v_summary,
         pinned_md = v_pinned,
         email = coalesce(v_into.email, v_from.email),
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

  delete from public.contacts where id = v_from.id;

  return v_into;
end;
$$;

revoke all on function public.merge_customer_memories(uuid, text, text) from public;
grant execute on function public.merge_customer_memories(uuid, text, text)
  to service_role;

comment on function public.merge_customer_memories(uuid, text, text) is
  'Folds contacts(from) into contacts(into) for one business: concatenated summary/pinned (capped), summed counters, earliest first-seen, newest last-interaction, inherited email, and the from-number recorded in alias_e164s. Deletes the from row. Service-role only; the API route enforces ownership.';

-- 6) Tidy the carried-over RLS policy name so it reads against the new table.
--    Behaviour is identical: service role does every write; the dashboard reads
--    via the service client after requireOwner().
drop policy if exists "Service role manages customer_memories" on public.contacts;
drop policy if exists "Service role manages contacts" on public.contacts;
create policy "Service role manages contacts"
  on public.contacts for all
  using (auth.role() = 'service_role');

comment on table public.contacts is
  'One row per (business_id, number): unified contact directory + the AI''s cross-channel memory. Merged from customer_memories + contact_overrides. `type` classifies the contact; employee/owner are also overlaid at read from their authoritative tables. Read by SMS worker + voice bridge to inject a system preamble; written post-interaction (gated) and nightly.';

-- 7) Temporary backward-compat view for the out-of-band voice-bridge VPS, which
--    still selects from `customer_memories` until it is redeployed to read
--    `contacts`. Simple (no-join) view → the VPS read passes straight through.
--    DROP THIS in a follow-up migration once every VPS instance is redeployed.
--    security_invoker=true so the view enforces contacts' RLS against the CALLER
--    (service role only) rather than the view owner — without it, anon/auth could
--    read every contact through this shim.
create or replace view public.customer_memories
  with (security_invoker = true)
  as
  select id, business_id, customer_e164, display_name, email, summary_md,
         pinned_md, interaction_count, total_interaction_count,
         last_interaction_at, last_summarized_at, last_channel,
         alias_e164s, created_at, updated_at
  from public.contacts;

comment on view public.customer_memories is
  'TEMPORARY backward-compat shim over public.contacts for the voice-bridge VPS during its redeploy window. Excludes the new `type` column. Drop after every VPS instance reads `contacts` directly.';

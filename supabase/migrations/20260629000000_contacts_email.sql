-- Link a phone number to an email across the three contact kinds.
--
-- Why: a person we work with (customer, or an "other business/person" contact)
-- shows up on more than one channel — they text, they call, and they email.
-- Storing an optional email on the customer profile AND on a contact override
-- lets us roll those channels up to one identity: inbound mail from that
-- address attaches to the same profile, and the owner can email them back from
-- it. Email is optional and owner-set; format is validated in the app layer
-- (real-world addresses are too varied for a useful CHECK).

alter table customer_memories add column if not exists email text;
alter table contact_overrides add column if not exists email text;

-- Case-insensitive lookup of a profile/contact by an inbound sender address,
-- scoped per business. Partial (email is usually null) so the index stays small.
create index if not exists customer_memories_business_email_idx
  on customer_memories (business_id, lower(email))
  where email is not null;

create index if not exists contact_overrides_business_email_idx
  on contact_overrides (business_id, lower(email))
  where email is not null;

comment on column customer_memories.email is
  'Optional owner-set email linked to this customer so inbound/outbound email rolls up to the same cross-channel profile.';
comment on column contact_overrides.email is
  'Optional email for an other-business/person contact, linking their number and address.';

-- Email becomes a first-class interaction channel alongside sms/voice/dashboard:
-- inbound mail from a known customer's linked address rolls up to their profile
-- (last_channel + counters) the same way a text or call does. Widen the
-- last_channel CHECK and the record_customer_interaction guard to accept it.
alter table public.customer_memories
  drop constraint if exists customer_memories_last_channel_check;
alter table public.customer_memories
  add constraint customer_memories_last_channel_check
  check (last_channel in ('sms', 'voice', 'dashboard', 'email'));

-- Re-declare record_customer_interaction to accept the new 'email' channel.
-- IMPORTANT: this is the alias-aware definition from
-- 20260617000000_employees_and_customer_merge.sql with ONLY the channel guard
-- widened. The leading alias UPDATE must be preserved — without it, an
-- interaction (incl. inbound email) from a merged-away number skips the
-- surviving row and re-inserts the profile the owner just merged away.
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
  if p_channel not in ('sms', 'voice', 'dashboard', 'email') then
    raise exception 'record_customer_interaction: invalid channel %', p_channel;
  end if;

  -- Alias resolution first: an interaction from a merged-away number must bump
  -- the surviving profile, not recreate the merged one. Matches ~never (one GIN
  -- probe) for the common case.
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

-- Carry a linked email through a profile merge: the survivor keeps its own email
-- when set, otherwise inherits the merged-away row's address so future
-- inbound/outbound mail keeps rolling up. This is the exact merge from
-- 20260617000000_employees_and_customer_merge.sql with ONLY the
-- `email = coalesce(v_into.email, v_from.email)` line added.
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

  delete from public.customer_memories where id = v_from.id;

  return v_into;
end;
$$;

revoke all on function public.merge_customer_memories(uuid, text, text) from public;
grant execute on function public.merge_customer_memories(uuid, text, text)
  to service_role;

-- 'booking_page' becomes a first-class contact interaction channel.
--
-- The public booking page has been filing its visitors under 'webchat'
-- since it shipped, because that was the closest existing value and the
-- page stamps its own "Booking Page" source tag for CRM scoping. The tag
-- is the right mechanism for ORIGIN, but `last_channel` is a per-
-- INTERACTION fact, so the borrowed value makes every surface that reads
-- it claim the visitor chatted with the widget: the contact badge reads
-- "LAST VIA WEBCHAT", the CSV export and the MCP read tool say webchat,
-- and buildCustomerPreamble tells the model "last channel: webchat" for
-- someone who only ever filled in a booking form.
--
-- The tag cannot repair that at read time: it never expires, so a visitor
-- who books and LATER really uses the chat widget would keep reading as a
-- booking-page lead forever. Only a real channel value tracks the last
-- touch correctly in both directions, and no AiFlow keys on last_channel
-- (0 of 47 live flows reference it), so widening the domain is safe.
--
-- Same widening pattern as 'messenger' (20260808010000) and 'whatsapp'
-- (20260811210000).
alter table public.contacts
  drop constraint if exists customer_memories_last_channel_check;
alter table public.contacts
  add constraint customer_memories_last_channel_check
  check (last_channel in ('sms', 'voice', 'dashboard', 'email', 'webchat', 'messenger', 'whatsapp', 'booking_page'));

-- Byte-for-byte the alias-aware definition from 20260811210000 with ONLY
-- the channel guard widened (the leading alias UPDATE must be preserved).
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
  if p_channel not in ('sms', 'voice', 'dashboard', 'email', 'webchat', 'messenger', 'whatsapp', 'booking_page') then
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

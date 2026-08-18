-- ---------------------------------------------------------------------------
-- A contact can be identified by an email address instead of a phone number.
--
-- Why: an email-only lead had no contact row at all. ReferralExchange and
-- Realtor.com both hand us leads with an address and no number; those people
-- were invisible in Contacts, could not be tagged, could not be owned, and
-- could not be reached by any tag-triggered follow-up cadence, even after the
-- AI had emailed them and a teammate had claimed them.
--
-- `contacts.customer_e164` was never really a phone number. It is the contact
-- KEY, and it has held two shapes since the contacts_unify migration:
--   * an E.164 number      +16025551234
--   * a bare short code    73339          (lead sources text from these)
-- This adds a third:
--   * an email key         email:val@example.com
--
-- The prefix is load-bearing. Every phone validator in the codebase is a
-- digits-and-plus regex, so an un-taught code path REFUSES an email key rather
-- than trying to text the address. See supabase/functions/_shared/contact_key.ts
-- for the vocabulary (emailContactKey / isDialableContactKey / formatContactKey).
--
-- No table, index, RPC or grant changes: the column, its unique constraint
-- (business_id, customer_e164), the alias array and both RPCs all take an
-- arbitrary text key already. The only new thing is the invariant below.
--
-- grants: none (no new objects) -- this migration adds a comment and a CHECK
-- constraint to an existing table; contacts already grants the Data API roles.
-- ---------------------------------------------------------------------------

-- The invariant that keeps every existing email lookup working unchanged.
--
-- An `email:<addr>` row must also carry `<addr>` in its own `email` column. That
-- way findCustomerByEmail, findContactsByEmails, the campaign audience builder
-- and the marketing-unsubscribe path all see email-keyed contacts through the
-- query they already run, with no per-caller special case. Comparison is
-- lower()ed on both sides because the key is stored lowercased while `email` is
-- owner-typed and may carry any casing.
--
-- NOT VALID first, then VALIDATE: the validate pass takes only a SHARE UPDATE
-- EXCLUSIVE lock, so a large contacts table is not blocked against writes while
-- the existing rows are scanned. Every existing row has a number key and so
-- satisfies the first arm trivially, but the two-step keeps the pattern honest
-- for the next person who copies it.
alter table public.contacts
  drop constraint if exists contacts_email_key_matches_email;

alter table public.contacts
  add constraint contacts_email_key_matches_email
  check (
    customer_e164 not like 'email:%'
    or lower(coalesce(email, '')) = substring(lower(customer_e164) from 7)
  )
  not valid;

alter table public.contacts
  validate constraint contacts_email_key_matches_email;

comment on column public.contacts.customer_e164 is
  'The contact KEY, unique per business. One of three shapes: an E.164 number, a bare 3-8 digit short code (service / lead-source rows), or ''email:<lowercased address>'' for a contact we only know by email. Name kept from the customer_memories era to avoid churning every read path. Parse it with supabase/functions/_shared/contact_key.ts, and never assume it is dialable: gate sends on isDialableContactKey().';

-- ---------------------------------------------------------------------------
-- record_customer_interaction: fill `email` when the key IS an email.
--
-- This is the create-or-bump every channel funnels through, and its INSERT
-- branch never set `email`. With the constraint above, an email-keyed insert
-- through this function would raise instead of filing the contact, so the
-- invariant has to be maintained HERE rather than at each of the dozen call
-- sites. Deriving it in the function also means the column can never drift from
-- the key, whoever writes.
--
-- Byte-for-byte the definition from 20260822160258_booking_page_channel.sql
-- with ONE change: the INSERT gained an `email` column whose value is the
-- address behind an `email:` key (null for a number key, which is every
-- pre-existing contact).
-- ---------------------------------------------------------------------------
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
    business_id, customer_e164, display_name, email,
    interaction_count, total_interaction_count,
    last_interaction_at, last_channel
  ) values (
    p_business_id, p_customer_e164, p_display_name,
    case
      when p_customer_e164 like 'email:%' then substring(lower(p_customer_e164) from 7)
      else null
    end,
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

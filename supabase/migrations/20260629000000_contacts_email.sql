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

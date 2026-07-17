-- WhatsApp conversation + outbound channel.
--
-- Tenants connect a WhatsApp Business Account (WABA) + phone number via
-- Meta's Embedded Signup; inbound customer messages ride the existing
-- signature-verified /api/webhooks/meta callback (object
-- "whatsapp_business_account") into the messenger_* pipeline shipped in
-- 20260808010000 with platform='whatsapp', answered by the same Gemini
-- engine through the Cloud API. Outbound (AiFlow send_whatsapp steps,
-- owner alerts, dashboard coworker tool) routes through the central
-- deliver helper: free-form text inside Meta's 24h service window,
-- pre-approved utility templates outside it.
--
-- Security posture: RLS ON with NO policies — service-role only, same as
-- meta_connections.

-- ---------------------------------------------------------------------
-- Per-tenant WhatsApp connection. One row per business; phone_number_id
-- is the webhook-routing and send key (unique across tenants).
-- ---------------------------------------------------------------------
create table if not exists public.whatsapp_connections (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  waba_id text not null,
  phone_number_id text not null,
  display_phone_number text,
  -- Embedded Signup business-integration token (AES-256-GCM via
  -- src/lib/integrations/secrets.ts). Does not expire; no refresh flow.
  access_token_encrypted text not null,
  -- Stock utility templates auto-registered at connect:
  -- { "<name>": { "status": "PENDING"|"APPROVED"|"REJECTED", "language": "en_US" } }
  templates jsonb not null default '{}'::jsonb,
  -- Soft pause: webhook routing, sends, and the sidebar item all gate on
  -- this (Embedded Signup is one-shot, so unlike meta_connections there is
  -- no pending/picker state).
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_whatsapp_connections_business
  on public.whatsapp_connections (business_id);

-- One tenant per phone number id — webhook deliveries route through this.
create unique index if not exists uq_whatsapp_connections_phone_number
  on public.whatsapp_connections (phone_number_id);

alter table public.whatsapp_connections enable row level security;

comment on table public.whatsapp_connections is
  'Per-tenant WhatsApp Business (Cloud API) connection from Embedded Signup. RLS on, no policies: service-role only. phone_number_id routes inbound webhooks and outbound sends.';

-- ---------------------------------------------------------------------
-- WhatsApp joins the conversation pipeline: platform widens, and for
-- whatsapp rows page_id stores the PHONE NUMBER ID (the business-side
-- account key) while psid stores the customer wa_id (their phone digits).
-- ---------------------------------------------------------------------
alter table public.messenger_conversations
  drop constraint if exists messenger_conversations_platform_check;
alter table public.messenger_conversations
  add constraint messenger_conversations_platform_check
  check (platform in ('messenger', 'instagram', 'whatsapp'));

comment on column public.messenger_conversations.page_id is
  'Business-side account key: Facebook Page id (messenger/instagram) or WhatsApp phone_number_id (whatsapp).';

-- ---------------------------------------------------------------------
-- 'whatsapp' becomes a first-class owner-alert delivery channel alongside
-- sms/email/dashboard, with its own preference toggle (default ON, same
-- fail-toward-delivering posture as the others).
-- ---------------------------------------------------------------------
alter table public.notifications
  drop constraint if exists notifications_delivery_channel_check;
alter table public.notifications
  add constraint notifications_delivery_channel_check
  check (delivery_channel in ('sms', 'email', 'dashboard', 'whatsapp'));

alter table public.notification_preferences
  add column if not exists whatsapp_urgent boolean not null default true;

comment on column public.notification_preferences.whatsapp_urgent is
  'Deliver urgent owner alerts over WhatsApp (requires a connected WhatsApp integration; sends use the owner_alert utility template outside the 24h window).';

-- ---------------------------------------------------------------------
-- 'whatsapp' joins the cross-channel contact interaction channels
-- (lead capture / rollups), same widening pattern as 'messenger'
-- (20260808010000).
-- ---------------------------------------------------------------------
alter table public.contacts
  drop constraint if exists customer_memories_last_channel_check;
alter table public.contacts
  add constraint customer_memories_last_channel_check
  check (last_channel in ('sms', 'voice', 'dashboard', 'email', 'webchat', 'messenger', 'whatsapp'));

-- Byte-for-byte the alias-aware definition from 20260808010000 with ONLY
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
  if p_channel not in ('sms', 'voice', 'dashboard', 'email', 'webchat', 'messenger', 'whatsapp') then
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

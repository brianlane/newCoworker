-- Staff mode, per coworker surface.
--
-- "Staff mode" is what happens when the OWNER or a roster team member
-- reaches the coworker on a channel customers also use. SMS has had this
-- since 20260701000000_staff_sms_mode.sql, stored as
-- business_telnyx_settings.staff_sms_assistant_reply_enabled: staff are
-- recognized, answered as staff, and never run through the lead-intake
-- script.
--
-- Every other channel had nothing. On WhatsApp in particular the owner
-- messaging their own business number reached the CUSTOMER assistant, was
-- pitched, and was filed as a lead. This table generalizes the SMS flag so
-- each surface carries its own answer.
--
-- What the flag means, and what it does NOT mean. ON: answer them as staff.
-- OFF: do not answer them at all. It is never "answer them as a customer",
-- which is the behavior this whole change exists to remove. That matches
-- the SMS flag's existing semantics exactly (off means the assistant stays
-- silent, not that the owner becomes a lead).
--
-- No CHECK constraint on surface_key on purpose. The application validates
-- it against src/lib/owner-surfaces/registry.ts, and the point of that
-- registry is that adding a surface is one entry plus a caller. A CHECK here
-- would make it one entry, a caller, AND a migration, which is the cost this
-- work is removing. The table is service-role only, so the app is the sole
-- writer.
create table if not exists public.coworker_staff_mode (
  business_id uuid not null references public.businesses(id) on delete cascade,
  surface_key text not null,
  assistant_reply_enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (business_id, surface_key)
);

alter table public.coworker_staff_mode enable row level security;
grant select, insert, update, delete on table public.coworker_staff_mode to service_role;

comment on table public.coworker_staff_mode is
  'Per-surface staff mode: when the owner or a roster member reaches the coworker on this surface, answer them as staff. A missing row means the default (enabled). surface_key is validated by the app against the owner-surface registry, deliberately not by a CHECK constraint.';
comment on column public.coworker_staff_mode.assistant_reply_enabled is
  'True: answer staff as staff. False: do not answer them on this surface. Never means "answer them as a customer".';

-- Carry every tenant's existing SMS choice across, so an owner who turned
-- staff replies OFF stays off. Businesses with no telnyx settings row are
-- left absent, which resolves to the same default (enabled) they have today.
insert into public.coworker_staff_mode (business_id, surface_key, assistant_reply_enabled)
select
  s.business_id,
  'sms',
  coalesce(s.staff_sms_assistant_reply_enabled, true)
from public.business_telnyx_settings s
where s.business_id is not null
on conflict (business_id, surface_key) do nothing;

-- The old column keeps its data but loses every reader: the SMS webhook, the
-- dashboard card, and the API route all move to the table above in this same
-- change. Left in place rather than dropped so a rollback still has the
-- values, and re-commented so nobody wires a new reader to it.
comment on column public.business_telnyx_settings.staff_sms_assistant_reply_enabled is
  'SUPERSEDED by public.coworker_staff_mode (surface_key = ''sms''), which every reader now uses. Retained for rollback only. Do not read or write this column.';

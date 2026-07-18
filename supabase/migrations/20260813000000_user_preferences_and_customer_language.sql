-- Owner UI locale preference (explicit opt-in; default English).
-- Customer language on contacts/conversations (AI channels).

create table if not exists public.user_preferences (
  user_id uuid primary key references auth.users (id) on delete cascade,
  ui_locale text not null default 'en' check (ui_locale in ('en', 'es')),
  updated_at timestamptz not null default now()
);

alter table public.user_preferences enable row level security;

comment on table public.user_preferences is
  'Per-auth-user UI locale (en/es). RLS on with no policies — service-role only; reads/writes via Next.js after auth.';

-- Customer-facing language (AI channels).
alter table public.contacts
  add column if not exists preferred_language text null,
  add column if not exists language_source text null
    check (language_source is null or language_source in ('detected', 'owner_set'));

comment on column public.contacts.preferred_language is
  'BCP-47 language tag (en, es) for AI replies across SMS/voice/webchat/Messenger.';
comment on column public.contacts.language_source is
  'detected = set by classification; owner_set = manual override, never overwritten by detection.';

alter table public.messenger_conversations
  add column if not exists preferred_language text null;

comment on column public.messenger_conversations.preferred_language is
  'Cached language for Messenger/WhatsApp threads; falls back to contacts.preferred_language.';

-- Business defaults for system paths (IVR, ambiguous inbound).
alter table public.businesses
  add column if not exists default_customer_language text not null default 'en'
    check (default_customer_language in ('en', 'es')),
  add column if not exists supported_customer_languages text[] not null default '{en,es}';

comment on column public.businesses.default_customer_language is
  'Fallback customer language when inbound is ambiguous (IVR speak-only, missed-call auto-text).';
comment on column public.businesses.supported_customer_languages is
  'Languages the AI may follow; default en+es. Restrict to {en} to disable Spanish.';

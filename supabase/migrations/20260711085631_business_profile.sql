-- Business profile (Settings → Business profile card).
--
-- Structured facts the owner edits in the dashboard: street address and
-- per-day business hours. Industry (business_type) and phone already live on
-- the businesses row. The app renders these columns into a canonical
-- markdown block stored at business_configs.profile_md, so every prompt
-- composer (deploy-client.sh at provision, sync-vault on each save, the
-- knowledge-lookup tool) reads ONE string instead of re-deriving hours
-- formatting in three languages.
--
-- business_hours shape (validated app-side in src/lib/business-profile):
--   { "mon": { "open": "09:00", "close": "17:00" }, "tue": null, ... }
--   A missing day = not specified; an explicit null day = closed.

alter table public.businesses
  add column if not exists address text,
  add column if not exists business_hours jsonb;

alter table public.business_configs
  add column if not exists profile_md text not null default '';

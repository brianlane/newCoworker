-- Backfill: this migration was applied to the remote database (PR #179, "enable
-- new automations by default on creation") but its file was never committed, so
-- local migration history drifted from remote. Re-adding the exact statement at
-- its real remote version keeps `supabase db push` / `migration list` consistent.
alter table public.ai_flows alter column enabled set default true;

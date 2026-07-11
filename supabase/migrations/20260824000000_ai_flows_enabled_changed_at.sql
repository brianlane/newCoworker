-- ---------------------------------------------------------------------------
-- ai_flows.enabled_changed_at — when the flow was last turned on/off.
--
-- The dashboard shows "on/off since ..." next to each flow's status pill.
-- updated_at can't serve: it bumps on every definition edit. A BEFORE UPDATE
-- row trigger stamps the column only when `enabled` actually flips
-- (IS DISTINCT FROM), so editor saves that resend the same enabled value and
-- unrelated patches never move the timestamp. NULL = never toggled since
-- creation (the UI falls back to created_at).
-- ---------------------------------------------------------------------------

alter table public.ai_flows
  add column if not exists enabled_changed_at timestamptz;

comment on column public.ai_flows.enabled_changed_at is
  'When enabled last CHANGED (stamped by trg_ai_flows_enabled_changed only on an actual flip; never by unrelated updates). NULL = untouched since creation.';

create or replace function public.ai_flows_stamp_enabled_change()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.enabled is distinct from old.enabled then
    new.enabled_changed_at = now();
  end if;
  return new;
end;
$$;

comment on function public.ai_flows_stamp_enabled_change is
  'BEFORE UPDATE trigger fn: stamps ai_flows.enabled_changed_at when enabled flips. search_path pinned per repo convention; EXECUTE is auto-revoked from anon/authenticated by the fn_grants_lockdown event trigger.';

drop trigger if exists trg_ai_flows_enabled_changed on public.ai_flows;
create trigger trg_ai_flows_enabled_changed
  before update on public.ai_flows
  for each row
  execute function public.ai_flows_stamp_enabled_change();

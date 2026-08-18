-- Undo for AiFlow edits: snapshot the prior definition on every change.
--
-- Until now `ai_flows.definition` was overwritten in place with NO history
-- anywhere. That is fine for a human editing one flow in the dashboard and
-- badly wrong for the AI paths: the owner coworker's `edit_aiflow` tool and
-- the MCP `update_flow` tool both replace a LIVE automation's whole
-- definition, and `edit_aiflow` regenerates it through a model rather than
-- patching it, so an unwanted change is not reconstructible after the fact.
-- The only rollback that existed was by hand: one-shot scripts stashing a
-- `previous_definition` blob in applied_oneshots.details, which covers
-- scripts and nothing else.
--
-- A TRIGGER, not an app-code helper, for the reason the ai_flow_runs
-- revision counter gives: writers do not opt in, so a forgetful path cannot
-- skip it. That matters here more than there, because `ai_flows` has many
-- writers outside src/lib (dozens of debug/ and scripts/oneshot/ scripts
-- write the table directly through PostgREST).
--
-- Attribution degrades, the snapshot does not. A row-level trigger cannot
-- see application context, so writers stamp `edit_source` / `edit_actor` in
-- the same UPDATE and the trigger copies them onto the version row. A writer
-- that forgets records the version with a null source: the load-bearing part
-- (the old bytes) is never at the writer's discretion.
--
-- Those two columns are WRITE-ONLY carriers, not stored state: the trigger
-- consumes them and nulls them on every update, so they always read back
-- null. Persisting them would be actively worse than useless. A column that
-- kept its value would be inherited by the NEXT writer that forgot to stamp,
-- so an unattributed edit by a debug script would be recorded as having come
-- from whichever surface edited the flow last. A false attribution in an
-- audit trail is worse than an absent one.
--
-- Nothing is lost by not persisting them: a version row records the source
-- of the edit that REPLACED it, so the newest row's source is the provenance
-- of the definition that is live right now.

-- ---------------------------------------------------------------------------
-- Attribution columns on the flow itself.
-- ---------------------------------------------------------------------------
alter table public.ai_flows
  add column if not exists edit_source text,
  add column if not exists edit_actor text;

comment on column public.ai_flows.edit_source is
  'WRITE-ONLY carrier, always reads back null. Set it in the same UPDATE that changes a definition ("dashboard", "ai_edit_sms", "mcp", "oneshot", ...) and the snapshot trigger copies it onto the version row, then clears it. Never SELECT this to learn who edited a flow: read ai_flow_definition_versions instead, whose newest row carries the provenance of the live definition.';
comment on column public.ai_flows.edit_actor is
  'WRITE-ONLY carrier for the actor behind the edit: an auth user id, an owner phone in E.164, or a script basename. Free-form on purpose, since the surfaces that write it do not share an identity type. Cleared by the trigger like edit_source.';

-- ---------------------------------------------------------------------------
-- The version history.
-- ---------------------------------------------------------------------------
create table if not exists public.ai_flow_definition_versions (
  id bigint generated always as identity primary key,
  flow_id uuid not null references public.ai_flows(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- The definition/name/enabled state as it was BEFORE the edit that created
  -- this row. Restoring a version means writing these three back.
  definition jsonb not null,
  name text not null,
  enabled boolean not null,
  -- Provenance of the edit that REPLACED the snapshot above (not of the
  -- snapshot itself), copied from the ai_flows.edit_* carrier by the trigger.
  source text,
  actor text,
  replaced_at timestamptz not null default now()
);

-- The only read pattern: newest-first history for one flow ("undo the last
-- change", "what did the AI change last night?").
create index if not exists ai_flow_definition_versions_flow_idx
  on public.ai_flow_definition_versions (flow_id, replaced_at desc);

-- Tenant-wide sweep for the same question across every flow.
create index if not exists ai_flow_definition_versions_business_idx
  on public.ai_flow_definition_versions (business_id, replaced_at desc);

alter table public.ai_flow_definition_versions enable row level security;

-- Service-role-only (RLS on, zero policies): history is read through the
-- Next.js routes with requireOwner, matching ai_flow_runs' posture.
grant select, insert, update, delete
  on table public.ai_flow_definition_versions to service_role;

-- ---------------------------------------------------------------------------
-- The snapshot trigger.
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER so the insert lands regardless of the writing role's
-- grants on the history table (same pattern as residency_journal): a flow
-- write must never fail because the writer cannot append its own audit row.
create or replace function public.tg_ai_flows_snapshot_definition()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  -- Definition or name only. An enabled-only flip (set_flow_enabled, the
  -- dashboard toggle) is already tracked by enabled_changed_at, and
  -- snapshotting it would bury real edits under toggle churn.
  if old.definition is distinct from new.definition
     or old.name is distinct from new.name then
    insert into public.ai_flow_definition_versions
      (flow_id, business_id, definition, name, enabled, source, actor)
    values (
      old.id,
      old.business_id,
      old.definition,
      old.name,
      old.enabled,
      nullif(btrim(coalesce(new.edit_source, '')), ''),
      nullif(btrim(coalesce(new.edit_actor, '')), '')
    );
  end if;
  -- Consume the carrier on EVERY update, including one that changed only
  -- `enabled`. Clearing it only inside the branch above would leave a stamp
  -- sitting on the row for the next writer that forgot to set one, which is
  -- precisely the false attribution these columns must not produce.
  new.edit_source := null;
  new.edit_actor := null;
  return new;
end;
$$;

drop trigger if exists ai_flows_snapshot_definition on public.ai_flows;
create trigger ai_flows_snapshot_definition
  before update on public.ai_flows
  for each row execute function public.tg_ai_flows_snapshot_definition();

-- grants: none (tg_ai_flows_snapshot_definition): trigger function, runs as
-- owner and is never called through PostgREST.

comment on table public.ai_flow_definition_versions is
  'Append-only history of AiFlow definitions. One row per definition/name change, written by the ai_flows_snapshot_definition trigger and holding the state as it was BEFORE that change, so any edit (dashboard, AI tool, MCP, one-shot, hand-run SQL) is reversible.';
comment on column public.ai_flow_definition_versions.source is
  'Provenance of the edit that replaced this snapshot, copied from the ai_flows.edit_source carrier. Null when the writer did not stamp one.';

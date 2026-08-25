-- Custom tables: owner-defined data tables (Airtable-style).
--
-- The platform tracks contacts, leads, deals, to-dos, documents, bookings.
-- It has never let an owner define a table of their OWN: properties,
-- equipment, policies, job sites, inventory. This adds that, with the AI
-- coworker able to read and write it.
--
-- STORAGE ASYMMETRY, the one design decision worth reading twice:
--   custom_tables.fields is JSONB      - column DEFINITIONS are few, always
--                                        read together, and rewritten as a
--                                        set, so they follow the
--                                        booking_pages.intake_questions
--                                        pattern (validated app-side in
--                                        src/lib/custom-tables/core.ts).
--   custom_table_rows is real rows     - VALUES are many, written
--                                        individually, and need a real
--                                        contact_id foreign key. One JSONB
--                                        array of rows would make every row
--                                        write a whole-column rewrite of the
--                                        entire table and cap a table at one
--                                        TOAST budget.
--
-- Row values key on the field's OPAQUE ID, never its label. Renaming a
-- column is then a one-row write instead of a rewrite of every row, which is
-- the trap business_documents.record_fields (keyed by human name) sits in.
--
-- Caps live in src/lib/custom-tables/types.ts: 10 tables per business, 20
-- columns per table, 5000 rows per table. The row cap and the column-delete
-- sweep are TIED: the sweep that strips a removed field id from every row is
-- bounded only because rows are bounded. Raising one means revisiting the
-- other.
--
-- Deliberately NOT in v1, so scope creep has to argue with a written
-- decision: formulas, rollups, lookups, relations between two custom tables,
-- datetime columns, money columns (deals uses integer cents precisely so
-- nothing does float money math), saved views, per-table permissions.
--
-- RESIDENCY: central-only by design, NOT a RESIDENCY_MOVED_TABLES member.
-- The payload is a JSONB blob whose shape changes per tenant and per owner
-- edit, so the box-schema column lockstep guard could only ever check the
-- envelope. See src/lib/residency/tables.ts for the admission rule.
--
-- Security posture: RLS on with NO policies, service-role only, identical to
-- todos / deals / business_documents. Every access goes through the Next.js
-- server (dashboard routes, /api/rowboat/tool-call, the MCP server) after
-- its own auth checks.

-- ---------------------------------------------------------------------------
-- The table definitions.
-- ---------------------------------------------------------------------------
create table public.custom_tables (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- Display name, unique per business (case-insensitive) because the AI
  -- tools resolve a table BY NAME. Dropping that uniqueness would mean
  -- redesigning the tool layer first, not just the index.
  name text not null check (char_length(name) between 1 and 60),
  description text,
  -- Lucide icon key, clamped to a small allowlist in types.ts.
  icon text,
  -- 'standalone' = a row is just a row. 'contact' = every row belongs to one
  -- contact. Chosen at creation; changeable only while the table is empty.
  row_link text not null default 'standalone'
    check (row_link in ('standalone', 'contact')),
  -- Ordered column definitions:
  -- [{ id, label, help?, type, options?, required, enabled }]
  -- `id` is an opaque slug, NOT the label. See the header note.
  fields jsonb not null default '[]'::jsonb check (jsonb_typeof(fields) = 'array'),
  position integer not null default 0,
  -- Soft delete, so an AI-initiated "delete my Equipment table" is
  -- recoverable. Rows are NOT touched: restore is one stamp-clear. The daily
  -- sweep hard-deletes after CUSTOM_TABLE_TRASH_RETENTION_DAYS, which
  -- cascades the rows away, so a soft delete never extends data lifetime.
  deleted_at timestamptz,
  deleted_by uuid,
  -- WRITE-ONLY carriers, always read back null: the snapshot trigger copies
  -- them onto the version row and clears them on every update. Same contract
  -- as ai_flows.edit_source / edit_actor.
  edit_source text,
  edit_actor text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Partial so a restored table cannot collide with a live same-named one, and
-- so a soft-deleted "Properties" does not block making a new "Properties".
create unique index idx_custom_tables_business_name
  on public.custom_tables (business_id, lower(name))
  where deleted_at is null;

-- The directory's exact read: one business's tables in display order. Leads
-- with business_id, so it also covers that foreign key.
create index idx_custom_tables_business_position
  on public.custom_tables (business_id, position);

-- The trash sweep's read.
create index idx_custom_tables_deleted
  on public.custom_tables (deleted_at)
  where deleted_at is not null;

comment on table public.custom_tables is
  'Owner-defined data tables (Airtable-style). Column definitions live in `fields` jsonb, booking_pages.intake_questions pattern, validated in src/lib/custom-tables/core.ts. Row storage is public.custom_table_rows, one row per record. Central-only: deliberately not a RESIDENCY_MOVED_TABLES member.';
comment on column public.custom_tables.row_link is
  'standalone = rows stand alone; contact = each row belongs to a contact (custom_table_rows.contact_id). Chosen at creation, changeable only while the table has no rows.';
comment on column public.custom_tables.fields is
  'Ordered column definitions [{id,label,help,type,options,required,enabled}]. `id` is an opaque slug, NOT the label: rows key on it so a rename never rewrites rows.';
comment on column public.custom_tables.deleted_at is
  'Soft delete so a deleted table is restorable (the AI can delete one). Rows are untouched; the daily sweep hard-deletes the table later, cascading them.';
comment on column public.custom_tables.edit_source is
  'WRITE-ONLY carrier, always reads back null. Set it in the same UPDATE that changes the table ("dashboard", "ai_edit_dashboard", "mcp", ...) and the snapshot trigger copies it onto the version row, then clears it. Read custom_table_versions to learn who changed what.';
comment on column public.custom_tables.edit_actor is
  'WRITE-ONLY carrier for the actor behind the change: an auth user id, an owner phone in E.164, or a script basename. Cleared by the trigger like edit_source.';

-- ---------------------------------------------------------------------------
-- The rows.
-- ---------------------------------------------------------------------------
create table public.custom_table_rows (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  table_id uuid not null references public.custom_tables(id) on delete cascade,
  -- The contact this row is about (business_documents.contact_id pattern):
  -- SET NULL, never cascade, so deleting a person keeps the record. Always
  -- nullable even on a contact-linked table, for exactly that reason.
  contact_id uuid references public.contacts(id) on delete set null,
  -- fieldId -> value. Scalars and string[] only, never nested objects.
  -- Named field_values, NOT `values`: that is a reserved word in Postgres
  -- and any hand-written `insert into ... (values)` would break.
  field_values jsonb not null default '{}'::jsonb
    check (jsonb_typeof(field_values) = 'object'),
  edit_source text,
  edit_actor text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The grid read: one table's rows, newest first. Leads with table_id, so it
-- covers that foreign key too.
create index idx_custom_table_rows_table
  on public.custom_table_rows (table_id, created_at desc);

-- FK-covering single-column btrees (house rule from
-- 20260812000100_fk_covering_indexes.sql): Postgres does not auto-index the
-- referencing side, so deleting a business or a contact would otherwise
-- seq-scan this table per parent row inside the cascade / SET NULL trigger.
create index idx_custom_table_rows_business_id
  on public.custom_table_rows (business_id);
create index idx_custom_table_rows_contact_id
  on public.custom_table_rows (contact_id);

-- The contact-profile panel read ("what records does this person have?").
create index idx_custom_table_rows_business_contact
  on public.custom_table_rows (business_id, contact_id)
  where contact_id is not null;

-- The AI's "find the row where Status is Won" path runs as a jsonb
-- containment query. jsonb_path_ops is the smaller, @>-only opclass, which
-- is all that path needs. This is the one index to drop first if write
-- amplification ever bites.
create index idx_custom_table_rows_values
  on public.custom_table_rows using gin (field_values jsonb_path_ops);

comment on table public.custom_table_rows is
  'One record in an owner-defined custom table. field_values is fieldId -> scalar, validated against the parent table''s `fields` on every write. Caps (10 tables/business, 20 fields/table, 5000 rows/table) live in src/lib/custom-tables/types.ts; the row cap is what bounds the column-delete sweep.';
comment on column public.custom_table_rows.contact_id is
  'Contact this row is about (business_documents.contact_id pattern). NULL = unlinked. SET NULL when the contact is deleted, so the record survives the person.';
comment on column public.custom_table_rows.field_values is
  'fieldId -> string | number | boolean | string[]. Keyed by the OPAQUE field id from custom_tables.fields, never the human label. An absent key means empty; nulls are never stored.';

-- ---------------------------------------------------------------------------
-- The history.
-- ---------------------------------------------------------------------------
-- Why this exists: the AI coworker can delete a row, delete a column, and
-- soft-delete a whole table. ai_flow_definition_versions (20260822182135)
-- established the answer for AiFlows and this is the same shape, including
-- the write-only attribution carriers.
--
-- One difference, deliberate: table_id is NOT a foreign key. AiFlow versions
-- cascade on flow_id because deleting a flow is final; here the entire point
-- is that a deleted table can come back, so its history has to outlive the
-- eventual hard delete.
create table public.custom_table_versions (
  id bigint generated always as identity primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- Intentionally not a foreign key. See above.
  table_id uuid not null,
  -- Set for row_updated / row_deleted, null for the table-level kinds.
  row_id uuid,
  kind text not null check (kind in (
    'schema', 'table_deleted', 'table_restored', 'row_updated', 'row_deleted'
  )),
  -- The state BEFORE the change. Restoring means writing these back.
  name text,
  description text,
  row_link text,
  fields jsonb,
  field_values jsonb,
  contact_id uuid,
  -- Provenance of the change that REPLACED the snapshot above (not of the
  -- snapshot itself), copied from the edit_* carriers by the trigger.
  source text,
  actor text,
  replaced_at timestamptz not null default now()
);

-- The only read pattern: newest-first history for one table.
create index custom_table_versions_table_idx
  on public.custom_table_versions (table_id, replaced_at desc);

-- Tenant-wide sweep for the same question across every table, and the FK
-- cover for business_id.
create index custom_table_versions_business_idx
  on public.custom_table_versions (business_id, replaced_at desc);

comment on table public.custom_table_versions is
  'Append-only history of custom-table changes: schema edits, table soft-delete/restore, and row updates/deletes. Written by triggers (writers cannot opt out) and holding the state as it was BEFORE each change, so any change made from the dashboard, an AI tool, or a connector is reversible.';
comment on column public.custom_table_versions.table_id is
  'Deliberately NOT a foreign key: a soft-deleted table can be restored, and its history must survive the eventual hard delete rather than cascading with it.';
comment on column public.custom_table_versions.source is
  'Provenance of the change that replaced this snapshot, copied from the edit_source carrier. Null when the writer did not stamp one, which reads as "nobody said", never as a surface.';

-- ---------------------------------------------------------------------------
-- Snapshot triggers.
-- ---------------------------------------------------------------------------
-- Triggers rather than app-code helpers for the reason the AiFlow snapshot
-- gives: writers do not opt in, so a forgetful path cannot skip the history.
-- SECURITY DEFINER so the insert lands regardless of the writing role's
-- grants (same pattern as residency_journal): a write must never fail
-- because the writer cannot append its own audit row.

create or replace function public.tg_custom_tables_snapshot()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_kind text;
begin
  if old.deleted_at is null and new.deleted_at is not null then
    v_kind := 'table_deleted';
  elsif old.deleted_at is not null and new.deleted_at is null then
    v_kind := 'table_restored';
  elsif old.name is distinct from new.name
     or old.description is distinct from new.description
     or old.row_link is distinct from new.row_link
     or old.fields is distinct from new.fields then
    v_kind := 'schema';
  end if;

  if v_kind is not null then
    insert into public.custom_table_versions
      (business_id, table_id, kind, name, description, row_link, fields, source, actor)
    values (
      old.business_id,
      old.id,
      v_kind,
      old.name,
      old.description,
      old.row_link,
      old.fields,
      nullif(btrim(coalesce(new.edit_source, '')), ''),
      nullif(btrim(coalesce(new.edit_actor, '')), '')
    );
  end if;

  -- Consume the carrier on EVERY update, including one that snapshotted
  -- nothing. Clearing it only inside the branch above would leave a stamp
  -- sitting on the row for the next writer that forgot to set one, which is
  -- precisely the false attribution these columns must not produce.
  new.edit_source := null;
  new.edit_actor := null;
  return new;
end;
$$;

drop trigger if exists custom_tables_snapshot on public.custom_tables;
create trigger custom_tables_snapshot
  before update on public.custom_tables
  for each row execute function public.tg_custom_tables_snapshot();

-- grants: none (tg_custom_tables_snapshot): trigger function, runs as owner
-- and is never called through PostgREST.

create or replace function public.tg_custom_table_rows_snapshot_update()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if old.field_values is distinct from new.field_values
     or old.contact_id is distinct from new.contact_id then
    insert into public.custom_table_versions
      (business_id, table_id, row_id, kind, field_values, contact_id, source, actor)
    values (
      old.business_id,
      old.table_id,
      old.id,
      'row_updated',
      old.field_values,
      old.contact_id,
      nullif(btrim(coalesce(new.edit_source, '')), ''),
      nullif(btrim(coalesce(new.edit_actor, '')), '')
    );
  end if;
  new.edit_source := null;
  new.edit_actor := null;
  return new;
end;
$$;

drop trigger if exists custom_table_rows_snapshot_update on public.custom_table_rows;
create trigger custom_table_rows_snapshot_update
  before update on public.custom_table_rows
  for each row execute function public.tg_custom_table_rows_snapshot_update();

-- grants: none (tg_custom_table_rows_snapshot_update): trigger function,
-- runs as owner and is never called through PostgREST.

-- A row delete is the unrecoverable one, so it always snapshots.
--
-- It is also the one place attribution cannot ride a carrier. A BEFORE
-- DELETE trigger has no NEW row, and pre-stamping the row in its own UPDATE
-- does not work either: that UPDATE fires the update trigger above, whose
-- job is to CONSUME the carrier, so the stamp is always gone by the time the
-- delete runs. The carrier is still read here for the case where a writer
-- sets it in the same statement, but it is normally null and
-- src/lib/custom-tables/db.ts labels the version row after the delete
-- instead. The snapshot itself stays the trigger's job either way, which is
-- the half that matters.
create or replace function public.tg_custom_table_rows_snapshot_delete()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.custom_table_versions
    (business_id, table_id, row_id, kind, field_values, contact_id, source, actor)
  values (
    old.business_id,
    old.table_id,
    old.id,
    'row_deleted',
    old.field_values,
    old.contact_id,
    nullif(btrim(coalesce(old.edit_source, '')), ''),
    nullif(btrim(coalesce(old.edit_actor, '')), '')
  );
  return old;
end;
$$;

drop trigger if exists custom_table_rows_snapshot_delete on public.custom_table_rows;
create trigger custom_table_rows_snapshot_delete
  before delete on public.custom_table_rows
  for each row execute function public.tg_custom_table_rows_snapshot_delete();

-- grants: none (tg_custom_table_rows_snapshot_delete): trigger function,
-- runs as owner and is never called through PostgREST.

-- ---------------------------------------------------------------------------
-- RLS and Data API grants.
-- ---------------------------------------------------------------------------
alter table public.custom_tables enable row level security;
alter table public.custom_table_rows enable row level security;
alter table public.custom_table_versions enable row level security;
-- No policies: service_role bypasses RLS; anon/authenticated denied by design.
grant select, insert, update, delete on table public.custom_tables to service_role;
grant select, insert, update, delete on table public.custom_table_rows to service_role;
grant select, insert, update, delete on table public.custom_table_versions to service_role;

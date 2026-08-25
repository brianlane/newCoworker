-- Apply a cell change atomically, so two edits at once cannot lose one.
--
-- The bug this fixes, caught by driving the real grid rather than by
-- reasoning: saving a cell was a read-modify-write in the app. Read the row,
-- merge the one changed cell onto it, write the whole bag back. Two cells
-- edited in quick succession both read the row BEFORE either wrote, so the
-- second write merged onto a stale bag and silently dropped the first.
--
-- That is not an exotic race. It is what a spreadsheet produces the moment
-- someone tabs between two cells quickly, and it gets worse once the AI
-- coworker writes to the same row while a person is typing in it. The
-- history table recorded it plainly: three updates, each snapshotting a
-- different prior state, and a value present in snapshot three missing from
-- the live row.
--
-- The merge now happens inside ONE statement, so Postgres' row lock does the
-- serializing and no read is involved:
--
--   field_values = (field_values || patch) - clear
--
-- `jsonb || jsonb` is a right-biased merge and `jsonb - text[]` drops keys,
-- which is exactly the "set these, clear those, leave the rest" semantics the
-- grid needs. p_replace swaps the merge for an overwrite, which is what
-- restoring an old snapshot needs: a merge could never take back a cell that
-- was filled in after the snapshot.
--
-- The BEFORE UPDATE snapshot trigger still fires, so history and attribution
-- are unchanged; the edit_* carriers are set in this same statement the way
-- every other writer sets them.

create or replace function public.custom_table_row_apply(
  p_table_id uuid,
  p_row_id uuid,
  p_patch jsonb,
  p_clear text[],
  p_replace boolean,
  p_set_contact boolean,
  p_contact_id uuid,
  p_edit_source text,
  p_edit_actor text
)
returns setof public.custom_table_rows
language sql
security definer
set search_path = pg_catalog, public
as $$
  update public.custom_table_rows
     set field_values = (
           case when p_replace then coalesce(p_patch, '{}'::jsonb)
                else field_values || coalesce(p_patch, '{}'::jsonb)
           end
         ) - coalesce(p_clear, '{}'::text[]),
         contact_id = case when p_set_contact then p_contact_id else contact_id end,
         edit_source = p_edit_source,
         edit_actor = p_edit_actor,
         updated_at = now()
   where table_id = p_table_id
     and id = p_row_id
  returning *;
$$;

comment on function public.custom_table_row_apply is
  'Atomically set and clear cells on one custom-table row. Replaces the app-side read-modify-write, which lost a cell whenever two edits overlapped. Merge is (field_values || patch) - clear; p_replace overwrites instead, for restoring a snapshot.';

grant execute on function public.custom_table_row_apply(
  uuid, uuid, jsonb, text[], boolean, boolean, uuid, text, text
) to service_role;

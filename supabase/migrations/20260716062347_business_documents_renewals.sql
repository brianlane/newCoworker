-- ---------------------------------------------------------------------------
-- Documents: contact linkage + renewal tracking (generic record layer).
--
-- A business document can now be a RECORD attached to a person — an insurance
-- policy, lease, service contract, membership, certificate — not just a
-- knowledge-library upload:
--
--   contact_id            - the contact this document belongs to (policy
--                           holder, tenant, member). ON DELETE SET NULL:
--                           deleting the contact keeps the document as an
--                           unlinked library item. Contact merges re-point
--                           linked documents to the surviving profile (see
--                           the merge_customer_memories update below).
--   renewal_date          - when this document is due for renewal. DISTINCT
--                           from expires_at: a renewal keeps the document
--                           active (the daily sweep reminds the assigned
--                           employee / owner ahead of it), while expiry
--                           removes the document from knowledge lookups and
--                           sharing. Both may be set.
--   assigned_employee_id  - roster member (ai_flow_team_members) who handles
--                           the renewal. ON DELETE SET NULL: removing the
--                           employee falls back to owner-only reminders.
--   renewal_due_notified_at - one-reminder-per-state stamp for the daily
--                           sweep (armed/cleared like
--                           expiring_soon_notified_at). Reset whenever the
--                           owner changes renewal_date.
-- ---------------------------------------------------------------------------

alter table public.business_documents
  add column if not exists contact_id uuid
    references public.contacts(id) on delete set null,
  add column if not exists renewal_date timestamptz,
  add column if not exists assigned_employee_id uuid
    references public.ai_flow_team_members(id) on delete set null,
  add column if not exists renewal_due_notified_at timestamptz;

-- Contact page "documents on file" lookup.
create index if not exists idx_business_documents_contact
  on public.business_documents (business_id, contact_id)
  where contact_id is not null;

-- Daily renewal sweep scan + renewal-pipeline reporting.
create index if not exists idx_business_documents_renewal
  on public.business_documents (business_id, renewal_date)
  where renewal_date is not null;

comment on column public.business_documents.contact_id is
  'Contact this document belongs to (policy holder / tenant / member). NULL = plain knowledge-library document. Contact-linked records do not count toward the tier document cap. SET NULL when the contact is deleted; contact merges re-point to the survivor.';
comment on column public.business_documents.renewal_date is
  'When the document is due for renewal. Unlike expires_at (which retires the document from knowledge/sharing), a renewal date keeps it active — the daily sweep reminds the assigned employee/owner ahead of it. Date-only owner input maps to end-of-day UTC.';
comment on column public.business_documents.assigned_employee_id is
  'Roster member (ai_flow_team_members) responsible for handling this document''s renewal. SET NULL when the employee is removed.';
comment on column public.business_documents.renewal_due_notified_at is
  'One-reminder-per-state stamp for the renewal sweep, mirroring expiring_soon_notified_at. Reset when renewal_date changes so the new date re-arms the reminder.';

-- ---------------------------------------------------------------------------
-- Contact merges must carry linked documents to the surviving profile.
-- merge_customer_memories deletes the from-row, and the FK's SET NULL would
-- silently unlink that contact's documents. Recreate the function (latest
-- definition from 20260704000000_contacts_unify.sql) with one addition:
-- re-point business_documents.contact_id before the delete.
-- ---------------------------------------------------------------------------

create or replace function public.merge_customer_memories(
  p_business_id uuid,
  p_from_e164 text,
  p_into_e164 text
)
returns public.contacts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_from public.contacts;
  v_into public.contacts;
  v_summary text;
  v_pinned text;
  v_from_last timestamptz;
  v_into_last timestamptz;
begin
  if p_from_e164 = p_into_e164 then
    raise exception 'merge_customer_memories: cannot merge a customer into itself';
  end if;

  -- Deterministic lock order (by e164) so two concurrent opposite-direction
  -- merges deadlock-proof into "second one errors on a missing row" instead.
  if p_from_e164 < p_into_e164 then
    select * into v_from from public.contacts
      where business_id = p_business_id and customer_e164 = p_from_e164 for update;
    select * into v_into from public.contacts
      where business_id = p_business_id and customer_e164 = p_into_e164 for update;
  else
    select * into v_into from public.contacts
      where business_id = p_business_id and customer_e164 = p_into_e164 for update;
    select * into v_from from public.contacts
      where business_id = p_business_id and customer_e164 = p_from_e164 for update;
  end if;

  if v_from.id is null then
    raise exception 'merge_customer_memories: source customer % not found', p_from_e164;
  end if;
  if v_into.id is null then
    raise exception 'merge_customer_memories: target customer % not found', p_into_e164;
  end if;

  v_summary := left(
    nullif(concat_ws(e'\n\n',
      nullif(trim(coalesce(v_into.summary_md, '')), ''),
      nullif(trim(coalesce(v_from.summary_md, '')), '')
    ), ''),
    4000
  );
  v_pinned := left(
    nullif(concat_ws(e'\n\n',
      nullif(trim(coalesce(v_into.pinned_md, '')), ''),
      nullif(trim(coalesce(v_from.pinned_md, '')), '')
    ), ''),
    2000
  );
  v_from_last := coalesce(v_from.last_interaction_at, '-infinity'::timestamptz);
  v_into_last := coalesce(v_into.last_interaction_at, '-infinity'::timestamptz);

  update public.contacts
     set display_name = coalesce(nullif(trim(coalesce(v_into.display_name, '')), ''), v_from.display_name),
         summary_md = v_summary,
         pinned_md = v_pinned,
         email = coalesce(v_into.email, v_from.email),
         interaction_count = v_into.interaction_count + v_from.interaction_count,
         total_interaction_count = v_into.total_interaction_count + v_from.total_interaction_count,
         last_interaction_at = nullif(greatest(v_from_last, v_into_last), '-infinity'::timestamptz),
         last_channel = case
           when v_from_last > v_into_last then coalesce(v_from.last_channel, v_into.last_channel)
           else coalesce(v_into.last_channel, v_from.last_channel)
         end,
         created_at = least(v_into.created_at, v_from.created_at),
         alias_e164s = (
           select coalesce(array_agg(distinct a), '{}'::text[])
           from unnest(v_into.alias_e164s || v_from.alias_e164s || array[v_from.customer_e164]) as a
           where a is not null and a <> v_into.customer_e164
         ),
         updated_at = now()
   where id = v_into.id
  returning * into v_into;

  -- Carry linked documents (policies, contracts, records) to the survivor
  -- BEFORE the delete; otherwise the FK's ON DELETE SET NULL silently
  -- orphans them from the person they belong to.
  update public.business_documents
     set contact_id = v_into.id,
         updated_at = now()
   where business_id = p_business_id
     and contact_id = v_from.id;

  delete from public.contacts where id = v_from.id;

  return v_into;
end;
$$;

revoke all on function public.merge_customer_memories(uuid, text, text) from public;
grant execute on function public.merge_customer_memories(uuid, text, text)
  to service_role;

comment on function public.merge_customer_memories(uuid, text, text) is
  'Folds contacts(from) into contacts(into) for one business: concatenated summary/pinned (capped), summed counters, earliest first-seen, newest last-interaction, inherited email, the from-number recorded in alias_e164s, and linked business_documents re-pointed to the survivor. Deletes the from row. Service-role only; the API route enforces ownership.';

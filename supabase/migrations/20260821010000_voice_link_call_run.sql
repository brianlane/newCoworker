-- Link a parked flow run to the AI call it is waiting on.
--
-- The other half of voice_set_call_brief. That one pushes details INTO a live
-- call; a `wait_for_call` step waits for the call to END and then continues with
-- whatever the AI got out of the person. On a referral line the partner
-- withholds the customer's phone number until after the call, so the
-- conversation is frequently the only source for it, and the follow-up (contact
-- record, the QT email, handing the details to the agent) cannot run until it is
-- over.
--
-- Stamping the link is a read-modify-write on the same jsonb the bridge and
-- voice_set_call_brief also write, so it happens HERE rather than in the worker:
-- jsonb_set under the row lock cannot lose a concurrent mid-call brief the way a
-- select-then-update round trip can.
--
-- Targeted by (business, caller) for the same reason voice_set_call_brief is:
-- the flow run knows which partner line was involved, never which
-- call_control_id the partner happened to dial with. Scoped to a session that is
-- actually running the AI (`status = 'ai_intake'`) and started inside
-- p_within_minutes, so a run can never park on a finished call (which would
-- never resume it) or on an unrelated later one.
--
-- Returns the number of sessions linked: 0 means "nothing live to wait for", and
-- the caller continues instead of parking.
create or replace function public.voice_link_call_run(
  p_business_id uuid,
  p_from_e164 text,
  p_link jsonb,
  p_within_minutes int default 30
)
returns int
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_window interval := make_interval(mins => greatest(coalesce(p_within_minutes, 30), 1));
  v_updated int := 0;
begin
  if p_business_id is null or p_link is null or jsonb_typeof(p_link) <> 'object' then
    return 0;
  end if;

  update voice_handoff_sessions
  set context = jsonb_set(
        coalesce(context, '{}'::jsonb),
        '{flow_run}',
        p_link,
        true
      )
  where business_id = p_business_id
    and status = 'ai_intake'
    -- Never steal a call another run is already parked on: two runs resuming
    -- off one link would leave the loser waiting for its timeout sweep.
    and (context -> 'flow_run') is null
    and (p_from_e164 is null or btrim(p_from_e164) = '' or from_e164 = btrim(p_from_e164))
    and created_at > now() - v_window;

  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

comment on function public.voice_link_call_run(uuid, text, jsonb, int) is
  'Attach a parked ai_flow_run link to a live ai_intake handoff session so the call end resumes that run. Returns the number of sessions linked (0 = no live call).';

revoke execute on function public.voice_link_call_run(uuid, text, jsonb, int) from public;
grant execute on function public.voice_link_call_run(uuid, text, jsonb, int) to service_role;

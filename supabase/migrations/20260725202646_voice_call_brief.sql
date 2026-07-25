-- Mid-call brief for an AI-handled call: replace the live intake session's
-- `context_note` so the AI learns what the flow found while it is still talking.
--
-- The AI-first path (voice_ai_intake.answerFirst) answers a partner's call
-- within seconds of their alert text, long before the referral flow can open the
-- partner's portal. That read finishes about a minute into the call, so the
-- details it produces are useless unless they can reach a conversation already
-- in progress. A `voice_brief` flow step calls this; the on-box voice bridge
-- polls the field and, when it changes, briefs the model mid-conversation.
--
-- Targeted by (business, caller) rather than by call id because the flow run has
-- no idea which call_control_id the partner dialed with: it only knows which
-- partner line was involved. Scoped to sessions that are actually running the AI
-- (`status = 'ai_intake'`) and started inside p_within_minutes, so a brief can
-- never land on a finished call or on some unrelated later one.
create or replace function public.voice_set_call_brief(
  p_business_id uuid,
  p_from_e164 text,
  p_note text,
  p_within_minutes int default 30
)
returns int
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_note text := nullif(btrim(p_note), '');
  v_window interval := make_interval(mins => greatest(coalesce(p_within_minutes, 30), 1));
  v_updated int := 0;
begin
  if p_business_id is null or v_note is null then
    return 0;
  end if;

  -- APPENDS rather than replaces. The note already holds the pre-call brief
  -- built from the partner's alert text, and overwriting it would take away what
  -- the AI knows in exchange for whatever this run happened to extract. Skipped
  -- when the text is already present, so a re-run or a second brief carrying the
  -- same details cannot stack, and bounded so a chatty flow can never grow the
  -- model's prompt without limit.
  -- jsonb_set with create_if_missing so a takeover context that never carried a
  -- note gains one. ai_takeover is null only on chains with no AI configured,
  -- and those are excluded by the status filter anyway.
  update voice_handoff_sessions
  set context = jsonb_set(
        coalesce(context, '{}'::jsonb),
        '{ai_takeover,context_note}',
        to_jsonb(
          left(
            btrim(
              coalesce(context -> 'ai_takeover' ->> 'context_note', '') || ' ' || v_note
            ),
            2000
          )
        ),
        true
      )
  where business_id = p_business_id
    and position(v_note in coalesce(context -> 'ai_takeover' ->> 'context_note', '')) = 0
    and status = 'ai_intake'
    and context ? 'ai_takeover'
    and context -> 'ai_takeover' is not null
    and jsonb_typeof(context -> 'ai_takeover') = 'object'
    and (p_from_e164 is null or btrim(p_from_e164) = '' or from_e164 = btrim(p_from_e164))
    and created_at > now() - v_window;

  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

comment on function public.voice_set_call_brief(uuid, text, text, int) is
  'Replace the context_note on a business live ai_intake handoff sessions for a caller, so the voice bridge can brief the model mid-call. Returns the number of sessions updated.';

revoke execute on function public.voice_set_call_brief(uuid, text, text, int) from public;
grant execute on function public.voice_set_call_brief(uuid, text, text, int) to service_role;

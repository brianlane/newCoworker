-- Per-turn stats for platform-engine (direct Gemini) webchat jobs.
--
-- The engine already METERS each turn's cost into the shared AI budget
-- (owner_chat_model_spend), but nothing persisted the per-turn numbers, so
-- the admin Web chat view could not show spend per conversation. These
-- columns are written by the extended webchat_job_complete_platform RPC at
-- commit time; box-worker ('vps' engine) jobs leave them NULL — that
-- path's spend is metered by the worker against the same pool but is not
-- attributable per turn.
alter table webchat_jobs
  add column if not exists cost_micros bigint,
  add column if not exists model text,
  add column if not exists prompt_tokens integer,
  add column if not exists output_tokens integer,
  add column if not exists tool_rounds integer,
  add column if not exists refused_over_cap boolean;

comment on column webchat_jobs.cost_micros is
  'Micro-USD billed for this turn (platform Gemini engine only; same math the AI-budget meter records). NULL for box-worker turns.';
comment on column webchat_jobs.model is
  'Model that answered the turn (platform Gemini engine only).';
comment on column webchat_jobs.refused_over_cap is
  'True when the shared AI-budget fuse refused the turn (no Gemini call, zero cost).';

-- Extend the atomic completion RPC with the turn stats. The old 3-arg
-- signature is DROPPED (not overloaded): keeping both would make a
-- named-parameter PostgREST call with only the original three params
-- ambiguous. The new defaults keep the old call shape working during the
-- migration->app-deploy window.
drop function if exists webchat_job_complete_platform(uuid, text, text);

create or replace function webchat_job_complete_platform(
  p_job_id uuid,
  p_content text,
  p_history_marker text,
  p_cost_micros bigint default null,
  p_model text default null,
  p_prompt_tokens integer default null,
  p_output_tokens integer default null,
  p_tool_rounds integer default null,
  p_refused_over_cap boolean default null
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_job webchat_jobs%rowtype;
  v_msg_id bigint;
begin
  select * into v_job from webchat_jobs where id = p_job_id for update;
  if not found then
    raise exception 'webchat_job_complete_platform: job % not found', p_job_id;
  end if;
  if v_job.status = 'done' then
    -- Idempotent replay (a reclaim raced an already-committed turn).
    return v_job.assistant_message_id;
  end if;

  insert into webchat_messages (session_id, business_id, role, content)
  values (v_job.session_id, v_job.business_id, 'assistant', p_content)
  returning id into v_msg_id;

  -- Sticky history marker: flips the enqueue route to the full-tail input
  -- variant on later turns (multi-turn context parity with the worker).
  update webchat_sessions
     set last_seen_at = now(),
         rowboat_conversation_id = p_history_marker
   where id = v_job.session_id;

  update webchat_jobs
     set status = 'done',
         assistant_message_id = v_msg_id,
         completed_at = now(),
         error_code = null,
         error_detail = null,
         cost_micros = p_cost_micros,
         model = p_model,
         prompt_tokens = p_prompt_tokens,
         output_tokens = p_output_tokens,
         tool_rounds = p_tool_rounds,
         refused_over_cap = p_refused_over_cap
   where id = p_job_id;

  return v_msg_id;
end;
$$;

comment on function webchat_job_complete_platform is
  'Platform (Gemini) engine reply commit: assistant message + session history marker + job done + per-turn stats, atomically. Replay on a done job returns the existing assistant_message_id (no duplicate reply, no double bill).';

revoke all on function webchat_job_complete_platform(uuid, text, text, bigint, text, integer, integer, integer, boolean) from public;
grant execute on function webchat_job_complete_platform(uuid, text, text, bigint, text, integer, integer, integer, boolean) to service_role;

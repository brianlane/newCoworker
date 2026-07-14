-- Per-tenant reply engine for the website chat widget.
--
-- 'vps' (default): replies come from the tenant box's chat-worker claiming
-- webchat_jobs — the original Option-B pipeline (20260710213855).
--
-- 'gemini': replies are produced CENTRALLY by the platform's direct Gemini
-- responder (src/lib/webchat/gemini-engine.ts): the /api/widget/poll route
-- claims the queued job and runs the same restricted webchat tool surface
-- against Google's API. Grounding parity is structural — the engine builds
-- its system prompt from the SAME business_configs vault fields
-- (buildAgentInstructions) and the SAME pre-built job input_messages the
-- box agent would have received. Exists so a tenant with no live VPS (the
-- internal marketing-site pilot after its box returned to the adopt pool)
-- keeps a fully working webchat.
--
-- Admin-only knob (Admin -> business -> Web chat card); the owner-facing
-- settings surface never exposes it.
alter table chat_widget_settings
  add column if not exists reply_engine text not null default 'vps'
  constraint chat_widget_settings_reply_engine_check
  check (reply_engine in ('vps', 'gemini'));

comment on column chat_widget_settings.reply_engine is
  'Who answers widget turns: ''vps'' = tenant box chat-worker (default), ''gemini'' = platform-side direct Gemini responder (no VPS required). Admin-only.';

-- Make the box chat-worker HONOR the engine switch. The worker claims via
-- this RPC, so adding the predicate here applies fleet-wide instantly (no
-- worker redeploy): a tenant flipped to 'gemini' stops being claimable by
-- its (possibly still-live) box, and exactly one engine answers each job.
-- Body otherwise identical to 20260710213855.
create or replace function claim_webchat_job(p_worker_id text, p_business_id uuid)
returns setof webchat_jobs
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_id uuid;
begin
  select id into v_id
  from webchat_jobs
  where status = 'queued'
    and business_id = p_business_id
    -- Platform-answered tenants are invisible to the box worker.
    and not exists (
      select 1 from chat_widget_settings s
      where s.business_id = p_business_id
        and s.reply_engine = 'gemini'
    )
  order by created_at
  for update skip locked
  limit 1;

  if v_id is null then
    return;
  end if;

  return query
  update webchat_jobs
  set status = 'processing',
      claimed_by = p_worker_id,
      claimed_at = now(),
      attempts = attempts + 1,
      started_at = coalesce(started_at, now())
  where id = v_id
  returning *;
end;
$$;

comment on function claim_webchat_job is
  'Atomic FOR UPDATE SKIP LOCKED claim of the next queued webchat job for one tenant. Returns 0 or 1 row. Skips tenants on reply_engine=''gemini'' (answered by the platform engine via /api/widget/poll).';

revoke all on function claim_webchat_job(text, uuid) from public;
grant execute on function claim_webchat_job(text, uuid) to service_role;

-- Atomic completion for the platform engine: assistant message + session
-- history marker + job flip in ONE transaction. Without this, "message
-- inserted but the job-status flip failed" leaves a 'processing' row that
-- the stale-claim reclaim would answer AGAIN — duplicate assistant reply,
-- double Gemini billing. With it, partial states cannot exist, and a
-- replay against an already-done job idempotently returns the original
-- reply instead of inserting a second one.
create or replace function webchat_job_complete_platform(
  p_job_id uuid,
  p_content text,
  p_history_marker text
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
         error_detail = null
   where id = p_job_id;

  return v_msg_id;
end;
$$;

comment on function webchat_job_complete_platform is
  'Platform (Gemini) engine reply commit: assistant message + session history marker + job done, atomically. Replay on a done job returns the existing assistant_message_id (no duplicate reply, no double bill).';

revoke all on function webchat_job_complete_platform(uuid, text, text) from public;
grant execute on function webchat_job_complete_platform(uuid, text, text) to service_role;

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

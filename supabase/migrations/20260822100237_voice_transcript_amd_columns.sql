-- Surface answering-machine detection on the call view.
--
-- AMD now tells an outbound AiFlow call whether a person or a voicemail picked
-- up, and that verdict decides whether a follow-up ladder keeps trying. Until
-- now it lived only in flow variables and telemetry, which means the owner
-- looking at the call itself could not see it: a call the assistant left a
-- message on and a call somebody answered read identically in the dashboard.
--
-- Three columns, all additive, all nullable or defaulted, so every existing row
-- and every call placed without AMD stays exactly as it is.
--
--   answering_machine_result  the verdict, when one was requested at all.
--                             NULL for inbound calls and for outbound calls
--                             placed before AMD, which is most of them.
--   voicemail_left            whether the assistant actually spoke a message,
--                             as opposed to reaching a machine and hanging up.
--                             Those are different outcomes for the person on
--                             the other end and must not read the same.
--   voicemail_verbatim_score  how closely the spoken message matched the
--                             approved script (see _shared/voice_verbatim.ts).
--                             NULL until a voicemail is actually left.
--                             double precision, NOT numeric: PostgREST
--                             serializes numeric as a STRING to preserve
--                             arbitrary precision, so a reader doing a
--                             typeof === "number" check would silently never
--                             see a score. A 0-1 ratio has no need of that
--                             precision.
--
-- grants: none (voice_call_transcripts): existing table with its own policies;
-- adding columns does not change its Data API exposure.

alter table public.voice_call_transcripts
  add column if not exists answering_machine_result text,
  add column if not exists voicemail_left boolean not null default false,
  add column if not exists voicemail_verbatim_score double precision;

comment on column public.voice_call_transcripts.answering_machine_result is
  'Answering-machine detection verdict for this leg (human / machine / unknown), or NULL when AMD was not requested. Premium AMD reports human_residence / human_business rather than a bare "human", so the raw value is normalized before it is stored; see _shared/voice_amd.ts.';
comment on column public.voice_call_transcripts.voicemail_left is
  'True when the assistant spoke its scripted message into a voicemail. Distinct from merely reaching a machine, which hangs up without saying anything.';
comment on column public.voice_call_transcripts.voicemail_verbatim_score is
  'How closely the spoken voicemail matched the approved script, 0 to 1 (scoreVerbatim in _shared/voice_verbatim.ts). NULL when no message was left.';

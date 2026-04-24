-- Voice call transcripts: owner-readable record of what was said on each call.
--
-- Writes happen from the VPS voice bridge using the service role key, after
-- Gemini Live emits `serverContent.turnComplete`. Reads go through Next.js
-- routes that call `requireOwner()` first, mirroring the dashboard chat
-- pattern (`dashboard_chat_threads` / `dashboard_chat_messages`).
--
-- Correlation: `call_control_id` is the Telnyx leg id and matches
-- `voice_reservations.call_control_id` (unique there too). `reservation_id`
-- is a soft FK — populated best-effort by the bridge; nullable so a transcript
-- never blocks on reservation lookup.
--
-- No RLS: reads are always owner-gated in application code.

create table if not exists voice_call_transcripts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  call_control_id text not null unique,
  reservation_id uuid references voice_reservations(id),
  caller_e164 text,
  model text not null,
  status text not null check (status in ('in_progress', 'completed', 'errored')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists voice_call_transcripts_business_idx
  on voice_call_transcripts (business_id, created_at desc);

create table if not exists voice_call_transcript_turns (
  id bigserial primary key,
  transcript_id uuid not null references voice_call_transcripts(id) on delete cascade,
  role text not null check (role in ('caller', 'assistant')),
  content text not null,
  -- Monotonically increasing per transcript. The bridge derives this from
  -- its own counter so ordering is stable even if two inserts race.
  turn_index integer not null,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  unique (transcript_id, turn_index)
);

create index if not exists voice_call_transcript_turns_thread_idx
  on voice_call_transcript_turns (transcript_id, created_at);

-- White-glove client intake questionnaires.
--
-- Before a white-glove build is scheduled, the PROSPECT fills out a short
-- questionnaire themselves: the admin enters their email, the system emails
-- them an unguessable public link (/intake/<token>), and their answers are
-- stored here. The answers render into the "White-Glove Build & Installation"
-- document (src/lib/white-glove/template.ts) that drives the build.
--
-- Lifecycle: sent → completed (prospect submits) or sent → revoked (admin).
-- Completed intakes are immutable — the submit path only matches status='sent'.
--
-- Same posture as white_glove_offers: prospect-first (business_id nullable,
-- keyed to recipient_email before any account exists), token as a public
-- capability, service-role-only access.
create table if not exists public.white_glove_intakes (
  id uuid primary key default gen_random_uuid(),
  -- Unguessable capability behind the public /intake/<token> questionnaire link.
  token uuid not null default gen_random_uuid(),
  -- Who the questionnaire was sent to (prospects have no account yet).
  recipient_email text not null check (char_length(recipient_email) between 3 and 320),
  -- Attachable later when the prospect signs up (mirrors prospect offers).
  business_id uuid references public.businesses(id) on delete cascade,
  -- The prospect's submitted questionnaire answers; null until completed.
  answers jsonb,
  status text not null default 'sent' check (status in ('sent', 'completed', 'revoked')),
  -- Admin email that sent the questionnaire (audit trail).
  created_by text not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  -- A completed intake always carries answers; a pending one never does.
  constraint white_glove_intakes_answers_check
    check ((status = 'completed') = (answers is not null))
);

alter table public.white_glove_intakes enable row level security;

drop policy if exists "Service role manages white_glove_intakes" on public.white_glove_intakes;
create policy "Service role manages white_glove_intakes"
  on public.white_glove_intakes for all
  using (auth.role() = 'service_role');

create unique index if not exists white_glove_intakes_token_idx
  on public.white_glove_intakes (token);

create index if not exists white_glove_intakes_created_idx
  on public.white_glove_intakes (created_at desc);

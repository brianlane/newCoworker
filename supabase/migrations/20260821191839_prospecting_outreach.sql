-- ---------------------------------------------------------------------------
-- Prospecting: outbound discovery + cold outreach, per business.
--
--   outreach_settings  - one row per business: the mode (off / manual / auto),
--                       the targeting (search terms crossed with cities), the
--                       daily send cap, the weekday send window, and which
--                       connected mailbox the pitch is sent from. Mode
--                       defaults to 'off' so enabling the feature is always
--                       an explicit owner action.
--   outreach_prospects - the ledger. One row per discovered business, keyed by
--                       domain, carrying the probe findings and the composed
--                       pitch through
--                       discovered -> drafted -> queued -> sent ->
--                       replied / booked / unsubscribed / skipped / failed.
--
-- WHY A LEDGER AND NOT A QUEUE. Nobody may be cold-emailed twice, so the row
-- is permanent and suppression is wider than sending: any row for a domain
-- (whatever its status) takes that domain out of future discovery. The
-- address axis is separate on purpose, because one address fronts several
-- businesses (a shared owner, or the agency running both sites), hence the
-- partial unique index on (business_id, lower(email)).
--
-- Security posture: RLS on with NO policies on both tables — service-role
-- only, identical to email_campaigns. Owners reach them through the Next.js
-- server after its own auth checks.
--
-- Call chain:
--   pg_cron (every 5 min) -> Edge `outreach-sweep`
--                         -> Next.js POST /api/internal/outreach-sweep
--                         -> src/lib/outreach/sweep.ts
--                            (discover -> probe -> compose -> ledger, then in
--                             'auto' hand each queued prospect to the tenant's
--                             Prospect outreach AiFlow as a webhook event)
-- ---------------------------------------------------------------------------

create table if not exists public.outreach_settings (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  -- 'off'    = the sweep never picks this business up (the kill switch).
  -- 'manual' = discover and draft, then wait for the owner to press Send.
  -- 'auto'   = discover, draft, and send within the cap and window.
  mode text not null default 'off' check (mode in ('off', 'manual', 'auto')),
  -- Places queries: each term is crossed with each city. Empty = nothing to
  -- discover, which the sweep reports rather than guessing an audience.
  search_terms text[] not null default '{}',
  cities text[] not null default '{}',
  -- Sends per UTC day. Deliberately small: 10 to 25/day is the guidance that
  -- protects a sending domain's reputation.
  daily_cap integer not null default 12 check (daily_cap between 0 and 200),
  -- Weekday send window in the business's local hours (inclusive start,
  -- exclusive end). Cold mail lands best on a weekday morning.
  send_window_start_hour integer not null default 8
    check (send_window_start_hour between 0 and 23),
  send_window_end_hour integer not null default 11
    check (send_window_end_hour between 1 and 24),
  -- Nango connection id of the mailbox the pitch is sent FROM. Null means the
  -- flow's own binding decides; the owner surface warns when neither is set.
  from_connection_id text,
  -- CAN-SPAM requires a valid physical postal address in every commercial
  -- email, so this is a PRECONDITION of the feature, not a setting: the check
  -- below makes it impossible to leave 'off' without one. Structural beats
  -- aspirational — a compliance footer that an owner could forget is not a
  -- compliance footer.
  postal_address text,
  -- What the tenant wants said about themselves in one or two sentences.
  -- Optional: the composer otherwise grounds the pitch in the business
  -- profile the coworker already uses.
  value_prop text,
  -- Who the pitch is signed by. Optional; the business name signs it otherwise.
  sender_name text,
  -- One discovery pass per business per day — the sweep runs every 5 minutes.
  last_discovery_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint outreach_settings_window_ordered
    check (send_window_end_hour > send_window_start_hour),
  constraint outreach_settings_postal_address_required_when_on
    check (
      mode = 'off'
      or (postal_address is not null and length(btrim(postal_address)) > 0)
    )
);

alter table public.outreach_settings enable row level security;
-- No policies: service_role bypasses RLS; anon/authenticated denied by design.
grant select, insert, update, delete on table public.outreach_settings to service_role;

-- The sweep's per-pass scan: every business the feature is on for.
create index if not exists idx_outreach_settings_active
  on public.outreach_settings (mode)
  where mode <> 'off';

create table if not exists public.outreach_prospects (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- Registrable domain, lowercased, no scheme or www — the suppression key.
  domain text not null,
  business_name text not null default '',
  -- Scraped from the site. Null until (or unless) one is found; a prospect
  -- with no address can never be drafted, only reported.
  email text,
  phone text,
  website text,
  vertical text not null default '',
  city text not null default '',
  -- Probe output: the hooks the pitch is built from (see src/lib/outreach/probe.ts).
  findings jsonb not null default '[]'::jsonb,
  pitch_subject text,
  pitch_body text,
  -- 'skipped' = the owner read the draft and passed (manual mode).
  -- 'failed'  = the send path refused it; kept so it is never retried blindly.
  status text not null default 'discovered'
    check (
      status in (
        'discovered',
        'drafted',
        'queued',
        'sent',
        'replied',
        'booked',
        'unsubscribed',
        'skipped',
        'failed'
      )
    ),
  status_detail text,
  -- Contact row the outreach flow filed for this prospect, when it got that far.
  contact_id uuid,
  drafted_at timestamptz,
  queued_at timestamptz,
  sent_at timestamptz,
  -- One follow-up per prospect, ever. Stamped when it goes out, which is also
  -- what makes "has this prospect been nudged?" answerable without inspecting
  -- a mailbox.
  nudged_at timestamptz,
  replied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The domain axis of suppression: one row per domain per business, forever.
  unique (business_id, domain)
);

-- The address axis: two businesses sharing one contact address get ONE
-- pitch. Partial, because most prospects are discovered before an address is.
create unique index if not exists idx_outreach_prospects_email
  on public.outreach_prospects (business_id, lower(email))
  where email is not null;

-- The sweep's work scan (drafted -> queued) and the owner's review queue.
create index if not exists idx_outreach_prospects_status
  on public.outreach_prospects (business_id, status, created_at);

-- The daily-cap count: sends for this business today. Doubles as the
-- follow-up scan (sent a while ago, never nudged, no reply on record).
create index if not exists idx_outreach_prospects_sent_at
  on public.outreach_prospects (business_id, sent_at);

alter table public.outreach_prospects enable row level security;
-- No policies: service_role only, same posture as outreach_settings.
grant select, insert, update, delete on table public.outreach_prospects to service_role;

comment on table public.outreach_settings is
  'Per-business Prospecting configuration: mode (off/manual/auto), Places targeting (search terms x cities), daily send cap, weekday send window, sending mailbox connection, and the CAN-SPAM postal address. Mode defaults to off, and a check constraint makes leaving off impossible without a postal address, so no cold mail can go out without one.';
comment on column public.outreach_settings.postal_address is
  'Physical postal address printed in every pitch footer (CAN-SPAM requirement). Enforced by outreach_settings_postal_address_required_when_on: the feature cannot be switched on without it.';
comment on table public.outreach_prospects is
  'Cold-outreach ledger: one permanent row per discovered domain per business, carrying probe findings and the composed pitch through discovered/drafted/queued/sent/replied/booked/unsubscribed/skipped/failed. Any existing row suppresses the domain from future discovery; the partial unique index on lower(email) suppresses the address axis too, so nobody is pitched twice.';
comment on column public.outreach_prospects.findings is
  'Probe hooks the pitch is grounded in (JSON array of {code, detail}). Evidence, not adjectives: the draft may only claim what a finding recorded.';

-- ---------------------------------------------------------------------------
-- Schedule the sweep (mirrors 20260811173000_email_campaigns): every 5
-- minutes. Cadence is NOT the pace — the per-business daily cap and send
-- window are, and one discovery pass per business per day is enforced by
-- outreach_settings.last_discovery_at. A frequent tick just means a business
-- entering its window starts sending promptly.
-- ---------------------------------------------------------------------------

do $unschedule$
begin
  perform cron.unschedule('edge-outreach-sweep')
  where exists (
    select 1 from cron.job where jobname = 'edge-outreach-sweep'
  );
end
$unschedule$;

select cron.schedule(
  'edge-outreach-sweep',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := public._cron_vault_read('edge_base_url') || '/functions/v1/outreach-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_vault_read('internal_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 280000
  );
  $$
);

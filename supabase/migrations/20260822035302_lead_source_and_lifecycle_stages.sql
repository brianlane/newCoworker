-- ---------------------------------------------------------------------------
-- Two columns behind platform-written lead state.
--
-- 1) contacts.lead_source
--
--    The Tasks Data view's SOURCE column reads `lead_submissions.source`, and
--    that table is only ever written by inbound WEBHOOK lead events (Meta Lead
--    Ads, the Zapier/Make/Privyr bridges, contact-form and Vagaro sinks). A
--    tenant whose leads arrive as SMS group texts, voice live transfers or
--    referral-network texts therefore has an empty lead_submissions and a dash
--    in every SOURCE cell, even though the lead's origin is perfectly well
--    known: it is the AiFlow that filed them ("Clever Lead - Accept",
--    "HomeLight Referral", "ReferralExchange Lead").
--
--    So the flow-filed path stamps its own label here, fill-only, at the
--    moment the contact is first filed. The read path prefers a matched
--    submission's source and falls back to this column, which keeps webhook
--    leads reporting their exact upstream label ("facebook_lead_ads")
--    unchanged.
--
--    Deliberately NOT a lead_submissions row: that table is one row per
--    delivered webhook EVENT (unique on business_id, event_key) and is joined
--    by the Meta CAPI feedback outbox on leadgen_id. A flow-filed lead has no
--    delivery event, so a synthetic key would file the same person again on
--    every re-run and would distort the CAPI loop for leads Meta never sent.
--
--    120 chars matches the clamp recordLeadSubmission already applies to
--    lead_submissions.source, so the two source strings stay comparable.
--
-- 2) businesses.auto_lifecycle_stages
--
--    Kill switch for the platform lifecycle tagger: lead filed -> "New Lead",
--    teammate claimed -> "Contacted", customer replied -> "Engaged", booking
--    landed -> "Booked". Those writes are ordinary contact tags firing the
--    ordinary goal/tag_changed hooks, so a business needs a way to stop them
--    outright. Default TRUE: the tagger is separately gated on the stage
--    already existing as a pipeline stage for the business, so a tenant with
--    no pipeline is unaffected whatever this column says.
--
--    The applier reads this fail-safe OFF (a read error writes no tag), the
--    opposite of needs_human's team-first toggle, because a tag write is an
--    irreversible side effect that can start a tenant's flow.
--
-- grants: none (both objects are COLUMNS on existing tables, plus one index).
-- Data API grants attach to the table, not the column, and `contacts` and
-- `businesses` are already granted to service_role. No new table, view,
-- sequence or function is created here.
-- ---------------------------------------------------------------------------

alter table public.contacts
  add column if not exists lead_source text;

alter table public.contacts
  drop constraint if exists contacts_lead_source_len_chk;
alter table public.contacts
  add constraint contacts_lead_source_len_chk
  check (lead_source is null or char_length(lead_source) <= 120);

comment on column public.contacts.lead_source is
  'Specific origin of the lead ("Clever", "HomeLight"), derived from the name of the AiFlow that first filed the contact and written fill-only, so the first flow to file owns the label. Read by the Tasks Data view SOURCE column as the fallback behind a matched lead_submissions row. Null for contacts that never arrived as a lead.';

-- "Every lead from Clever" / source breakdowns on the Tasks page. Partial:
-- most contacts on an established tenant predate the column and stay null.
create index if not exists idx_contacts_business_lead_source
  on public.contacts (business_id, lead_source)
  where lead_source is not null;

alter table public.businesses
  add column if not exists auto_lifecycle_stages boolean not null default true;

comment on column public.businesses.auto_lifecycle_stages is
  'When true (default), the platform advances a contact through the business pipeline stages at lifecycle events: lead filed -> New Lead, teammate claimed -> Contacted, customer replied -> Engaged, booking landed -> Booked. Only ever writes a tag that already exists as one of the business pipeline stage names, and only ever moves a contact FORWARD. Set false to stop platform stage tagging entirely.';

-- Knowledge-graph trust/provenance model — the foundation for widening
-- graph ingestion beyond owner statements (PRs 3-5 of the KG plan).
--
-- Every entity and fact records WHERE it came from and HOW MUCH it can be
-- trusted:
--
--   source        — the content surface that produced it (see the
--                   registry in src/lib/memory/kg-sources.ts).
--   trust         — 3 owner-stated / roster / identity docs,
--                   2 employee threads / calendar systems / business docs,
--                   1 identified customers / replied email,
--                   0 anonymous webchat / webhook leads / unanswered email.
--   attributed_to — who said it (caller E.164, email address, platform
--                   source id); null for owner-canonical data.
--
-- Two load-bearing invariants enforced in src/lib/memory/graph-write.ts:
--   * supersedence respects trust — a new fact deactivates only
--     same-or-LOWER-trust facts for its (subject, predicate); a customer
--     claim can never supersede an owner statement (the KYP lesson).
--   * trust ≤ 1 sources never merge contact points (phones/emails/aliases)
--     onto canonical entities — their claims land as attributed facts.
--
-- Existing rows are owner-capture output: backfilled as owner_chat / 3.
--
-- Version stamp continues the ledger sequence after 20260820100200.

alter table public.memory_entities
  add column if not exists source text not null default 'owner_chat',
  add column if not exists trust smallint not null default 3,
  add column if not exists attributed_to text;

alter table public.memory_entities
  drop constraint if exists memory_entities_trust_check;

alter table public.memory_entities
  add constraint memory_entities_trust_check check (trust between 0 and 3);

alter table public.memory_facts
  add column if not exists source text not null default 'owner_chat',
  add column if not exists trust smallint not null default 3,
  add column if not exists attributed_to text;

alter table public.memory_facts
  drop constraint if exists memory_facts_trust_check;

alter table public.memory_facts
  add constraint memory_facts_trust_check check (trust between 0 and 3);

-- KG comparison ledger: per-lookup retrieval latency + claim count.
--
-- The /admin/memory-graph dashboard shows cost (from the gemini spend
-- ledger) and now TIME: how long the ranked-markdown selection and the
-- graph retrieval each took inside lookupBusinessKnowledge.
--
-- graph_claims counts the attributed "(unverified)" claim lines in the
-- graph context, persisted at write time so the FLEET view can compute
-- claim reliance (the keep-verdict's quality qualifier) from the compact
-- stats query without hauling every row's context text.
--
-- All nullable on purpose: rows written before this migration carry no
-- measurement, and the aggregation (src/lib/memory/kg-events.ts) averages
-- over measured rows only (claim counts re-derive from graph_context when
-- the full row is loaded).
--
-- Version stamp continues the ledger sequence after 20260820100500 (the
-- Data-API grant revokes took 100400-100500).

alter table public.kg_retrieval_events
  add column if not exists memory_retrieval_ms integer,
  add column if not exists graph_retrieval_ms integer,
  add column if not exists graph_claims integer;

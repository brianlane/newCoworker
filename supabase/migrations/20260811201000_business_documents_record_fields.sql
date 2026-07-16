-- Structured record fields on document records.
--
-- record_fields is the record layer's generic typed metadata — carrier /
-- premium / deductible on an insurance quote, rent on a lease — a flat
-- { "field": "value" } jsonb object (string values, bounded key count,
-- enforced app-side by sanitizeRecordFields). Written by the doc_extract
-- AiFlow step's filing sinks (recordFieldsFromExtraction) and surfaced on
-- the contact profile's records list, the document editor, and the Contact
-- records CSV export. NULL = no structured fields captured.

alter table public.business_documents
  add column if not exists record_fields jsonb;

comment on column public.business_documents.record_fields is
  'Structured record metadata as a flat {"field":"value"} object (string values; app-side caps). Written by doc_extract filing sinks; shown on contact records and the CSV export. NULL = none captured.';

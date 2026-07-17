-- Multi-file agent runs: a run can carry several attachments (one quote PDF
-- per carrier, compared side by side in a single model call). input_files
-- records EVERY attachment in order — [{ filename, mime_type, document_id,
-- storage_path }] — while the existing scalar input_* columns keep mirroring
-- the first file, so run history and older readers need no back-compat
-- handling. NULL = a pre-multi-file (single attachment) row described by the
-- scalars.

alter table agent_runs add column if not exists input_files jsonb;

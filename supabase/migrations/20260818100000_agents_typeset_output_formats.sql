-- Agents: typeset + re-typeset output formats.
--
-- 'pdf' and 'docx' join the output_format vocabulary: the model still
-- produces the markdown artifact (agent_runs.output_md stays the source of
-- truth); the binary representation is typeset from that markdown at
-- persistence/download time (src/lib/documents/typeset.ts). 'same_as_input'
-- now also echoes PDF/DOCX inputs back in kind through the same typesetter.
--
-- 'pdf_retypeset' (Standard/Enterprise — server-gated on tier) stores a
-- self-contained styled-HTML artifact instead: the model reconstructs the
-- source document's design with the instructions applied, and the tenant's
-- VPS render sidecar prints it to PDF at save/download time.

alter table public.business_agents
  drop constraint business_agents_output_format_check;

alter table public.business_agents
  add constraint business_agents_output_format_check
  check (output_format in ('markdown', 'same_as_input', 'pdf', 'docx', 'pdf_retypeset'));

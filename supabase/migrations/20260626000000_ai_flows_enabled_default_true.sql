-- AiFlows now go live on creation by default (product change): a newly created
-- automation should start enabled unless the caller explicitly opts out (the
-- "duplicate" path still passes enabled=false so a copy never double-fires on
-- the same trigger). The app's createAiFlow already inserts an explicit
-- `enabled` value, but align the column default with the new intent so any
-- direct insert / API consumer that omits the column also defaults to enabled.
-- Existing rows are untouched (this only changes the default for future inserts).
alter table public.ai_flows alter column enabled set default true;

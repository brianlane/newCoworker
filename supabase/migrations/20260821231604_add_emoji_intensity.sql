-- Per-tenant freeform SMS emoji intensity (0 = none … 5 = multiple on every text).
-- Default 2 (Light) keeps existing tenants roughly neutral. The Memory
-- dashboard control and the SMS worker preamble both read this column;
-- AiFlow canned bodies are unaffected.
--
-- Column on an existing table: no new Data API object, so no grants.

alter table public.business_configs
  add column if not exists emoji_intensity smallint not null default 2;

alter table public.business_configs
  drop constraint if exists business_configs_emoji_intensity_check;

alter table public.business_configs
  add constraint business_configs_emoji_intensity_check
  check (emoji_intensity >= 0 and emoji_intensity <= 5);

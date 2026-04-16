-- Inworld.ai removed; voice is Telnyx + VPS bridge.
alter table public.business_configs
  drop column if exists inworld_agent_id;

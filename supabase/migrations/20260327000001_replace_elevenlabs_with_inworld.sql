-- Replace ElevenLabs with inworld.ai on business_configs
-- and add Rowboat project linkage

alter table business_configs
  rename column elevenlabs_agent_id to inworld_agent_id;

alter table business_configs
  add column if not exists rowboat_project_id text;

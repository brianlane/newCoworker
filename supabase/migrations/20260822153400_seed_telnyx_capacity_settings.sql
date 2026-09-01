-- Telnyx capacity config moves from env to admin_platform_settings.
--
-- The account channel pool changes over time as Telnyx support tickets land
-- (ticket #582143 raised it 10 -> 100 on 2026-08-16; ticket #624702 raised
-- it 100 -> 500 on 2026-08-31), so it belongs in DATA: one row update applies
-- to the pre-dial fleet gate (telnyx-voice-originate), the weekly capacity
-- monitor, and the debug inspector at once, with no secret rotation across
-- environments and no redeploy. Env vars remain the fallback when the row
-- is missing.
--
-- Seeded with the then-current granted values (100). Live raises are a
-- row update, not a new migration (ticket #624702 set the live row to 500):
--   update admin_platform_settings
--   set value = jsonb_set(value, '{account_channel_limit}', '<new>'), updated_at = now()
--   where key = 'telnyx_capacity';
--
-- Insert-only into an existing table; no new objects, no new grants.

insert into admin_platform_settings (key, value)
values (
  'telnyx_capacity',
  '{"account_channel_limit": 100, "platform_outbound_headroom": 3}'::jsonb
)
on conflict (key) do nothing;

-- Warm-transfer + SMS-fallback configuration for per-tenant DIDs.
--
-- `forward_to_e164`    – owner/staff cell (E.164) used when the AI invokes the
--                        `transfer_to_owner` Gemini tool OR when the bridge
--                        fails to attach and we fall back to an SMS
--                        "you missed a call" alert.
-- `transfer_enabled`   – master switch for the warm-transfer tool. Admin UI
--                        can flip it off even with a `forward_to_e164` set so
--                        the AI never offers to transfer while we QA a
--                        specific tenant.
-- `sms_fallback_enabled` – when the voice bridge cannot attach (e.g. Gemini
--                        Live API returned an error, stream WSS rejected),
--                        send the owner an SMS at `forward_to_e164` with the
--                        caller's number instead of silently dropping the
--                        call. Defaults on.
--
-- We intentionally do NOT add `record_inbound_calls` or `cnam_lookup_enabled`
-- columns here — those Telnyx features (a) introduce consent / wiretap
-- liability per state, (b) cost per-lookup on every inbound call for CNAM.
-- Product decision: skip both for now; revisit when regulated verticals
-- (healthcare, finance) opt in via an explicit compliance workflow.

alter table business_telnyx_settings
  add column if not exists forward_to_e164 text,
  add column if not exists transfer_enabled boolean not null default true,
  add column if not exists sms_fallback_enabled boolean not null default true;

-- Keep `forward_to_e164` in E.164 (`+` followed by 8–15 digits) so both the
-- Telnyx Call Control `/actions/transfer` payload and the SMS fallback can
-- pass it through unchanged. Nullable (opt-in).
alter table business_telnyx_settings
  drop constraint if exists business_telnyx_settings_forward_to_e164_chk;
alter table business_telnyx_settings
  add constraint business_telnyx_settings_forward_to_e164_chk
  check (forward_to_e164 is null or forward_to_e164 ~ '^\+[1-9][0-9]{7,14}$');

comment on column business_telnyx_settings.forward_to_e164 is
  'Owner/staff phone (E.164). Used by the AI transfer tool and the SMS bridge-failure fallback.';
comment on column business_telnyx_settings.transfer_enabled is
  'Master toggle for the warm-transfer AI tool. Default true.';
comment on column business_telnyx_settings.sms_fallback_enabled is
  'When true, send the owner an SMS if the voice bridge cannot attach to a live call.';

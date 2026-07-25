-- Live translator mode becomes the DEFAULT, not an opt-in.
--
-- It shipped off by default for one reason: arming sets Telnyx's
-- `stream_bidirectional_target_legs=both` at ANSWER time, before anyone knows
-- whether the call will need an interpreter, so the parameter rides EVERY call
-- on an armed tenant. The open question was whether "send the AI's audio to
-- every leg" would loop that audio back into our own `both_tracks` fork on an
-- ordinary one-party call and have the model hear itself.
--
-- Verified on the HQ tenant 2026-07-25 (call v3:IWTL0Trm..., 70s, armed): 11
-- cleanly alternating turns, every caller turn genuinely the caller's words,
-- zero assistant text transcribed as inbound, clean end_call and settlement,
-- no errors across 17 telemetry events. No echo. The parameter is inert until a
-- second leg exists, exactly as documented.
--
-- With the blast radius cleared, an opt-in is the wrong shape: the AI already
-- decides to interpret only when someone actually needs it (a caller who does
-- not share a language asks for a human, or staff explicitly ask for a
-- translator). Requiring an operator to pre-arm a capability that is already
-- self-gating just means the tenant who needs it most does not have it.
--
-- The column stays as a per-tenant kill switch rather than being dropped: the
-- interpret path's audibility on a bridged pair is Telnyx behavior we have
-- confirmed only by design intent, so keeping a one-row revert is cheap
-- insurance.

alter table business_telnyx_settings
  alter column translator_mode_enabled set default true;

-- Existing tenants: arm them. Deliberately unconditional, including tenants with
-- no transfer target configured. Arming is inert for them (the interpret path
-- requires a transfer to bridge a human in, which they cannot do), and leaving
-- them false would mean a tenant who later configures warm transfer silently
-- lacks the feature every other tenant has.
update business_telnyx_settings
  set translator_mode_enabled = true,
      updated_at = now()
  where translator_mode_enabled is distinct from true;

comment on column business_telnyx_settings.translator_mode_enabled is
  'When true (default), the AI stays on a warm-transferred call as a live interpreter (Telnyx target_legs=both) instead of detaching. Per-tenant kill switch. Interpreting is self-gating: it only engages when a caller needs it or staff ask. Meters both call legs plus AI for the full conversation.';

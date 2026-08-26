---
name: itest-no-global-telnyx-profile
description: Worker itest stack sets NO global Telnyx messaging profile; a send/notify itest must seed business_telnyx_settings or the step silently no-ops and the test passes for the wrong reason
metadata: 
  node_type: memory
  type: project
  originSessionId: 46ad72a5-e807-4776-bb30-fce3b421c36b
  modified: 2026-08-07T15:08:55.424Z
---

The worker-integration stack (ci.yml) deliberately sets no global
`TELNYX_MESSAGING_PROFILE_ID`: "Businesses that seed no
business_telnyx_settings profile still dead-letter at
missing_telnyx_messaging_env." So inside the served ai-flow-worker,
`messagingConfig()` returns null for any seeded business unless the test
seeds `business_telnyx_settings.telnyx_messaging_profile_id` +
`telnyx_sms_from_e164` (the `bad-phone-backstop.itest.ts` pattern).

**Why:** this is how my notify-owner fallback itest (PR #1222) passed 3/3
while never reaching the logic it claimed to pin: with cfg null the step
bailed at `if (!cfg)` above the branch under test, and the `no_phone`
case "passed for the wrong reason". The Investigation session (Aug 7
2026) caught it only because a separate coverage failure forced the itest
to actually run, then shipped PR #1223 to fix the check ORDERING the
hidden test had masked (unreachable-number check now sits above `!cfg`).

**How to apply:** any itest whose scenario includes an SMS attempt (or a
deliberate pre-send decision like the fallback) must seed the per-business
profile AND assert the seed's upsert error; a test that cannot show its
subject code executed (step result payloads, notification rows, captured
sends) proves nothing. Same family as
[[feedback_assert_the_producer_not_the_fixture]].
Related: [[weighted-sms-metering]].

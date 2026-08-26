---
name: gemini-billing-and-model-pins
description: Gemini model env-pin layers and the billed-vs-metered spend gap
metadata:
  type: project
---

## project-gemini-model-env-pin-layers

Changing a model default in `vps/scripts/deploy-client.sh` is NOT enough to
move the fleet. `GEMINI_ROWBOAT_MODEL` (and friends) are forwarded from THREE
places, each silently overriding the script default on redeploy:

1. `deploy-client.sh` default (`GEMINI_ROWBOAT_MODEL_DEFAULT`), used only when
   nothing injects the var.
2. The runner's `/Users/brianlane/newCoworker/.env`: `scripts/redeploy-deploy-client.ts:153`
   forwards `process.env.GEMINI_ROWBOAT_MODEL` into every box deploy. During
   the Aug 14 2026 3.7-flash bump (PR #1361) a stale `gemini-3.6-flash` pin
   here made the first canary look deployed while shipping the old model.
   Unpinned since (commented out with a dated note).
3. Vercel production env: `src/lib/provisioning/orchestrate.ts:2252` forwards
   it into every NEW provision, and app-side readers (knowledge-tools,
   website-ingest) use it directly. The var exists there, marked Sensitive,
   value unreadable via `vercel env pull` (redacted), set ~Jul 16 2026,
   likely pre-#809 stale. Only Brian can read/delete it.

**Verify a model rollout on-box, not by script exit**: `grep
'^GEMINI_ROWBOAT_MODEL=' /opt/rowboat/.env` via `debug/vps-exec.ts`, plus the
router's `/v1/models`. Note `voice_task` is NOT a seeded Mongo agent (the
WORKFLOW_JSON seeder in deploy-client.sh seeds only chat agents); the env var
drives the llm-router's voice-path metering exclusion and the rowboat.json
template, so Mongo showing no voice_task is normal.

**Live-verified 2026-08-14**: `gemini-3.7-flash` rejects
`thinkingConfig.thinkingLevel: "minimal"` with HTTP 400 INVALID_ARGUMENT
("Thinking level MINIMAL is not supported"). GUARDED since PR #1372 (merged
2026-08-14): geminiGenerateTextDetailed, geminiChatStep, and the
ai-flow-worker fetch all retry a thinking-level-shaped 400 once (minimal
steps to low, other levels drop thinkingConfig), so env-pointing a surface
at 3.7-flash is safe now. The Vercel `GEMINI_ROWBOAT_MODEL` cleanup still
needs Brian (hidden value, only he can read/delete it). See
[[project-fleet-redeploy-check]].

## project-gemini-billed-vs-metered-gap

**The name:** Google's Cloud Billing export labels Gemini spend
`service.description = "Gemini API"`, NOT "Generative Language API" (the
endpoint's own name). Our sync filtered on the wrong one from setup until
2026-08-18, matched zero rows every run, and reported ok because an empty
result is not an error. Fixed in PR #1468: default corrected, and a
configured sync matching zero rows over the full 95-day window now reports
not-ok. Confirm the label with
`SELECT DISTINCT service.description FROM <export table>`.

**Expect billed >> metered, and do not panic.** Google billed ~$19.39 over
Aug 4-18 2026 while `gemini_spend_events` recorded ~$4.98, about 4x. The
export is PROJECT-wide (`gen-lang-client-0301762390`), so it includes CI e2e
runs, local `debug/` probes, and the engineering key; the ledger only records
per-business metered calls. A spike on the export often means someone ran the
live e2e suites, not tenant load: Aug 14 2026 hit $3.46 that way.

Export table: `newcoworker-internal.billing_export.gcp_billing_export_v1_01888D_6BF5E6_7C345A`,
read by `billing-export-reader@newcoworker-internal.iam.gserviceaccount.com`.
Cost per SKU is queryable by model name, which is the only reliable way to
see true per-model spend (the ledger deliberately prices 3.7-flash at the
post-intro rate, so it overstates by 2x until Dec 31 2026). See
[[project-gemini-model-env-pin-layers]].

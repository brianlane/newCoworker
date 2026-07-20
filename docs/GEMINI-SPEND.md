# Gemini spend: metering, admin views, and reconciliation

How Gemini API spend is metered, where the admin sees it, and the one-time
ops setup that makes the admin numbers reconcile with Google AI Studio's
billing page. Written after the Jul 2026 audit where the admin showed $2.08
"fleet, metered" while AI Studio showed $18.24 for the same week — the gap
was (a) CI/debug traffic on the production API key that no meter ever saw,
(b) no day-keyed record to compare against AI Studio's daily bars, and
(c) no billed-actuals feed at all.

## How metering works (shipped, no setup needed)

Every **tenant-attributable** Gemini call ends in one of two SQL functions —
`owner_chat_record_spend` (chat/SMS/webchat/Messenger/WhatsApp/AiFlows/
summarizers/ingest, via `meterGeminiSpendForBusiness` or the ai-flow-worker)
or `owner_chat_ai_settle` (Gemini Live voice, settled at call teardown).
Both do two things in one transaction:

1. add the cost to `owner_chat_model_spend` — the per-period **cap fuse**
   the workers route against (unchanged); and
2. append a row to **`gemini_spend_events`** — the day-keyed ledger:
   business, surface, model, prompt/output tokens (audio split for Live),
   cost in micro-USD, and a `pricing_source` tag (`exact` billed tokens /
   `estimate` chars÷4 / `override` per-image list price).

The admin reads the ledger through the `gemini_spend_daily` roll-up view:

- **/admin/gemini** — today / 7 days / this month / 90 days (UTC calendar
  days, matching AI Studio's bars), daily stacked chart per tenant,
  per-tenant × surface × model table with the estimate-priced share, and
  the metered-vs-billed reconciliation card.
- **/admin/usage** — the AI-spend column is the ledger summed over the
  selected calendar month (works for past months); the dimmer "period"
  figure is the Stripe-period fuse total vs cap.

Events are pruned past ~200 days (rides the daily platform-cost sync).
The ledger collects from the day it shipped — older spend exists only in
the period fuse totals and cannot be backfilled.

## One-time setup A: separate API key for CI + debug traffic

The CI live e2e suite and the `debug/` bench scripts call Gemini with real
keys but are **not tenant traffic** — on the production key they made AI
Studio's number unexplainable. Split them onto their own GCP project so
Google itself attributes the spend:

1. In Google AI Studio / Cloud console, create a **new project** (suggested
   name: `newcoworker-internal`) on the SAME billing account, and mint an
   API key in it.
2. GitHub → repo → Settings → Secrets and variables → Actions → update
   **`GOOGLE_API_KEY`** to the internal key. (The e2e job reads exactly this
   secret; no workflow change needed.)
3. On the operator laptop, put the internal key in the repo-root `.env`'s
   `GOOGLE_API_KEY` so `debug/` scripts and local e2e runs bill internally.
4. **Do not touch** the production key in the Vercel env and in
   provisioning/redeploy secrets (`deploy-client.sh` env) — tenant boxes and
   the platform keep billing the production project.

After this, AI Studio's per-project view separates "product spend"
(production project — should track the metered ledger) from "engineering
spend" (internal project — CI/debug, intentionally unmetered), and the
reconciliation card below tells you if the production side ever drifts.

## One-time setup B: billed actuals (Cloud Billing → BigQuery)

Google has **no API that returns Gemini API spend**; the supported path is
the Cloud Billing export to BigQuery. The daily platform-cost sync then
pulls billed cost per UTC day + project into `gemini_billed_daily`
(rolling 35-day window) and the /admin/gemini reconciliation card compares
it to the metered ledger.

1. Cloud console → **Billing → Billing export → BigQuery export** → enable
   **Standard usage cost** into a dataset (create one, e.g.
   `billing_export`, multi-region US/EU recommended). Table appears as
   `PROJECT.billing_export.gcp_billing_export_v1_XXXXXX_XXXXXX_XXXXXX`.
   Note: the export only backfills the current + previous month at best.
2. Create a **service account** in that project with roles
   **BigQuery Data Viewer** + **BigQuery Job User**; create a JSON key.
3. Set two Vercel env vars (production):
   - `GCP_BILLING_SA_KEY_JSON` — the full JSON key, verbatim
   - `GCP_BILLING_EXPORT_TABLE` — the fully-qualified table id
     (`project.dataset.table`)
   - optional `GEMINI_BILLING_SERVICE_DESCRIPTION` — defaults to
     `Generative Language API`; override only if Google renames the SKU
     service.
4. Trigger a first sync: Admin → Costs → **Sync now** (the Gemini billed
   sync rides it), or wait for the daily 11:10 UTC cron.

Until step 3 is done the sync records "not configured" and skips — the
metered ledger works regardless; only the billed comparison is missing.

## Reading the reconciliation card

- **Billed − Metered ≈ internal project's row** — expected: CI/debug spend
  is deliberately unmetered; it shows up as its own GCP project line.
- **Production project billed ≫ metered** — a real problem: an unmetered
  surface or price-table drift. Check `GEMINI_PRICES_PER_1M` in
  `src/lib/billing/ai-spend-meter.ts` and its edge mirror
  `supabase/functions/_shared/chat_spend_cap.ts` (they must stay in
  lockstep), then look for new Gemini call sites that bypass
  `meterGeminiSpendForBusiness`.
- Billed data lags Google by up to 24h; the card clips the metered side to
  the days billed data covers, so "today" never reads as a false leak.

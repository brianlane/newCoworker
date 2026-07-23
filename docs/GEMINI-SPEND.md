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

## CI e2e spend controls (Jul 2026)

The live e2e suite was ~99% of the `internal-ci-debug` key's request volume
(8.29K requests on Jul 21 vs 0.06K tenant), because every PR push AND every
push to main ran the full ~111-test suite. Three controls now bound it:

**Admin kill switch first**: Admin → Gemini → "CI live e2e" toggles between
`per-change` (the controls below) and `nightly-only` (PRs/pushes skip ALL
paid calls — the e2e check still gates merges — and the nightly cron is the
only live coverage, emailing team@newcoworker.com on failure after one
built-in re-run filters model wobble). Stored in `admin_platform_settings`
(`ci_e2e_mode`), served to GitHub Actions by `GET /api/public/ci-e2e-mode`,
fail-open to per-change on any read error.

- **Scoped runs** — `.github/scripts/e2e-scope.sh` maps the diff to the
  e2e files it can affect (import-audited groups: flows, SMS prompts,
  operator, messenger, voice); unmapped paths fail open to the full suite.
- **Main-push dedupe** — a merge commit with a tree identical to the merged
  PR head whose e2e check passed skips the paid calls (dependabot excluded:
  its PR-side e2e is a secretless no-op, so main is its real coverage).
- **Nightly full run** — `.github/workflows/e2e-nightly.yml` executes the
  complete suite daily on main, bounding live-model-drift exposure to a day.

Each run appends billed tokens to `test-results/e2e-gemini-usage.jsonl`
(`tests/e2e/usage-log.ts`) and reports a per-model table in the job summary
(`.github/scripts/e2e-usage-summary.sh`) — reconcile against AI Studio →
Spend for the `internal-ci-debug` key.

## One-time setup A: separate API key for CI + debug traffic (DONE Jul 2026)

The CI live e2e suite and the `debug/` bench scripts call Gemini with real
keys but are **not tenant traffic** — on the production key they made AI
Studio's number unexplainable.

**What actually shipped (Jul 20 2026), and why it differs from the original
per-project plan:** Google now blocks the Gemini 2.5 model family for
projects that are new to the Gemini API ("no longer available to new
users"), and the e2e suite + fleet SMS default is `gemini-2.5-flash-lite` —
so a fresh `newcoworker-internal` project cannot run the suite. The split is
therefore **per-KEY on the grandfathered production project**
(`gen-lang-client-0301762390`):

- **`Gemini API Key`** (the original) — tenant/production traffic only:
  Vercel env + tenant boxes via provisioning/redeploy.
- **`internal-ci-debug`** — engineering traffic: the GitHub Actions
  `GOOGLE_API_KEY` secret (CI e2e) and the laptop `.env`'s
  `GOOGLE_API_KEY` (debug/ scripts, local e2e). The laptop `.env` keeps the
  production key as **`GOOGLE_API_KEY_TENANTS`**, which
  `scripts/redeploy-deploy-client.ts` prefers when writing tenant boxes —
  a fleet redeploy can never stamp the engineering key onto a customer box.

Attribution: AI Studio → **Spend** shows cost per API key, so product vs
engineering spend is separable there. (The Cloud Billing BigQuery export
splits by project, not key — the reconciliation card's project rows will
show both keys' spend combined under the production project. The
engineering share is visible in AI Studio's per-key spend view.) A
`newcoworker-internal` project exists (billing-linked, Gemini API enabled)
and hosts the billing-export dataset + service account; if Google ever
lifts the new-user model restriction, moving the internal key there makes
the project split real — the reconciliation card then isolates engineering
spend automatically.

## One-time setup B: billed actuals (Cloud Billing → BigQuery) (DONE Jul 2026)

Google has **no API that returns Gemini API spend**; the supported path is
the Cloud Billing export to BigQuery. The daily platform-cost sync then
pulls billed cost per UTC day + project into `gemini_billed_daily`
(rolling 95-day window, covering the widest admin range) and the
/admin/gemini reconciliation card compares it to the metered ledger.

The live wiring (all done Jul 20 2026; recorded here for rebuilds):

1. **Standard usage cost export** is ENABLED on billing account
   `01888D-6BF5E6-7C345A` → project `newcoworker-internal`, dataset
   `billing_export` (US multi-region). Table:
   `newcoworker-internal.billing_export.gcp_billing_export_v1_01888D_6BF5E6_7C345A`
   (appears with the first daily export run; backfill covers the current +
   previous month at best).
2. Service account
   **`billing-export-reader@newcoworker-internal.iam.gserviceaccount.com`**
   with roles **BigQuery Data Viewer** + **BigQuery Job User** on
   `newcoworker-internal`; JSON key minted.
3. Vercel production env (also mirrored in the laptop `.env`):
   - `GCP_BILLING_SA_KEY_JSON` — the full JSON key, verbatim
   - `GCP_BILLING_EXPORT_TABLE` — the table id above
   - optional `GEMINI_BILLING_SERVICE_DESCRIPTION` — defaults to
     `Generative Language API`; override only if Google renames the SKU
     service.
4. First sync: Admin → Costs → **Sync now** (the Gemini billed sync rides
   it), or the daily 11:10 UTC cron. Until the export's first table write
   lands, the sync reports a table-not-found error — self-heals on the next
   daily run.

If the env vars are ever removed the sync records "not configured" and
skips — the metered ledger works regardless; only the billed comparison is
missing.

## Reading the reconciliation card

- **Billed − Metered** — with both keys on the production project (see
  setup A), this delta INCLUDES engineering (CI/debug) spend: check AI
  Studio → Spend per key before treating it as a leak. If the internal key
  ever moves to its own project, that share shows up as its own project row
  instead.
- **Delta far above AI Studio's internal-key spend** — a real problem: an
  unmetered surface or price-table drift. Check `GEMINI_PRICES_PER_1M` in
  `src/lib/billing/ai-spend-meter.ts` and its edge mirror
  `supabase/functions/_shared/chat_spend_cap.ts` (they must stay in
  lockstep), then look for new Gemini call sites that bypass
  `meterGeminiSpendForBusiness`.
- Billed data lags Google by up to 24h; the card clips the metered side to
  the days billed data covers, so "today" never reads as a false leak.

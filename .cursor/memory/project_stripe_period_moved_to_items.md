---
name: project-stripe-period-moved-to-items
description: Stripe moved current_period_start/end off the Subscription onto its items; the voice Edge JIT refresh still reads only the top level and fails fleet-wide
metadata:
  type: project
---

Stripe API `2025-03-31.basil` moved `current_period_start` / `current_period_end`
OFF the top-level Subscription object and ONTO each `SubscriptionItem`. Our
Stripe SDK is pinned to `2026-07-29.dahlia` (`src/lib/stripe/client.ts`) and the
**live account default is `2026-03-25.dahlia`** — so a raw REST GET that sends no
`Stripe-Version` header ALSO gets the new shape. Top-level period fields are
simply absent everywhere now.

**Two readers, only one was fixed.**
- `stripeSubscriptionPeriodCache` in `src/lib/db/subscriptions.ts` reads BOTH
  shapes (top level, else `min(item starts)` / `max(item ends)`). App + webhook
  paths are fine.
- `fetchStripeSubscriptionPeriods` in
  `supabase/functions/_shared/voice_reserve.ts` reads ONLY the top level, so the
  voice §4.2 JIT period refresh returns `null` on EVERY call, for EVERY tenant.

**Why it stayed invisible for a month.** A failed JIT falls back to the cached
period (`cacheLooksValidForQuotaAfterJitFailure`) and emits
`jit_stripe_fail_proceed_cached` telemetry instead of an error. 126 of those
since 2026-07-30 and nobody looked. The fallback refuses only when the cache is
older than `STRIPE_CACHE_ABSURD_AGE_MS` (30 days) — and since the JIT is what
re-stamps `stripe_subscription_cached_at`, a tenant with no billing webhooks in
30 days silently ages out and every AI voice call is refused with
`jit_stripe_fail_block` / `voice_jit_stripe_fail_block`.

**Who ages out first: term plans.** Monthly tenants get a webhook each renewal,
which re-stamps the cache under 30 days. Annual/biennial tenants get nothing for
a year, so they cross the line ~30 days after purchase. Amy Laidlaw Real Estate
(biennial, bought 2026-07-28) started refusing calls 2026-08-27 23:43 UTC, five
minutes after the 30-day mark. New Coworker HQ was at 42.7 days and next in line.

**The trap that let 100% coverage pass:** `tests/voice-reserve.test.ts` stubs the
Stripe fetch as `{ current_period_start, current_period_end }` — the shape the
API no longer returns. See [[feedback_assert_the_producer_not_the_fixture]].

**Fix shape:** put the dual-shape parser in
`supabase/functions/_shared/stripe_voice_period.ts` and import it from
`src/lib/db/subscriptions.ts`. `src/` already imports Deno `_shared` modules
(e.g. `hipaa_model_surface`), so this direction works and stops the two readers
drifting again.

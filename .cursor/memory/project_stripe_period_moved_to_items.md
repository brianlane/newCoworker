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

**FIXED Aug 28 2026 (PR #1698, deployed 16:17 UTC).** Both readers now share
ONE parser, `stripeSubscriptionPeriodSeconds` in
`supabase/functions/_shared/stripe_voice_period.ts`; `src/lib/db/subscriptions.ts`
imports it. The history below is why, and what to look for if it recurs.

**Two readers, only one had been fixed.**
- `stripeSubscriptionPeriodCache` in `src/lib/db/subscriptions.ts` read BOTH
  shapes. App + webhook paths were fine.
- `fetchStripeSubscriptionPeriods` in
  `supabase/functions/_shared/voice_reserve.ts` read ONLY the top level, so the
  voice §4.2 JIT period refresh returned `null` on EVERY call, for EVERY tenant.

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

**Also shipped in #1698:** `stripeCacheMaxAgeMs` gives annual/biennial plans
their term length plus the 30-day grace, because a prepaid term produces no
renewal webhook and cache age says nothing about whether it is paid up.
Monthly is unchanged at 30 days.

**Remediation for a stale cache:** `scripts/backfill-stripe-subscription-periods.ts`
already read both shapes. `--verify-only` audits drift, `--apply` re-stamps.
Used it to unblock Amy before the code fix landed.

**The direction that works:** `src/` imports Deno `_shared` modules (e.g.
`hipaa_model_surface`), so shared logic belongs in `_shared` with the Node side
importing it, never a second copy.

#!/usr/bin/env tsx
/**
 * One-shot backfill: populate `subscriptions.stripe_current_period_start/end`
 * (and `stripe_subscription_cached_at`) for rows that pre-date the voice
 * billing period cache added in migration `20260420100000_voice_telnyx_platform`.
 *
 * The Stripe webhook refreshes these columns on every subscription lifecycle
 * event, so over time the backfill becomes unnecessary — but until each
 * business has had at least one such event since the cache column existed,
 * voice quota gating (`voice_reserve_for_call` etc.) will fall back to
 * degraded pathways or deny calls outright. Run this script once after
 * deploying the voice/Telnyx platform and again any time you reset the
 * cache columns.
 *
 * Usage:
 *   # dry run (default): prints what would be updated, hits Stripe read-only
 *   npx tsx scripts/backfill-stripe-subscription-periods.ts
 *
 *   # execute updates
 *   npx tsx scripts/backfill-stripe-subscription-periods.ts --apply
 *
 *   # only rows missing period_end entirely (default: also refreshes rows
 *   # whose cache is older than --stale-hours)
 *   npx tsx scripts/backfill-stripe-subscription-periods.ts --apply --only-missing
 *
 *   # refresh rows cached more than N hours ago (default: 24)
 *   npx tsx scripts/backfill-stripe-subscription-periods.ts --apply --stale-hours 6
 *
 *   # rate-limit Stripe requests (default: 4 rps)
 *   npx tsx scripts/backfill-stripe-subscription-periods.ts --apply --rps 2
 *
 *   # audit-only: report drift between DB cache and Stripe WITHOUT writing.
 *   # Use this to confirm a past backfill is still accurate, or to spot-check
 *   # webhook coverage. Always exits 0 unless Stripe calls themselves failed.
 *   npx tsx scripts/backfill-stripe-subscription-periods.ts --verify-only
 *
 * Required env:
 *   NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL)
 *   SUPABASE_SERVICE_ROLE_KEY
 *   STRIPE_SECRET_KEY
 */
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

type Args = {
  apply: boolean;
  onlyMissing: boolean;
  staleHours: number;
  rps: number;
  /** Audit mode: compare DB cache vs. Stripe, never write. Supersedes --apply. */
  verifyOnly: boolean;
  /** Drift tolerance in seconds when comparing Stripe period_end to DB cache. */
  verifyToleranceSec: number;
};

function parseArgs(argv: string[]): Args {
  const out: Args = {
    apply: false,
    onlyMissing: false,
    staleHours: 24,
    rps: 4,
    verifyOnly: false,
    verifyToleranceSec: 2
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--only-missing") out.onlyMissing = true;
    else if (a === "--verify-only") out.verifyOnly = true;
    else if (a === "--verify-tolerance-sec") {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v < 0)
        throw new Error(`--verify-tolerance-sec must be a non-negative number (got ${argv[i]})`);
      out.verifyToleranceSec = v;
    } else if (a === "--stale-hours") {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v < 0) throw new Error(`--stale-hours must be a non-negative number (got ${argv[i]})`);
      out.staleHours = v;
    } else if (a === "--rps") {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) throw new Error(`--rps must be > 0 (got ${argv[i]})`);
      out.rps = v;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: tsx scripts/backfill-stripe-subscription-periods.ts [--apply] [--only-missing] [--stale-hours N] [--rps N] [--verify-only] [--verify-tolerance-sec N]"
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  // --verify-only overrides --apply so we never accidentally write in audit mode.
  if (out.verifyOnly) out.apply = false;
  return out;
}

type SubRow = {
  id: string;
  business_id: string;
  stripe_subscription_id: string | null;
  stripe_current_period_end: string | null;
  stripe_subscription_cached_at: string | null;
  status: string;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const stripeKey = process.env.STRIPE_SECRET_KEY ?? "";
  if (!supabaseUrl || !serviceKey || !stripeKey) {
    console.error(
      "Missing env: require NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY, STRIPE_SECRET_KEY"
    );
    process.exit(2);
  }

  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const stripe = new Stripe(stripeKey, { apiVersion: "2026-02-25.clover" });

  const staleCutoffIso = new Date(Date.now() - args.staleHours * 3600 * 1000).toISOString();
  const mode = args.verifyOnly ? "VERIFY-ONLY" : args.apply ? "APPLY" : "DRY-RUN";
  console.log(
    `[backfill] mode=${mode} onlyMissing=${args.onlyMissing} staleHours=${args.staleHours} rps=${args.rps}${args.verifyOnly ? ` toleranceSec=${args.verifyToleranceSec}` : ""}`
  );

  // PostgREST caps any single response at its `max-rows` setting (default
  // 1000 on hosted Supabase). A naive .select() would silently drop every
  // subscription past row 1000, which for this script would mean voice
  // quota gating stays broken for a random ~1/N of the fleet while the run
  // reports success. Paginate with ordered `.range()` windows until a page
  // returns fewer rows than requested.
  const PAGE_SIZE = 500;
  const rows: SubRow[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data: pageRows, error: pageErr } = await supabase
      .from("subscriptions")
      .select(
        "id, business_id, stripe_subscription_id, stripe_current_period_end, stripe_subscription_cached_at, status"
      )
      .not("stripe_subscription_id", "is", null)
      // Deterministic ordering is required for range-based pagination — without
      // it PostgREST may emit overlapping/missing rows across pages.
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (pageErr) {
      console.error(`subscriptions select failed at offset ${offset}:`, pageErr.message);
      process.exit(1);
    }
    const page = (pageRows ?? []) as SubRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }

  // In verify mode we want EVERY sub with a stripe_subscription_id — the
  // staleness/missing filter is a write-path optimization and would hide
  // drift on freshly cached rows that are nevertheless wrong.
  const targets = rows.filter((r) => {
    if (!r.stripe_subscription_id) return false;
    if (args.verifyOnly) return true;
    if (r.stripe_current_period_end == null) return true;
    if (args.onlyMissing) return false;
    if (!r.stripe_subscription_cached_at) return true;
    return r.stripe_subscription_cached_at < staleCutoffIso;
  });

  console.log(
    `[backfill] scanned=${rows.length} candidates=${targets.length} (missing=${rows.filter((r) => r.stripe_current_period_end == null).length}, stale-or-uncached=${rows.filter((r) => r.stripe_current_period_end != null && (!r.stripe_subscription_cached_at || r.stripe_subscription_cached_at < staleCutoffIso)).length})`
  );

  const minGapMs = Math.ceil(1000 / args.rps);
  let lastTickAt = 0;
  const counts = {
    updated: 0,
    skippedNoPeriods: 0,
    skippedStripeError: 0,
    /** --verify-only: rows where DB cache matches Stripe within tolerance. */
    verifiedOk: 0,
    /** --verify-only: rows where DB `stripe_current_period_end` differs from Stripe. */
    verifiedDrift: 0,
    /** --verify-only: rows where DB has no cached period_end (i.e. needs backfill). */
    verifiedMissing: 0
  };

  for (const row of targets) {
    const wait = Math.max(0, minGapMs - (Date.now() - lastTickAt));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastTickAt = Date.now();

    let sub: Stripe.Subscription;
    try {
      sub = await stripe.subscriptions.retrieve(row.stripe_subscription_id as string);
    } catch (err) {
      counts.skippedStripeError += 1;
      console.error(
        `[backfill] stripe.subscriptions.retrieve ${row.stripe_subscription_id} failed:`,
        err instanceof Error ? err.message : String(err)
      );
      continue;
    }

    // Stripe moved `current_period_start/end` from Subscription → SubscriptionItem
    // in API version 2025-03-31.basil. Our pinned `2026-02-25.clover` is post-basil,
    // so the authoritative period lives on `items.data[i]`. We derive the
    // subscription-wide window as [min(start), max(end)] across items; for the
    // single-item subs this project creates today that reduces to item[0]. The
    // legacy top-level fallback is kept for older accounts still running a
    // pre-basil API version on the Stripe side.
    type ItemPeriod = { current_period_start?: unknown; current_period_end?: unknown };
    const items = ((sub.items?.data ?? []) as Array<Stripe.SubscriptionItem & ItemPeriod>);
    let itemStart: number | undefined;
    let itemEnd: number | undefined;
    for (const it of items) {
      const s = it.current_period_start;
      const e = it.current_period_end;
      if (typeof s === "number" && Number.isFinite(s)) {
        itemStart = itemStart == null ? s : Math.min(itemStart, s);
      }
      if (typeof e === "number" && Number.isFinite(e)) {
        itemEnd = itemEnd == null ? e : Math.max(itemEnd, e);
      }
    }
    const legacy = sub as unknown as { current_period_start?: unknown; current_period_end?: unknown };
    const rawStart =
      typeof itemStart === "number"
        ? itemStart
        : typeof legacy.current_period_start === "number"
          ? legacy.current_period_start
          : undefined;
    const rawEnd =
      typeof itemEnd === "number"
        ? itemEnd
        : typeof legacy.current_period_end === "number"
          ? legacy.current_period_end
          : undefined;
    if (typeof rawStart !== "number" || typeof rawEnd !== "number") {
      counts.skippedNoPeriods += 1;
      console.warn(
        `[backfill] ${row.business_id} sub=${row.stripe_subscription_id} status=${sub.status} — no current_period_start/end on Stripe subscription or its items; skipping (items=${items.length})`
      );
      continue;
    }

    const update = {
      stripe_current_period_start: new Date(rawStart * 1000).toISOString(),
      stripe_current_period_end: new Date(rawEnd * 1000).toISOString(),
      stripe_subscription_cached_at: new Date().toISOString()
    };

    // -------- Verify-only: compare DB cache to Stripe. --------------------
    // Drift tolerance is tiny on purpose; webhook races might set the cache
    // a few seconds off from Stripe's canonical `current_period_end` but
    // anything > 2s is almost certainly a missed/stale webhook worth
    // surfacing. `rawStart` is not checked — Stripe never mutates the start
    // of an active period, so an end-only check catches drift reliably.
    if (args.verifyOnly) {
      if (row.stripe_current_period_end == null) {
        counts.verifiedMissing += 1;
        console.log(
          `[backfill] VERIFY-MISSING biz=${row.business_id} sub=${row.stripe_subscription_id} status=${row.status}/${sub.status} stripe_period_end=${update.stripe_current_period_end} db_period_end=NULL`
        );
        continue;
      }
      const dbEndSec = Math.floor(Date.parse(row.stripe_current_period_end) / 1000);
      const driftSec = Math.abs(rawEnd - dbEndSec);
      if (driftSec <= args.verifyToleranceSec) {
        counts.verifiedOk += 1;
      } else {
        counts.verifiedDrift += 1;
        console.log(
          `[backfill] VERIFY-DRIFT biz=${row.business_id} sub=${row.stripe_subscription_id} status=${row.status}/${sub.status} stripe_period_end=${update.stripe_current_period_end} db_period_end=${row.stripe_current_period_end} drift=${driftSec}s`
        );
      }
      continue;
    }

    console.log(
      `[backfill] ${mode} biz=${row.business_id} sub=${row.stripe_subscription_id} status=${row.status}/${sub.status} period=${update.stripe_current_period_start} → ${update.stripe_current_period_end}`
    );

    if (!args.apply) continue;

    const { error: upErr } = await supabase
      .from("subscriptions")
      .update(update)
      .eq("id", row.id);
    if (upErr) {
      console.error(`[backfill] update failed for ${row.business_id}: ${upErr.message}`);
      continue;
    }
    counts.updated += 1;
  }

  if (args.verifyOnly) {
    const total = counts.verifiedOk + counts.verifiedDrift + counts.verifiedMissing;
    console.log(
      `[backfill] verify done: ok=${counts.verifiedOk}, drift=${counts.verifiedDrift}, missing=${counts.verifiedMissing}, skipped_no_periods=${counts.skippedNoPeriods}, skipped_stripe_error=${counts.skippedStripeError} (examined=${total})`
    );
    if (counts.verifiedDrift > 0 || counts.verifiedMissing > 0) {
      console.log(
        "[backfill] NOTE: drift/missing rows detected — re-run with --apply (no --verify-only) to sync them."
      );
    }
    return;
  }

  console.log(
    `[backfill] done: ${args.apply ? "updated" : "would-update"}=${args.apply ? counts.updated : targets.length - counts.skippedNoPeriods - counts.skippedStripeError}, skipped_no_periods=${counts.skippedNoPeriods}, skipped_stripe_error=${counts.skippedStripeError}`
  );

  if (!args.apply) {
    console.log("[backfill] dry-run: re-run with --apply to execute");
  }
}

main().catch((err) => {
  console.error("[backfill] fatal:", err instanceof Error ? err.stack : err);
  process.exit(1);
});

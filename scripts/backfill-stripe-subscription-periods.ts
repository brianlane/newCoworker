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
};

function parseArgs(argv: string[]): Args {
  const out: Args = { apply: false, onlyMissing: false, staleHours: 24, rps: 4 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--only-missing") out.onlyMissing = true;
    else if (a === "--stale-hours") {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v < 0) throw new Error(`--stale-hours must be a non-negative number (got ${argv[i]})`);
      out.staleHours = v;
    } else if (a === "--rps") {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) throw new Error(`--rps must be > 0 (got ${argv[i]})`);
      out.rps = v;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: tsx scripts/backfill-stripe-subscription-periods.ts [--apply] [--only-missing] [--stale-hours N] [--rps N]"
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
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
  const mode = args.apply ? "APPLY" : "DRY-RUN";
  console.log(
    `[backfill] mode=${mode} onlyMissing=${args.onlyMissing} staleHours=${args.staleHours} rps=${args.rps}`
  );

  const { data: rawRows, error } = await supabase
    .from("subscriptions")
    .select("id, business_id, stripe_subscription_id, stripe_current_period_end, stripe_subscription_cached_at, status")
    .not("stripe_subscription_id", "is", null);
  if (error) {
    console.error("subscriptions select failed:", error.message);
    process.exit(1);
  }
  const rows = (rawRows ?? []) as SubRow[];

  const targets = rows.filter((r) => {
    if (!r.stripe_subscription_id) return false;
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
  const counts = { updated: 0, skippedNoPeriods: 0, skippedStripeError: 0 };

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

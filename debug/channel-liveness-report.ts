#!/usr/bin/env tsx
/**
 * "Is anyone actually receiving our alerts?" Read the human signals.
 *
 * The read-only twin of the daily `channel-liveness-sweep`, and the
 * instrument its thresholds were calibrated against. Both call the SAME
 * `reportChannelLiveness`, so they share one fleet query, one residency
 * skip, one per-tenant isolation and one judgement: if this prints SILENT,
 * that is exactly what the sweep would have written to the admin System
 * Errors card. The only thing the sweep adds is the writing.
 *
 * WHY THIS EXISTS. `debug/email-delivery-report.ts` and
 * `debug/whatsapp-delivery-report.ts` answer "did the message arrive". This
 * one answers the question underneath, which no delivery receipt can: is a
 * human still there. KYP Ads had 16 of 16 owner alerts carrier-confirmed
 * `delivered` to a Canadian number whose owner had moved to Hong Kong and
 * stopped carrying the SIM. Every receipt was accurate and the channel was
 * dead. See .cursor/memory/feedback_delivered_is_not_received.md.
 *
 * Reading the output, per channel:
 *   live         a human acted on this channel inside the threshold
 *   SILENT       we alert on it and nobody has acted; this is the alarm
 *   unused       too few alerts in the window to tell broken from unused
 *   undecidable  we alert on it, and no evidence exists either way yet
 *
 * `unused` and `undecidable` are NOT failures and are deliberately not
 * folded into `SILENT`. Six of eleven tenants send between one and three
 * alerts a month; calling those channels dead would be six false alarms
 * against two real ones, which is how an alarm gets ignored. Each line
 * states the limit it was judged against, so the policy is visible where it
 * is applied rather than in a header that could drift from it.
 *
 * A line ending in `(unattributed)` means the signal is real but we cannot
 * prove it was the alert audience: a dashboard read stamped before the
 * read-actor column existed, or a WhatsApp thread we could not match to an
 * owner number.
 *
 * Strictly READ-ONLY. Writes nothing, alerts nobody. Safe on any tenant.
 *
 * Usage:
 *   tsx debug/channel-liveness-report.ts
 *   tsx debug/channel-liveness-report.ts --business <uuid>
 *   tsx debug/channel-liveness-report.ts --unhealthy-only
 *   tsx debug/channel-liveness-report.ts --json
 */
import { createClient } from "@supabase/supabase-js";
import { loadEnv } from "./_shared.ts";
import { livenessFinding } from "../src/lib/notifications/channel-liveness.ts";
import { reportChannelLiveness } from "../src/lib/notifications/channel-liveness-read.ts";

loadEnv();

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
  const sb = createClient(url, key, { auth: { persistSession: false } });

  const unhealthyOnly = process.argv.includes("--unhealthy-only");
  const asJson = process.argv.includes("--json");

  const rows = await reportChannelLiveness({
    client: sb as never,
    businessId: arg("business") ?? undefined
  });

  const tally = { dark: 0, degraded: 0, live: 0, skipped: 0, failed: 0 };
  const out: unknown[] = [];

  for (const row of rows) {
    if (row.outcome === "skipped") {
      tally.skipped += 1;
      if (!asJson) console.log(`### ${row.business.name}\n   SKIPPED  ${row.reason}\n`);
      continue;
    }
    if (row.outcome === "failed") {
      // A failed read is a finding, not something to render as a clean row.
      tally.failed += 1;
      if (!asJson) console.log(`### ${row.business.name}\n   FAILED   ${row.error}\n`);
      continue;
    }
    const { judgement } = row;
    tally[judgement.state] += 1;
    if (unhealthyOnly && judgement.state === "live") continue;

    const finding = livenessFinding(row.business.name, judgement);
    if (asJson) {
      out.push({
        businessId: row.business.id,
        name: row.business.name,
        state: judgement.state,
        channels: judgement.channels,
        finding
      });
      continue;
    }

    console.log(`### ${row.business.name}  [${judgement.state.toUpperCase()}]`);
    for (const c of judgement.channels) {
      const label = c.verdict === "silent" ? "SILENT" : c.verdict;
      const soft = c.verdict === "live" && !c.attributed ? "  (unattributed)" : "";
      console.log(`   ${label.padEnd(12)} ${c.channel.padEnd(10)} ${c.detail}${soft}`);
    }
    if (finding) console.log(`   -> ${finding.level}: ${finding.message}`);
    console.log("");
  }

  if (asJson) {
    console.log(JSON.stringify({ tally, report: out }, null, 2));
    return;
  }
  console.log(
    `${tally.dark} dark, ${tally.degraded} degraded, ${tally.live} healthy, ` +
      `${tally.skipped} skipped, ${tally.failed} failed.`
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

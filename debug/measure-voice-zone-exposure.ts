/**
 * What our voice traffic actually costs in Telnyx termination, by rate zone.
 *
 * Answers two questions that the flat per-minute cost assumption cannot:
 *
 *   1. BACKWARD. Of every outbound leg we have placed, how many minutes
 *      landed above the lower-48 baseline, and what did that cost? Then
 *      cross-checks the answer against what Telnyx actually billed, so the
 *      zone table is validated against an invoice rather than trusted.
 *   2. FORWARD. Across every dialable contact, what is the blended
 *      termination rate we should be sizing deals with?
 *
 * Run it by hand after a rate deck lands:
 *
 *   npx tsx debug/measure-voice-zone-exposure.ts
 *   npx tsx debug/measure-voice-zone-exposure.ts --json
 *
 * `--json` is what `.github/workflows/telnyx-voice-rate-cutover.yml` reads to
 * decide whether the calibrated constant has drifted far enough to open a PR.
 *
 * TWO DURATIONS, AND WHY THIS PREFERS ONE. Telnyx does not send a duration
 * on hangup (see the telnyx-no-call-duration memory), so
 * `voice_settlements.telnyx_reported_duration_seconds` is 0 on a large
 * minority of rows. Those fall back to `billable_seconds`, which is OUR
 * tenant-facing meter. The count of fallbacks is reported, because a number
 * built mostly from fallbacks is a weaker claim than one built from Telnyx's
 * own figure.
 */

import { Client } from "pg";

import { loadEnv, sessionDbUrl } from "./_shared.ts";
import {
  NANP_BASELINE_CENTS_PER_MINUTE,
  VOICE_RATE_DECK_SHA256,
  blendedVoiceTerminationRate,
  voiceZoneFor
} from "../src/lib/plans/voice-zone-rates.ts";

loadEnv();

const asJson = process.argv.includes("--json");

/**
 * `--since YYYY-MM-DD` restricts the ACTUALS to days on or after that date.
 *
 * This is what makes a post-cutover measurement mean anything: a new rate
 * deck takes effect at an instant, and averaging across the boundary blends
 * old and new rates into a number that describes neither.
 */
const sinceArg = process.argv.find((arg) => arg.startsWith("--since="));
const since = sinceArg ? sinceArg.slice("--since=".length) : null;
if (since !== null && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
  throw new Error(`--since must be YYYY-MM-DD, got "${since}"`);
}

/**
 * A read-only SESSION connection over the IPv4 pooler.
 *
 * Postgres rather than PostgREST on purpose. It needs no service-role key
 * (CI already holds SUPABASE_DB_PASSWORD for the migration push, and the
 * project ref is in supabase/config.toml, so the cutover workflow adds no
 * new secret), it can join voice_call_transcripts to voice_settlements,
 * which PostgREST refuses for want of a declared foreign key, and it is not
 * subject to the silent 1000-row cap on an un-limited select.
 */
async function connect(): Promise<Client> {
  const url = sessionDbUrl();
  const client = new Client({
    connectionString: url,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false },
    // This script only ever reads; any write in this session errors.
    options: "-c default_transaction_read_only=on"
  });
  await client.connect();
  return client;
}

/**
 * Telnyx bills voice in whole minutes per leg (every NANP row in the deck is
 * `60/60`), so a 12 second call that hit voicemail still costs a full
 * minute. Modelling it any other way understates every short call, and short
 * calls are most of an AI dialer's traffic.
 */
function billedMinutes(seconds: number): number {
  return seconds > 0 ? Math.ceil(seconds / 60) : 0;
}

type LegRow = {
  direction: string | null;
  caller_e164: string | null;
  forwarded_to_e164: string | null;
  /** Telnyx's own figure; 0 on the many hangups that carry no duration. */
  telnyx_seconds: string | number;
  /** Our tenant-facing meter, the fallback when Telnyx reported nothing. */
  our_seconds: string | number;
};

async function main(): Promise<void> {
  const client = await connect();
  let legRows: LegRow[];
  let costRows: { direction: string; billed_seconds: string; cost_micros: string }[];
  let contactRows: { customer_e164: string }[];
  try {
    // One join, done in the database. `caller_e164` is the DESTINATION on an
    // outbound transcript (verified against voice_outbound_dial_log.to_e164),
    // and a forwarded leg dials a human, so both carry termination.
    legRows = (
      await client.query<LegRow>(
        `select t.direction,
                t.caller_e164,
                t.forwarded_to_e164,
                coalesce(s.telnyx_reported_duration_seconds, 0) as telnyx_seconds,
                coalesce(s.billable_seconds, 0)                 as our_seconds
           from voice_call_transcripts t
           left join voice_settlements s on s.call_control_id = t.call_control_id`
      )
    ).rows;

    costRows = (
      await client.query(
        `select direction, billed_seconds, cost_micros
           from telnyx_cost_daily
          where record_type = 'sip-trunking'
            and ($1::date is null or day >= $1::date)`,
        [since]
      )
    ).rows;

    contactRows = (
      await client.query(
        `select customer_e164 from contacts where customer_e164 like '+1%'`
      )
    ).rows;
  } finally {
    await client.end();
  }

  // ---- backward: what we have already dialed -----------------------------
  const byZone = new Map<string, { cents: number; legs: number; minutes: number }>();
  let fellBackToOurMeter = 0;
  let legCount = 0;

  for (const row of legRows) {
    // On an OUTBOUND transcript `caller_e164` holds the destination we
    // dialed, not our own DID (verified against voice_outbound_dial_log.to_e164).
    // A forwarded leg dials a human, so it carries termination too.
    const destinations = [
      row.direction === "outbound" ? row.caller_e164 : null,
      row.forwarded_to_e164
    ].filter((value): value is string => Boolean(value));

    for (const destination of destinations) {
      const telnyxSeconds = Number(row.telnyx_seconds);
      const seconds = telnyxSeconds > 0 ? telnyxSeconds : Number(row.our_seconds);
      if (telnyxSeconds <= 0) fellBackToOurMeter += 1;

      const zone = voiceZoneFor(destination);
      if (!zone) continue;
      legCount += 1;
      const key = `${zone.iso} ${zone.label}`;
      const bucket = byZone.get(key) ?? { cents: zone.centsPerMinute, legs: 0, minutes: 0 };
      bucket.legs += 1;
      bucket.minutes += billedMinutes(seconds);
      byZone.set(key, bucket);
    }
  }

  const modeledMinutes = [...byZone.values()].reduce((sum, z) => sum + z.minutes, 0);
  const modeledCents = [...byZone.values()].reduce((sum, z) => sum + z.minutes * z.cents, 0);
  const baselineCents = modeledMinutes * NANP_BASELINE_CENTS_PER_MINUTE;
  const aboveBaselineMinutes = [...byZone.values()]
    .filter((z) => z.cents > NANP_BASELINE_CENTS_PER_MINUTE)
    .reduce((sum, z) => sum + z.minutes, 0);

  // ---- the invoice cross-check -------------------------------------------
  // This is the part that makes the zone table trustworthy: our modeled
  // rate has to land near what Telnyx actually charged, or the table (or
  // the destination column we read) is wrong.
  const outbound = costRows.filter((r) => r.direction === "outbound");
  const actualSeconds = outbound.reduce((sum, r) => sum + Number(r.billed_seconds ?? 0), 0);
  const actualCents = outbound.reduce((sum, r) => sum + Number(r.cost_micros ?? 0) / 10_000, 0);
  const actualCentsPerMinute =
    actualSeconds > 0 ? actualCents / (actualSeconds / 60) : null;

  // ---- forward: the callable universe ------------------------------------
  const blend = blendedVoiceTerminationRate(contactRows.map((row) => row.customer_e164));

  const report = {
    deckSha256: VOICE_RATE_DECK_SHA256,
    actualsSince: since,
    baselineCentsPerMinute: NANP_BASELINE_CENTS_PER_MINUTE,
    history: {
      legs: legCount,
      billedMinutes: modeledMinutes,
      minutesAboveBaseline: aboveBaselineMinutes,
      modeledCents: Math.round(modeledCents * 10_000) / 10_000,
      atBaselineCents: Math.round(baselineCents * 10_000) / 10_000,
      legsUsingOurMeterNotTelnyx: fellBackToOurMeter,
      byZone: Object.fromEntries(
        [...byZone.entries()].map(([zone, v]) => [
          zone,
          { centsPerMinute: v.cents, legs: v.legs, billedMinutes: v.minutes }
        ])
      )
    },
    actuals: {
      billedSeconds: actualSeconds,
      cents: Math.round(actualCents * 10_000) / 10_000,
      centsPerMinute:
        actualCentsPerMinute === null
          ? null
          : Math.round(actualCentsPerMinute * 10_000) / 10_000
    },
    forward: {
      contacts: blend.priced + blend.unpriced,
      pricedContacts: blend.priced,
      unpricedContacts: blend.unpriced,
      blendedCentsPerMinute: blend.centsPerMinute,
      multipleOfBaseline:
        Math.round((blend.centsPerMinute / NANP_BASELINE_CENTS_PER_MINUTE) * 100) / 100
    }
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`Telnyx voice zone exposure  (deck ${VOICE_RATE_DECK_SHA256.slice(0, 12)}...)\n`);
  console.log("HISTORY: every outbound + forwarded leg, priced by zone");
  console.log(`  ${"zone".padEnd(30)} ${"c/min".padStart(7)} ${"legs".padStart(5)} ${"min".padStart(6)}`);
  for (const [zone, v] of [...byZone.entries()].sort(
    (a, b) => b[1].minutes * b[1].cents - a[1].minutes * a[1].cents
  )) {
    console.log(
      `  ${zone.padEnd(30)} ${String(v.cents).padStart(7)} ${String(v.legs).padStart(5)} ${String(v.minutes).padStart(6)}`
    );
  }
  console.log(
    `\n  ${modeledMinutes} billed minutes, ${aboveBaselineMinutes} above baseline (${
      modeledMinutes > 0 ? ((100 * aboveBaselineMinutes) / modeledMinutes).toFixed(1) : "0.0"
    }%)`
  );
  console.log(
    `  modeled $${(modeledCents / 100).toFixed(4)} vs $${(baselineCents / 100).toFixed(4)} if all Zone 1`
  );
  console.log(
    `  ${fellBackToOurMeter} leg(s) used OUR meter because Telnyx reported no duration`
  );

  console.log(
    `\nACTUALS: what Telnyx billed for outbound (telnyx_cost_daily${since ? `, since ${since}` : ""})`
  );
  console.log(`  ${actualSeconds} billed seconds, $${(actualCents / 100).toFixed(4)}`);
  console.log(
    `  effective ${actualCentsPerMinute === null ? "n/a" : `${actualCentsPerMinute.toFixed(4)}c/min`} against a ${NANP_BASELINE_CENTS_PER_MINUTE}c baseline`
  );

  console.log(`\nFORWARD: the callable universe`);
  console.log(
    `  ${report.forward.contacts} contacts (${blend.unpriced} not NANP, excluded)`
  );
  console.log(
    `  blended ${blend.centsPerMinute}c/min = ${report.forward.multipleOfBaseline}x baseline`
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

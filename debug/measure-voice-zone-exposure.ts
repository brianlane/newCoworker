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
 *
 * LRN VS DIALED. Telnyx bills Global Voice Conversational by Terminating
 * LRN / Term Prefix, not always by the dialed E.164 NPA-NXX. Amy Sep 2026
 * MDR: dialed +19289512316 matches `1928` Zone 1 @ 0.5c, Terminating LRN
 * 9283630020 matches `1928363` High Cost Zone 5 @ 7c. That false Zone 1
 * signal is why auto-cutover PR #1809 (0.9 to 1.03) closed: list price
 * did not change.
 *
 * `voice_settlements`, `voice_call_transcripts`, and `telnyx_cost_daily`
 * do not store LRN today. This script discovers those column names on
 * the live catalog at runtime and prefers them when present; when they
 * are absent (today) HISTORY is dialed-NPA and can understate ported
 * high-cost legs. `actuals` from `telnyx_cost_daily` already include
 * whatever Telnyx billed, LRN and all, so a jump in effective c/min
 * against an all-Zone-1 HISTORY is LRN mix, not a Zone 1 list-price
 * cutover. Do not bump `voiceTelnyxCentsPerMinute` for that.
 */

import { Client } from "pg";

import { loadEnv, sessionDbUrl } from "./_shared.ts";
import {
  NANP_BASELINE_CENTS_PER_MINUTE,
  blendedVoiceTerminationRate,
  telnyxTerminatingLrnFromFields,
  voiceZoneFor
} from "../src/lib/plans/voice-zone-rates.ts";
import { VOICE_RATE_DECK_SHA256 } from "../src/lib/plans/voice-zone-rates.generated.ts";

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
  [extra: string]: unknown;
};

/** Column names we would use for LRN if a table ever grew them. */
const LRN_COLUMN_CANDIDATES = [
  "terminating_lrn",
  "term_lrn",
  "lrn",
  "term_prefix",
  "terminating_prefix"
] as const;

async function discoverLrnColumns(
  client: Client
): Promise<{ table: string; column: string }[]> {
  const { rows } = await client.query<{ table_name: string; column_name: string }>(
    `select table_name, column_name
       from information_schema.columns
      where table_schema = 'public'
        and table_name = any($1::text[])
        and column_name = any($2::text[])`,
    [
      ["voice_settlements", "voice_call_transcripts", "telnyx_cost_daily"],
      [...LRN_COLUMN_CANDIDATES]
    ]
  );
  return rows.map((row) => ({ table: row.table_name, column: row.column_name }));
}

async function main(): Promise<void> {
  const client = await connect();
  let legRows: LegRow[];
  let costRows: { direction: string; billed_seconds: string; cost_micros: string }[];
  let contactRows: { customer_e164: string }[];
  let lrnColumns: { table: string; column: string }[] = [];
  try {
    lrnColumns = await discoverLrnColumns(client);
    const settlementLrnSelect = lrnColumns
      .filter((c) => c.table === "voice_settlements")
      .map((c) => `s.${c.column}`)
      .join(", ");
    const transcriptLrnSelect = lrnColumns
      .filter((c) => c.table === "voice_call_transcripts")
      .map((c) => `t.${c.column}`)
      .join(", ");
    const extraSelect = [settlementLrnSelect, transcriptLrnSelect].filter(Boolean).join(", ");

    // One join, done in the database. `caller_e164` is the DESTINATION on an
    // outbound transcript (verified against voice_outbound_dial_log.to_e164),
    // and a forwarded leg dials a human, so both carry termination.
    legRows = (
      await client.query<LegRow>(
        `select t.direction,
                t.caller_e164,
                t.forwarded_to_e164,
                coalesce(s.telnyx_reported_duration_seconds, 0) as telnyx_seconds,
                coalesce(s.billable_seconds, 0)                 as our_seconds${
                  extraSelect.length > 0 ? `,\n                ${extraSelect}` : ""
                }
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
  let legsMatchedOnLrn = 0;
  let legsMatchedOnDialed = 0;

  for (const row of legRows) {
    // On an OUTBOUND transcript `caller_e164` holds the destination we
    // dialed, not our own DID (verified against voice_outbound_dial_log.to_e164).
    // A forwarded leg dials a human, so it carries termination too. Stored
    // LRN, when we have it, belongs to the outbound dest, not the transfer.
    const storedLrn = telnyxTerminatingLrnFromFields(row);
    const destinations: Array<{ dialed: string; lrn: string | null }> = [];
    if (row.direction === "outbound" && row.caller_e164) {
      destinations.push({ dialed: row.caller_e164, lrn: storedLrn });
    }
    if (row.forwarded_to_e164) {
      destinations.push({ dialed: row.forwarded_to_e164, lrn: null });
    }

    for (const destination of destinations) {
      const telnyxSeconds = Number(row.telnyx_seconds);
      const seconds = telnyxSeconds > 0 ? telnyxSeconds : Number(row.our_seconds);
      if (telnyxSeconds <= 0) fellBackToOurMeter += 1;

      const zone = voiceZoneFor(destination.dialed, { lrn: destination.lrn });
      if (!zone) continue;
      legCount += 1;
      if (zone.matchedOn === "lrn") legsMatchedOnLrn += 1;
      else legsMatchedOnDialed += 1;
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
      lrn: {
        storedColumns: lrnColumns,
        legsMatchedOnLrn,
        legsMatchedOnDialed,
        gap:
          lrnColumns.length === 0
            ? "No terminating_lrn / term_prefix column on voice_settlements, voice_call_transcripts, or telnyx_cost_daily. HISTORY is dialed-NPA and can understate LRN-ported high-cost legs (Payson +19289512316 billed Zone 5 via LRN 9283630020). actuals from telnyx_cost_daily already include LRN. Do not treat an actuals jump against all-Zone-1 HISTORY as a Zone 1 list-price cutover (PR #1809)."
            : legsMatchedOnLrn === 0
              ? "terminating_lrn exists on voice_settlements but no HISTORY leg matched on LRN. Hangup webhooks usually omit it; the sip-trunking MDR backfill is the fill path. Dialed-NPA HISTORY can still understate Payson-style Zone 5 legs."
              : null
      },
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
  if (lrnColumns.length === 0) {
    console.log(
      "  LRN: not stored in DB. HISTORY is dialed-NPA and can understate ported high-cost legs."
    );
    console.log(
      "  actuals already include LRN. A c/min jump against all-Zone-1 HISTORY is mix, not list price (PR #1809)."
    );
  } else {
    console.log(
      `  LRN: ${legsMatchedOnLrn} leg(s) matched on stored LRN, ${legsMatchedOnDialed} on dialed (${lrnColumns
        .map((c) => `${c.table}.${c.column}`)
        .join(", ")})`
    );
  }

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

/**
 * Decide whether the 2026-08-31 Telnyx rate cutover actually moved what we
 * pay, and if so edit the one constant that encodes it.
 *
 * Run by `.github/workflows/telnyx-voice-rate-cutover.yml`. Reads the JSON
 * report from `debug/measure-voice-zone-exposure.ts --json --since=<day>`
 * on stdin and writes a decision to stdout, plus GitHub Actions outputs.
 *
 * WHY A MEASUREMENT AND NOT A DECK DIFF. Telnyx emails only the new deck,
 * never a diff, and the deck sits behind a portal.telnyx.com session that no
 * CI job can log into. So "did the rates change?" is not answerable from the
 * rates. It IS answerable from the invoice: our own effective cost per
 * outbound minute, measured on both sides of the cutover instant.
 *
 * WHAT IT WILL AND WILL NOT CHANGE. It moves
 * `ENTERPRISE_UNIT_COSTS.voiceTelnyxCentsPerMinute` by the measured drift,
 * because that constant is a blended all-in per-minute figure and a
 * termination change passes straight through it. It does NOT touch the
 * generated zone table: that needs the new CSV, which needs a human. When
 * drift is found the PR says so explicitly rather than leaving a
 * half-updated model that looks current.
 */

import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

/**
 * Minimum post-cutover sample before any edit is proposed.
 *
 * At fleet volumes a single short call moves the effective rate by more
 * than the drift threshold, so acting on a thin sample would open a PR
 * describing noise as a price change. 60 billed minutes is roughly a week
 * of current traffic.
 */
const MIN_BILLED_MINUTES = 60;

/**
 * Drift below this is not worth a PR. The pre-cutover figure is itself only
 * good to about a hundredth of a cent (it is $1.12 over 210 minutes), and
 * 0.05c/min on the fleet's ~200 minutes a month is under a dollar a year.
 */
const DRIFT_THRESHOLD_CENTS = 0.05;

const PRICING_PATH = "src/lib/plans/enterprise-pricing.ts";

type Report = {
  actualsSince: string | null;
  actuals: { billedSeconds: number; cents: number; centsPerMinute: number | null };
  forward: { blendedCentsPerMinute: number; pricedContacts: number };
};

function setOutput(key: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  // Heredoc form: a multi-line value in the `k=v` form silently truncates.
  appendFileSync(file, `${key}<<__EOF__\n${value}\n__EOF__\n`);
}

function main(): void {
  const baseline = Number(process.argv[2]);
  if (!Number.isFinite(baseline)) {
    throw new Error("usage: telnyx-rate-drift.ts <pre-cutover-cents-per-minute>");
  }
  const report = JSON.parse(readFileSync(0, "utf8")) as Report;

  const billedMinutes = report.actuals.billedSeconds / 60;
  const measured = report.actuals.centsPerMinute;

  const reasons: string[] = [];
  if (measured === null || billedMinutes < MIN_BILLED_MINUTES) {
    reasons.push(
      `only ${billedMinutes.toFixed(1)} billed minutes since ${report.actualsSince ?? "the cutover"}, need ${MIN_BILLED_MINUTES}`
    );
  }

  const drift = measured === null ? 0 : Math.round((measured - baseline) * 10_000) / 10_000;
  if (reasons.length === 0 && Math.abs(drift) < DRIFT_THRESHOLD_CENTS) {
    reasons.push(
      `drift ${drift >= 0 ? "+" : ""}${drift}c/min is under the ${DRIFT_THRESHOLD_CENTS}c threshold`
    );
  }

  if (reasons.length > 0) {
    console.log(`NO CHANGE: ${reasons.join("; ")}`);
    setOutput("changed", "false");
    setOutput("summary", reasons.join("; "));
    return;
  }

  // Apply the drift to the blended all-in constant. Two decimal places:
  // the constant is quoted to that precision and the calibration behind it
  // does not support more.
  const source = readFileSync(PRICING_PATH, "utf8");
  const match = /voiceTelnyxCentsPerMinute: ([\d.]+),/.exec(source);
  if (!match) {
    throw new Error(`could not find voiceTelnyxCentsPerMinute in ${PRICING_PATH}`);
  }
  const current = Number(match[1]);
  const updated = Math.round((current + drift) * 100) / 100;

  if (updated === current) {
    const summary = `drift ${drift}c/min rounds away at 2dp; ${current} unchanged`;
    console.log(`NO CHANGE: ${summary}`);
    setOutput("changed", "false");
    setOutput("summary", summary);
    return;
  }

  writeFileSync(
    PRICING_PATH,
    source.replace(match[0], `voiceTelnyxCentsPerMinute: ${updated},`)
  );

  const summary = [
    `Measured ${measured}c/min of outbound termination since ${report.actualsSince}, against ${baseline}c/min before the cutover.`,
    `That is ${drift >= 0 ? "+" : ""}${drift}c/min, over the ${DRIFT_THRESHOLD_CENTS}c threshold, on ${billedMinutes.toFixed(1)} billed minutes.`,
    ``,
    `\`voiceTelnyxCentsPerMinute\` ${current} -> ${updated}`,
    ``,
    `NOT done by this PR, and needing a human:`,
    `- The generated zone table still describes the PREVIOUS deck. Download the current`,
    `  "Global Voice Conversational" CSV from portal.telnyx.com and run`,
    `  \`npx tsx scripts/generate-voice-zone-rates.ts <deck>.csv\`. The diff on`,
    `  \`src/lib/plans/voice-zone-rates.generated.ts\` is the only per-prefix answer to`,
    `  "what changed?", because Telnyx does not publish one.`,
    `- Re-check the docblock's Zone 1 claim if the drift is large: it would mean traffic`,
    `  has left the lower-48 baseline, which is a routing story, not a pricing one.`
  ].join("\n");

  console.log(`CHANGED: ${current} -> ${updated}`);
  setOutput("changed", "true");
  setOutput("summary", summary);
  setOutput("title", `Telnyx voice rate cutover: ${current} -> ${updated} cents/min`);
}

main();

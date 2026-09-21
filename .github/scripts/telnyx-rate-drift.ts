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
 *
 * MIX IS NOT A PRICE CHANGE. The constant is a Zone 1 minute. A rise in the
 * invoice that the current zone table already prices (a few Zone 5 minutes
 * on top of a Zone 1 fleet) must not be folded in: the surcharge path
 * prices that tail separately, and folding it in bills Zone 1 twice. The
 * 2026-09-21 Monday run was this case (+0.06c/min versus the calibration,
 * within 0.05c/min of the zone table) and then died, because the verify
 * step ran tests that pin the constant at 0.9 after the script had already
 * rewritten it. A real edit now moves those pins in the same write, so the
 * verify step can pass and the PR can open.
 */

import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

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

/**
 * Tests that pin `voiceTelnyxCentsPerMinute` to a literal. A real edit
 * moves the literal in the same write as the constant. The Monday workflow
 * git-adds these paths; a test reads the workflow and fails if one is
 * missing, because a pin left behind fails the verify step and no PR opens.
 */
export const CONSTANT_PIN_PATHS = [
  "tests/enterprise-pricing.test.ts",
  "tests/voice-zone-rates.test.ts"
] as const;

/**
 * The termination rate the constant is currently calibrated to.
 *
 * THIS FILE IS REWRITTEN BY THIS SCRIPT, and it has to be. The drift is
 * `measured - calibrated`, applied on top of whatever the constant is now.
 * If the comparison point stayed pinned at the pre-cutover figure, then the
 * Monday after a recalibration merged, the same measurement would produce
 * the same delta and add it AGAIN to the already-updated constant, opening
 * a new PR every week and compounding the cutover forever. Moving the
 * comparison point in the same commit makes the job idempotent: once the
 * bump lands, the next run measures a drift of ~0 and does nothing.
 */
const CALIBRATION_PATH = ".github/telnyx-rate-calibration.json";

export type RateReport = {
  actualsSince: string | null;
  /** Deck baseline (0.5c for US/CA Zone 1). Present on reports from the measure script. */
  baselineCentsPerMinute?: number;
  actuals: { billedSeconds: number; cents: number; centsPerMinute: number | null };
  /**
   * Calls classified by the CURRENT zone table. `modeledCents / billedMinutes`
   * is what Telnyx should have charged if that table is still the price list.
   * An invoice that lands on this rate moved because of mix, not because
   * Zone 1 itself got more expensive.
   */
  history?: {
    billedMinutes: number;
    modeledCents: number;
    minutesAboveBaseline?: number;
  };
};

export type RateCalibration = {
  terminationCentsPerMinute: number;
  measuredThrough: string;
  note: string;
};

export type DriftDecision = {
  changed: boolean;
  summary: string;
  title: string;
  /** Rewritten pricing source, present only when `changed`. */
  pricingSource: string | null;
  /** Rewritten calibration, present only when `changed`. */
  calibration: RateCalibration | null;
  /** Rewritten pin-test sources, present only when `changed`. */
  pinSources: Record<string, string> | null;
};

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function signed(n: number): string {
  return `${n >= 0 ? "+" : ""}${n}`;
}

/**
 * How far the invoice sits from the rate the current zone table predicts.
 * Null when there are not enough classified minutes to trust the table:
 * a thin history must not be used to explain away a real jump.
 */
function zoneTableGap(
  report: RateReport,
  measured: number
): { gap: number; modeledRate: number; minutes: number; atBaseline: number | null } | null {
  const history = report.history;
  if (!history || !(history.billedMinutes >= MIN_BILLED_MINUTES)) return null;
  if (!Number.isFinite(history.modeledCents)) return null;
  const modeledRate = round4(history.modeledCents / history.billedMinutes);
  const above = history.minutesAboveBaseline;
  const atBaseline =
    typeof above === "number" && Number.isFinite(above) ? round4(history.billedMinutes - above) : null;
  return {
    gap: round4(measured - modeledRate),
    modeledRate,
    minutes: history.billedMinutes,
    atBaseline
  };
}

const PIN_PATTERN = /voiceTelnyxCentsPerMinute\)\.toBe\(([\d.]+)\)/g;

/** Move every `toBe(<current>)` pin of the constant to `updated`. */
export function retargetConstantPins(source: string, from: number, to: number, path: string): string {
  let hits = 0;
  const next = source.replace(PIN_PATTERN, (_full, raw: string) => {
    if (Number(raw) !== from) {
      throw new Error(
        `${path} pins voiceTelnyxCentsPerMinute at ${raw}, but the constant is ${from}. ` +
          `Refusing to rewrite a pin this script does not own.`
      );
    }
    hits += 1;
    return `voiceTelnyxCentsPerMinute).toBe(${to})`;
  });
  if (hits === 0) {
    throw new Error(
      `${path} has no voiceTelnyxCentsPerMinute).toBe pin. The Monday verify step would fail ` +
        `and no PR would open.`
    );
  }
  return next;
}

export function decideTelnyxRateDrift(input: {
  report: RateReport;
  calibration: RateCalibration;
  pricingSource: string;
  pinSources: Record<string, string>;
}): DriftDecision {
  const { report, calibration, pricingSource } = input;
  const baseline = calibration.terminationCentsPerMinute;
  if (!Number.isFinite(baseline)) {
    throw new Error(`${CALIBRATION_PATH} has no numeric terminationCentsPerMinute`);
  }

  const billedMinutes = report.actuals.billedSeconds / 60;
  const measured = report.actuals.centsPerMinute;
  const unchanged = (summary: string): DriftDecision => ({
    changed: false,
    summary,
    title: "",
    pricingSource: null,
    calibration: null,
    pinSources: null
  });

  if (measured === null || billedMinutes < MIN_BILLED_MINUTES) {
    return unchanged(
      `only ${billedMinutes.toFixed(1)} billed minutes since ${report.actualsSince ?? "the cutover"}, need ${MIN_BILLED_MINUTES}`
    );
  }

  const drift = round4(measured - baseline);
  if (Math.abs(drift) < DRIFT_THRESHOLD_CENTS) {
    return unchanged(
      `drift ${signed(drift)}c/min is under the ${DRIFT_THRESHOLD_CENTS}c threshold`
    );
  }

  const explained = zoneTableGap(report, measured);
  if (explained && Math.abs(explained.gap) < DRIFT_THRESHOLD_CENTS) {
    const baselineRate = report.baselineCentsPerMinute ?? 0.5;
    const atBaseline =
      explained.atBaseline === null
        ? ""
        : `, ${explained.atBaseline} of them still at the ${baselineRate}c baseline`;
    return unchanged(
      `drift ${signed(drift)}c/min versus the ${baseline}c/min calibration, on ${billedMinutes.toFixed(1)} billed minutes, but the invoice (${measured}c/min) is within ${DRIFT_THRESHOLD_CENTS}c/min of the current zone table (${explained.modeledRate}c/min) on ${explained.minutes} classified minutes${atBaseline}. Destination mix, not a Zone 1 list-price change.`
    );
  }

  const match = /voiceTelnyxCentsPerMinute: ([\d.]+),/.exec(pricingSource);
  if (!match) {
    throw new Error(`could not find voiceTelnyxCentsPerMinute in ${PRICING_PATH}`);
  }
  const current = Number(match[1]);
  const updated = Math.round((current + drift) * 100) / 100;
  if (updated === current) {
    return unchanged(`drift ${drift}c/min rounds away at 2dp; ${current} unchanged`);
  }

  const pinSources: Record<string, string> = {};
  for (const path of CONSTANT_PIN_PATHS) {
    const source = input.pinSources[path];
    if (source === undefined) {
      throw new Error(`missing pin source for ${path}`);
    }
    pinSources[path] = retargetConstantPins(source, current, updated, path);
  }

  const summary = [
    `Measured ${measured}c/min of outbound termination since ${report.actualsSince}, against the ${baseline}c/min this constant was last calibrated to.`,
    `That is ${signed(drift)}c/min, over the ${DRIFT_THRESHOLD_CENTS}c threshold, on ${billedMinutes.toFixed(1)} billed minutes.`,
    explained
      ? `The zone table prices this traffic at ${explained.modeledRate}c/min, ${signed(explained.gap)}c/min away from the invoice, so the deck does not explain the charge.`
      : `Not enough classified call history to compare the invoice to the zone table.`,
    ``,
    `\`voiceTelnyxCentsPerMinute\` ${current} -> ${updated}`,
    `\`${CALIBRATION_PATH}\` ${baseline} -> ${measured} (moves the comparison point, so`,
    `next Monday measures ~0 drift instead of stacking this delta again)`,
    `The \`toBe(${current})\` pins in ${CONSTANT_PIN_PATHS.join(" and ")} move to ${updated} in this same commit, so the verify step can pass.`,
    ``,
    `NOT done by this PR, and needing a human:`,
    `- The generated zone table still describes the PREVIOUS deck. Download the current`,
    `  "Global Voice Conversational" CSV from portal.telnyx.com and run`,
    `  \`npx tsx scripts/generate-voice-zone-rates.ts <deck>.csv\`. The diff on`,
    `  \`src/lib/plans/voice-zone-rates.generated.ts\` is the only per-prefix answer to`,
    `  "what changed?", because Telnyx does not publish one.`,
    `- Re-check the docblock's Zone 1 claim if the drift is large: it would mean traffic`,
    `  has left the lower-48 baseline, which is a routing story, not a pricing one.`,
    `- \`TELNYX_VOICE_ADJUNCT_CENTS_PER_MINUTE\`'s docblock names "the 0.9 cents/min`,
    `  voiceTelnyxCentsPerMinute above" in prose. This edit only moves the value, so that`,
    `  sentence now cites a number that is no longer there. Update it in the same PR.`
  ].join("\n");

  return {
    changed: true,
    summary,
    title: `Telnyx voice rate cutover: ${current} -> ${updated} cents/min`,
    pricingSource: pricingSource.replace(match[0], `voiceTelnyxCentsPerMinute: ${updated},`),
    calibration: {
      ...calibration,
      terminationCentsPerMinute: measured,
      measuredThrough: report.actualsSince ?? calibration.measuredThrough
    },
    pinSources
  };
}

function setOutput(key: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  // Heredoc form: a multi-line value in the `k=v` form silently truncates.
  appendFileSync(file, `${key}<<__EOF__\n${value}\n__EOF__\n`);
}

function main(): void {
  const calibration = JSON.parse(readFileSync(CALIBRATION_PATH, "utf8")) as RateCalibration;
  const report = JSON.parse(readFileSync(0, "utf8")) as RateReport;
  const pinSources: Record<string, string> = {};
  for (const path of CONSTANT_PIN_PATHS) {
    pinSources[path] = readFileSync(path, "utf8");
  }
  const decision = decideTelnyxRateDrift({
    report,
    calibration,
    pricingSource: readFileSync(PRICING_PATH, "utf8"),
    pinSources
  });

  if (!decision.changed || !decision.pricingSource || !decision.calibration || !decision.pinSources) {
    console.log(`NO CHANGE: ${decision.summary}`);
    setOutput("changed", "false");
    setOutput("summary", decision.summary);
    return;
  }

  // Constant, comparison point, and the test pins move in ONE write. Leaving
  // a pin at the old number fails the workflow's verify step, and the PR
  // never opens. Leaving the comparison point behind re-applies this delta
  // next Monday.
  writeFileSync(PRICING_PATH, decision.pricingSource);
  writeFileSync(CALIBRATION_PATH, `${JSON.stringify(decision.calibration, null, 2)}\n`);
  for (const [path, source] of Object.entries(decision.pinSources)) {
    writeFileSync(path, source);
  }

  console.log(`CHANGED: ${decision.title}`);
  setOutput("changed", "true");
  setOutput("summary", decision.summary);
  setOutput("title", decision.title);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  main();
}

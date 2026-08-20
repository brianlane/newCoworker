/**
 * Operator email: the nightly cron sweep watchdog found something wrong with
 * the scheduled fleet.
 *
 * Sent only when there are findings. A healthy fleet is silent, because an
 * alert that arrives every night stops being read, and this one has to still
 * mean something on the night a sweep actually stops.
 *
 * Every finding carries its own remediation line (see
 * src/lib/cron/sweep-watchdog.ts) rather than a generic "check the logs",
 * because the useful next command differs completely by failure kind: a
 * missing run is a live cron.job question, a silent-200 is an application
 * question, and a timeout is a budget question.
 */

import { buildBrandedEmailHtml } from "@/lib/email/branded-html";
import { opsNotificationEmail } from "@/lib/email/templates/ops-vps-deletion";
import type { Finding, FindingKind } from "@/lib/cron/sweep-watchdog";

export type OpsCronSweepHealthInput = {
  findings: Finding[];
  /** Sweeps that reported in clean, named so the email shows its own scope. */
  healthy: string[];
  /** How many sweeps the watchdog knows about. */
  checked: number;
  /** App origin without trailing slash, for the branded shell. */
  siteUrl: string;
};

export type OpsCronSweepHealthEmail = {
  subject: string;
  text: string;
  html: string;
};

const HEADINGS: Record<FindingKind, string> = {
  missing: "STOPPED: no run recorded",
  failed: "CRASHED: the sweep threw",
  errors: "PARTIAL FAILURE: answered ok with errors inside",
  degraded: "INCOMPLETE: the watchdog could not read one of its two sources",
  slow: "SLOW: approaching the 150s ceiling",
  burst: "HTTP BURST: anomalies clustering past the pager bar",
  // Retired as an emailed kind: solo HTTP anomalies are suppressed and
  // counted (the evaluator pages a "burst" instead), but the kind stays in
  // the union for the summary's byKind history.
  http: "HTTP LAYER: timeout or transport error"
};

/** Worst first: a sweep that stopped outranks one that merely got slow. */
const ORDER: FindingKind[] = ["missing", "failed", "errors", "degraded", "slow", "burst", "http"];

/** Only called for a kind the caller already found findings for. */
function section(kind: FindingKind, findings: Finding[]): string {
  const mine = findings.filter((f) => f.kind === kind);
  const lines = mine.map((f) => `  - ${f.sweep}: ${f.detail}`).join("\n");
  // The action is per kind, not per finding, so print it once.
  return `${HEADINGS[kind]} (${mine.length})\n${lines}\n\n  What to do: ${mine[0].action}`;
}

export function buildOpsCronSweepHealthEmail(
  input: OpsCronSweepHealthInput
): OpsCronSweepHealthEmail {
  const kinds = ORDER.filter((k) => input.findings.some((f) => f.kind === k));
  // The subject names the worst kind, so the inbox line alone distinguishes
  // "a sweep died" from "one tenant errored".
  const worst = kinds[0];
  const subject =
    worst === "missing" || worst === "failed"
      ? `[ops] ACTION REQUIRED: ${input.findings.length} cron sweep problem(s), including a ${worst === "missing" ? "stopped" : "crashed"} sweep`
      : `[ops] Cron sweep watchdog: ${input.findings.length} finding(s)`;

  const textLines = [
    `The cron sweep watchdog checked ${input.checked} scheduled sweeps and found ${input.findings.length} problem(s). ` +
      `It reads two sources: public.cron_sweep_runs, where each sweep records its own completion, and ` +
      `net._http_response, which holds the HTTP-layer outcome a dead sweep could not report itself.`,
    ...kinds.map((kind) => section(kind, input.findings)),
    input.healthy.length > 0
      ? `Reported in clean (${input.healthy.length}): ${input.healthy.join(", ")}.`
      : "No sweep reported in clean this run.",
    `Reminder on why this email exists: pg_cron cannot see any of the above. pg_net's http_post is ` +
      `asynchronous, so cron.job_run_details records "succeeded" for every one of these jobs no matter ` +
      `what happened downstream.`
  ];

  const html = buildBrandedEmailHtml({
    // Internal ops inbox, omit the owner-facing platform signature block.
    platformSignature: false,
    siteUrl: input.siteUrl,
    documentTitle: subject,
    heading: "Cron sweep watchdog",
    bodyBlocks: textLines.map((t) => ({ kind: "text" as const, text: t })),
    recipientEmail: opsNotificationEmail()
  });

  return { subject, text: textLines.join("\n\n"), html };
}

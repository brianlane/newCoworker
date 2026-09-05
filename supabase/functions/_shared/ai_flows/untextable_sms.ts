/**
 * Untextable-lead bookkeeping for a flow run (pure, no IO).
 *
 * A 1:1 lead text whose destination is outside US/CA skips while no
 * international gateway is configured (tenant long codes are domestic-only,
 * Telnyx ticket #557577; the skip itself lives in the worker's send_sms
 * step). Skipping keeps the run alive, but on its own it left two lies in
 * place: the flow's owner alerts kept saying "I sent them the greeting" and
 * "no reply to 3 follow-ups" about texts that never went out, and the lead
 * heard nothing at all (KYP Ads / VFM, Aug 12 2026, an Indian mobile).
 *
 * This module is the memory that makes the rest of the run honest. The
 * worker records every lead-facing untextable skip here (and whether the
 * same message went out by email instead), the planner appends the note to
 * every owner-facing alert that follows, and the worker sends a standalone
 * owner alert when no flow step is going to carry it. The record rides in
 * `scope.vars` as a JSON string, like the other engine markers
 * (`__self_phone_scrubbed`, `__waited_*`), so it survives parks and resumes.
 */

/** Engine var (underscore-prefixed: hidden from templates by convention). */
export const UNTEXTABLE_SMS_VAR = "__untextable_sms";

/** What happened to the lead's copy of a skipped text. */
export type UntextableSmsEmailOutcome = "emailed" | "no_email" | "email_failed";

export type UntextableSmsState = {
  /** The lead number the texts could not reach (E.164). */
  to: string;
  /** ISO country of that number, or null when the prefix is unrecognized. */
  country: string | null;
  /** How the flow referred to the recipient ("the lead", a contact label). */
  label: string;
  /** Lead-facing texts skipped so far in this run. */
  skipped: number;
  /** How many of those went out by email instead. */
  emailed: number;
  /** How many had an address but the email itself failed. */
  emailFailed: number;
  /** The address the fallback emails went to (last one used), if any. */
  emailTo: string | null;
  /** True once an owner-facing surface has carried the note this run. */
  told: boolean;
};

export type UntextableSmsSkip = {
  to: string;
  country: string | null;
  label: string;
  email: UntextableSmsEmailOutcome;
  emailTo?: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the run's untextable record, or null when no lead-facing text has
 * been skipped for this reason. Tolerant of a malformed var (an older run,
 * a hand-edited context): anything unreadable reads as "nothing recorded".
 */
export function readUntextableSms(
  vars: Record<string, unknown> | undefined
): UntextableSmsState | null {
  const raw = vars?.[UNTEXTABLE_SMS_VAR];
  if (typeof raw !== "string" || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.to !== "string" || parsed.to.length === 0) return null;
  return {
    to: parsed.to,
    country: typeof parsed.country === "string" ? parsed.country : null,
    label: typeof parsed.label === "string" && parsed.label ? parsed.label : "the lead",
    skipped: typeof parsed.skipped === "number" ? parsed.skipped : 0,
    emailed: typeof parsed.emailed === "number" ? parsed.emailed : 0,
    emailFailed: typeof parsed.emailFailed === "number" ? parsed.emailFailed : 0,
    emailTo: typeof parsed.emailTo === "string" && parsed.emailTo ? parsed.emailTo : null,
    told: parsed.told === true
  };
}

function writeUntextableSms(vars: Record<string, unknown>, state: UntextableSmsState): void {
  vars[UNTEXTABLE_SMS_VAR] = JSON.stringify(state);
}

/**
 * Record one lead-facing skip. A run handles one lead, so a different
 * number simply restarts the tally (the note describes the latest one).
 */
export function recordUntextableSms(
  vars: Record<string, unknown>,
  skip: UntextableSmsSkip
): UntextableSmsState {
  const prior = readUntextableSms(vars);
  const base: UntextableSmsState =
    prior && prior.to === skip.to
      ? prior
      : {
          to: skip.to,
          country: skip.country,
          label: skip.label,
          skipped: 0,
          emailed: 0,
          emailFailed: 0,
          emailTo: null,
          told: false
        };
  const next: UntextableSmsState = {
    ...base,
    country: skip.country,
    label: skip.label || base.label,
    skipped: base.skipped + 1,
    emailed: base.emailed + (skip.email === "emailed" ? 1 : 0),
    emailFailed: base.emailFailed + (skip.email === "email_failed" ? 1 : 0),
    // A no_email skip carries no address, so the earlier rungs' address stays.
    emailTo: skip.emailTo ?? base.emailTo
  };
  writeUntextableSms(vars, next);
  return next;
}

/**
 * Mark that an owner-facing surface carried the note, so the worker's
 * standalone alert is not sent on top of it. No-op when nothing is recorded.
 */
export function markUntextableSmsTold(vars: Record<string, unknown>): void {
  const state = readUntextableSms(vars);
  if (!state || state.told) return;
  writeUntextableSms(vars, { ...state, told: true });
}

/**
 * Plain-English region name for an ISO country code ("IN" -> "India"),
 * falling back to the code itself when the runtime cannot name it.
 */
export function regionDisplayName(country: string): string {
  try {
    const name = new Intl.DisplayNames(["en"], { type: "region" }).of(country);
    return name && name !== country ? name : country;
  } catch {
    return country;
  }
}

function plural(n: number, singular: string, pluralForm: string): string {
  return n === 1 ? singular : pluralForm;
}

/**
 * The honest sentence(s) about an untextable lead, written to stand alone
 * or to follow a flow's own alert copy. Names the number and its country,
 * states that no text went out, and says exactly what happened by email.
 */
export function untextableSmsNote(state: UntextableSmsState): string {
  const where = state.country
    ? `in ${regionDisplayName(state.country)}`
    : "outside the US and Canada";
  const texts = plural(state.skipped, "the text", `the ${state.skipped} texts`);
  const head =
    `${state.to} is a number ${where}, and this account can only text US and Canadian numbers, ` +
    `so ${texts} to ${state.label} in this automation ${plural(state.skipped, "was", "were")} ` +
    "not sent.";
  let tail: string;
  if (state.emailed > 0 && state.emailed === state.skipped) {
    tail = ` I emailed the same ${plural(state.skipped, "message", "messages")} to ${state.emailTo} instead.`;
  } else if (state.emailed > 0) {
    tail =
      ` ${state.emailed} of ${state.skipped} went by email to ${state.emailTo} instead; ` +
      `the ${plural(state.skipped - state.emailed, "other", "others")} did not reach them.`;
  } else if (state.emailFailed > 0 && state.emailTo) {
    tail = ` I tried to email ${state.emailTo} instead, but the email failed, so they have not heard from us.`;
  } else {
    tail = " They have no email on file, so they have not heard from us.";
  }
  return head + tail;
}

/**
 * Append the untextable note to an owner-facing alert when the run has
 * skipped a lead text for this reason. The flow's own copy stays first (it
 * carries the lead details); the note follows so "I sent them the greeting"
 * is never the last word about a text that did not go out.
 */
export function withUntextableSmsNote(
  message: string,
  vars: Record<string, unknown> | undefined
): string {
  const state = readUntextableSms(vars);
  if (!state) return message;
  return `${message} Note: ${untextableSmsNote(state)}`;
}

/**
 * The worker's standalone owner alert, for a run with no owner-facing step
 * left to carry the note.
 */
export function untextableSmsOwnerAlert(state: UntextableSmsState): string {
  return `Heads up: I could not text ${state.label}. ${untextableSmsNote(state)}`;
}

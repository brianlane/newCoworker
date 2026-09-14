/**
 * Prospecting follow-up cadence: the two later touches after the first pitch.
 *
 * First pitch is drafted elsewhere (sweep probe or MCP) and is not this
 * module. These are the product defaults for the two automatic bumps that
 * chase silence: a day-3 soft bump with no booking link, and a day-10 last
 * bump that offers the calendar when the tenant has one.
 *
 * UNIQUE SUBJECTS ON PURPOSE. The old single nudge reused `pitch_subject`
 * so Gmail filed it in the same conversation. Outbound wants each later
 * touch to show up as its own short peer line. Gmail only threads a send
 * into an existing conversation when the subject matches AND In-Reply-To /
 * References / threadId are set; we pass none of those, so a distinct
 * subject starts a new thread. Replies still land: `rememberThread` records
 * the new conversation the same way the first pitch does.
 *
 * Stamps live on the prospect row (`followup_1_at`, `followup_2_at`). The
 * old `nudged_at` column is last-follow-up-sent (daily cap) and was copied
 * onto `followup_1_at` at migrate time so already-nudged rows do not get
 * the old "one follow-up" slot again.
 */

import type { AssembleOptions } from "./compose";

/** Silence before the first follow-up. */
export const FOLLOWUP_1_AFTER_DAYS = 3;

/** Silence before the last follow-up. */
export const FOLLOWUP_2_AFTER_DAYS = 10;

/**
 * Past this age a prospect is left alone: a late bump reads as a stranger.
 * Same 21-day floor the old day-5 path used, so ancient sends do not get a
 * sudden cold bump when this ships.
 */
export const FOLLOWUP_STALE_AFTER_DAYS = 21;

/** Follow-ups per pass, per business. Shared with first pitches via the cap. */
export const FOLLOWUP_BATCH = 5;

export type FollowupStep = 1 | 2;

export type FollowupStamp = "followup_1_at" | "followup_2_at";

export const FOLLOWUP_1_SUBJECTS = [
  "One gap after Instant Forms",
  "After the form fills",
  "The five-minute window"
] as const;

export const FOLLOWUP_2_SUBJECTS = [
  "Smaller ask",
  "Two-minute read",
  "Still relevant?"
] as const;

const ALL_FOLLOWUP_SUBJECTS: readonly string[] = [
  ...FOLLOWUP_1_SUBJECTS,
  ...FOLLOWUP_2_SUBJECTS
];

export type FollowupSpec = {
  step: FollowupStep;
  stamp: FollowupStamp;
  afterDays: number;
  bookingLink: boolean;
};

export const FOLLOWUP_SPECS: readonly FollowupSpec[] = [
  {
    step: 1,
    stamp: "followup_1_at",
    afterDays: FOLLOWUP_1_AFTER_DAYS,
    bookingLink: false
  },
  {
    step: 2,
    stamp: "followup_2_at",
    afterDays: FOLLOWUP_2_AFTER_DAYS,
    bookingLink: true
  }
];

export function followupSpec(step: FollowupStep): FollowupSpec {
  return FOLLOWUP_SPECS[step - 1];
}

/**
 * Gmail's thread key after stripping reply prefixes. Follow-up subjects must
 * not collide with the first pitch's fingerprint, or the unique-subject rule
 * is only a different string on the page.
 */
export function subjectFingerprint(subject: string): string {
  return subject
    .trim()
    .replace(/^(?:re|fw|fwd)\s*:\s*/gi, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** True when this subject is one of the product follow-up lines. */
export function isOutreachFollowupSubject(subject: string | null | undefined): boolean {
  if (!subject) return false;
  const fp = subjectFingerprint(subject);
  return ALL_FOLLOWUP_SUBJECTS.some((s) => subjectFingerprint(s) === fp);
}

function rotateIndex(key: string, n: number): number {
  let h = 5381;
  for (let i = 0; i < key.length; i += 1) {
    h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
  }
  return h % n;
}

/** Bounds the due queries compute from `now`. */
export type FollowupDueWindows = {
  /** Inclusive stale floor for day-10. Older than this is left alone. */
  staleIso: string;
  /** Day-10 due: sent_at <= this. Exclusive floor for day-3. */
  day10Iso: string;
  /** Day-3 due: sent_at <= this. */
  day3Iso: string;
};

export function followupDueWindows(now: Date): FollowupDueWindows {
  const day = 24 * 60 * 60 * 1000;
  return {
    staleIso: new Date(now.getTime() - FOLLOWUP_STALE_AFTER_DAYS * day).toISOString(),
    day10Iso: new Date(now.getTime() - FOLLOWUP_2_AFTER_DAYS * day).toISOString(),
    day3Iso: new Date(now.getTime() - FOLLOWUP_1_AFTER_DAYS * day).toISOString()
  };
}

export function firstSubjectNotMatching(
  pool: readonly string[],
  start: number,
  avoidFingerprint: string
): string {
  if (pool.length === 0) return "";
  const idx = start % pool.length;
  for (let i = 0; i < pool.length; i += 1) {
    const candidate = pool[(idx + i) % pool.length];
    if (subjectFingerprint(candidate) !== avoidFingerprint) return candidate;
  }
  return pool[idx];
}

/**
 * Pick a short unique subject for this step. Deterministic on prospect id so
 * a retried send (claim released after a provider fault) does not rotate to
 * a different line and look like a fresh campaign.
 *
 * Walks the pool if the first pick collides with the first-touch fingerprint,
 * which the product copy should never do (company-prefixed finding subjects
 * vs these short peer lines) but is cheap to refuse anyway.
 */
export function followupSubjectFor(
  step: FollowupStep,
  prospectId: string,
  pitchSubject: string | null
): string {
  const pool = step === 1 ? FOLLOWUP_1_SUBJECTS : FOLLOWUP_2_SUBJECTS;
  return firstSubjectNotMatching(
    pool,
    rotateIndex(prospectId, pool.length),
    subjectFingerprint(pitchSubject ?? "")
  );
}

/** Greeting name: the prospect's business, or a neutral fallback. */
export function followupGreetingName(businessName: string): string {
  return businessName.trim() || "there";
}

export function followupParagraphs(step: FollowupStep, businessName: string): string[] {
  const name = followupGreetingName(businessName);
  if (step === 1) {
    return [
      `Hi ${name},`,
      "One thing I left out: the costly part is rarely the ad click. It is the wait between the Instant Form and the first live answer.",
      "Worth a look?"
    ];
  }
  return [
    `Hi ${name},`,
    "If a full look is too much, the only question that matters is whether your clients' Meta leads get a live answer in the first few minutes.",
    "Relevant?"
  ];
}

/** assembleBody option for this step: day-3 never a link, day-10 always when one exists. */
export function followupAssembleOptions(step: FollowupStep): AssembleOptions {
  return { bookingLink: followupSpec(step).bookingLink };
}

/**
 * Undo a claimed follow-up that never left. Day-10 restores `nudged_at` to
 * the earlier step (or null), so a failed last bump does not erase the fact
 * that day-3 already went out, and does not drop today's cap count for that
 * earlier send.
 */
export function undoFollowupClaim(
  stamp: FollowupStamp,
  prior: { followup_1_at: string | null }
): { followup_1_at?: null; followup_2_at?: null; nudged_at: string | null } {
  if (stamp === "followup_1_at") {
    return { followup_1_at: null, nudged_at: null };
  }
  return { followup_2_at: null, nudged_at: prior.followup_1_at };
}

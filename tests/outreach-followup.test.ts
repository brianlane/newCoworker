/**
 * Follow-up cadence copy and stamps (src/lib/outreach/followup.ts).
 *
 * The product defaults for the two later touches: unique subjects that do
 * not reuse the first-pitch fingerprint, day-3 with no booking link, day-10
 * with the link, and undo patches that do not erase an earlier step.
 */
import { describe, expect, it } from "vitest";
import {
  FOLLOWUP_1_AFTER_DAYS,
  FOLLOWUP_1_SUBJECTS,
  FOLLOWUP_2_AFTER_DAYS,
  FOLLOWUP_2_SUBJECTS,
  FOLLOWUP_BATCH,
  FOLLOWUP_STALE_AFTER_DAYS,
  firstSubjectNotMatching,
  followupAssembleOptions,
  followupDueWindows,
  followupGreetingName,
  followupParagraphs,
  followupSpec,
  followupSubjectFor,
  isOutreachFollowupSubject,
  subjectFingerprint,
  undoFollowupClaim
} from "@/lib/outreach/followup";

const PITCH = "Acme HVAC: booking a job without the phone tag";
const ID = "22222222-2222-4222-8222-222222222222";

describe("cadence constants", () => {
  it("is three touches total: first pitch plus day-3 and day-10, stale at 21", () => {
    expect(FOLLOWUP_1_AFTER_DAYS).toBe(3);
    expect(FOLLOWUP_2_AFTER_DAYS).toBe(10);
    expect(FOLLOWUP_STALE_AFTER_DAYS).toBe(21);
    expect(FOLLOWUP_BATCH).toBe(5);
    expect(followupSpec(1)).toMatchObject({ stamp: "followup_1_at", bookingLink: false });
    expect(followupSpec(2)).toMatchObject({ stamp: "followup_2_at", bookingLink: true });
  });

  it("computes due windows from now so day-3 and day-10 do not overlap", () => {
    const now = new Date("2026-07-27T16:00:00Z");
    expect(followupDueWindows(now)).toEqual({
      staleIso: "2026-07-06T16:00:00.000Z",
      day10Iso: "2026-07-17T16:00:00.000Z",
      day3Iso: "2026-07-24T16:00:00.000Z"
    });
  });
});

describe("subjects", () => {
  it("strips reply prefixes before comparing fingerprints", () => {
    expect(subjectFingerprint("Re: Smaller ask")).toBe("smaller ask");
    expect(subjectFingerprint("FW: Two-minute read")).toBe("two-minute read");
    expect(subjectFingerprint("Fwd: After the form fills")).toBe("after the form fills");
  });

  it("picks a short unique subject that does not reuse the first-touch fingerprint", () => {
    const day3 = followupSubjectFor(1, ID, PITCH);
    const day10 = followupSubjectFor(2, ID, PITCH);
    expect(FOLLOWUP_1_SUBJECTS).toContain(day3);
    expect(FOLLOWUP_2_SUBJECTS).toContain(day10);
    expect(subjectFingerprint(day3)).not.toBe(subjectFingerprint(PITCH));
    expect(subjectFingerprint(day10)).not.toBe(subjectFingerprint(PITCH));
    expect(subjectFingerprint(day3)).not.toBe(subjectFingerprint(day10));
    expect(followupSubjectFor(1, ID, PITCH)).toBe(day3);
  });

  it("walks the pool when the first pick would reuse the pitch fingerprint", () => {
    const start = followupSubjectFor(1, ID, null);
    expect(followupSubjectFor(1, ID, start)).not.toBe(start);
    expect(FOLLOWUP_1_SUBJECTS).toContain(followupSubjectFor(1, ID, start));
  });

  it("firstSubjectNotMatching covers empty pools and total collisions", () => {
    expect(firstSubjectNotMatching([], 0, "x")).toBe("");
    expect(firstSubjectNotMatching(["Same"], 0, "same")).toBe("Same");
    expect(firstSubjectNotMatching(["Hello", "There"], 1, "there")).toBe("Hello");
  });

  it("recognizes product follow-up subjects, including a Re: prefix", () => {
    expect(isOutreachFollowupSubject(null)).toBe(false);
    expect(isOutreachFollowupSubject("")).toBe(false);
    expect(isOutreachFollowupSubject(PITCH)).toBe(false);
    expect(isOutreachFollowupSubject("Smaller ask")).toBe(true);
    expect(isOutreachFollowupSubject("Re: The five-minute window")).toBe(true);
  });
});

describe("body and CTA", () => {
  it("greets the company, or 'there' when the name is blank", () => {
    expect(followupGreetingName("Acme HVAC")).toBe("Acme HVAC");
    expect(followupGreetingName("  ")).toBe("there");
    expect(followupParagraphs(1, "Acme")[0]).toBe("Hi Acme,");
    expect(followupParagraphs(1, "  ")[0]).toBe("Hi there,");
  });

  it("uses the day-3 angle with no guilt phrasing", () => {
    const body = followupParagraphs(1, "Acme HVAC").join("\n");
    expect(body).toContain("Instant Form");
    expect(body).toContain("Worth a look?");
    expect(body.toLowerCase()).not.toMatch(/checking in|i wrote|just following up/);
  });

  it("uses the day-10 lower-door ask", () => {
    const body = followupParagraphs(2, "Acme HVAC").join("\n");
    expect(body).toContain("Meta leads");
    expect(body).toContain("Relevant?");
  });

  it("never puts the booking link on day-3 and always asks for it on day-10", () => {
    expect(followupAssembleOptions(1)).toEqual({ bookingLink: false });
    expect(followupAssembleOptions(2)).toEqual({ bookingLink: true });
  });
});

describe("undoFollowupClaim", () => {
  it("clears day-3 and restores nudged_at to day-3 when day-10 fails", () => {
    expect(undoFollowupClaim("followup_1_at", { followup_1_at: null })).toEqual({
      followup_1_at: null,
      nudged_at: null
    });
    expect(
      undoFollowupClaim("followup_2_at", { followup_1_at: "2026-07-22T16:00:00Z" })
    ).toEqual({
      followup_2_at: null,
      nudged_at: "2026-07-22T16:00:00Z"
    });
    expect(undoFollowupClaim("followup_2_at", { followup_1_at: null })).toEqual({
      followup_2_at: null,
      nudged_at: null
    });
  });
});

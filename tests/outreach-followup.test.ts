/**
 * Follow-up cadence copy and stamps (src/lib/outreach/followup.ts).
 *
 * The product defaults for the two later touches: unique subjects that do
 * not reuse the first-pitch fingerprint, day-3 with no booking link, day-10
 * with the link, and undo patches that do not erase an earlier step.
 */
import { describe, expect, it } from "vitest";
import {
  followupAssembleOptions,
  followupDueWindows,
  followupParagraphs,
  followupSubjectFor,
  isOutreachFollowupSubject,
  undoFollowupClaim
} from "@/lib/outreach/followup";

const PITCH = "Acme HVAC: booking a job without the phone tag";
const ID = "22222222-2222-4222-8222-222222222222";

const DAY3_SUBJECTS = [
  "One gap after Instant Forms",
  "After the form fills",
  "The five-minute window"
];
const DAY10_SUBJECTS = ["Smaller ask", "Two-minute read", "Still relevant?"];

describe("cadence windows", () => {
  it("computes day-3 and day-10 windows that do not overlap, stale at 21 days", () => {
    const now = new Date("2026-07-27T16:00:00Z");
    expect(followupDueWindows(now)).toEqual({
      staleIso: "2026-07-06T16:00:00.000Z",
      day10Iso: "2026-07-17T16:00:00.000Z",
      day3Iso: "2026-07-24T16:00:00.000Z"
    });
  });
});

describe("subjects", () => {
  it("picks a short unique subject that does not reuse the first-touch fingerprint", () => {
    const day3 = followupSubjectFor(1, ID, PITCH);
    const day10 = followupSubjectFor(2, ID, PITCH);
    expect(DAY3_SUBJECTS).toContain(day3);
    expect(DAY10_SUBJECTS).toContain(day10);
    expect(day3.toLowerCase()).not.toBe(PITCH.toLowerCase());
    expect(day10.toLowerCase()).not.toBe(PITCH.toLowerCase());
    expect(day3).not.toBe(day10);
    expect(followupSubjectFor(1, ID, PITCH)).toBe(day3);
  });

  it("steps to the next pool line when the first pick would reuse the pitch fingerprint", () => {
    const start = followupSubjectFor(1, ID, null);
    const next = followupSubjectFor(1, ID, start);
    expect(next).not.toBe(start);
    expect(DAY3_SUBJECTS).toContain(next);
  });

  it("recognizes product follow-up subjects, including reply prefixes", () => {
    expect(isOutreachFollowupSubject(null)).toBe(false);
    expect(isOutreachFollowupSubject("")).toBe(false);
    expect(isOutreachFollowupSubject(PITCH)).toBe(false);
    expect(isOutreachFollowupSubject("Smaller ask")).toBe(true);
    expect(isOutreachFollowupSubject("Re: The five-minute window")).toBe(true);
    expect(isOutreachFollowupSubject("FW: Two-minute read")).toBe(true);
    expect(isOutreachFollowupSubject("Fwd: After the form fills")).toBe(true);
  });
});

describe("body and CTA", () => {
  it("greets the company, or 'there' when the name is blank", () => {
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

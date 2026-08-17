import { describe, expect, it, vi } from "vitest";
import {
  buildMeetConferenceRequest,
  extractMeetJoinUrl,
  MEET_CONFERENCE_DATA_VERSION,
  MEET_CONFERENCE_SOLUTION,
  meetConferencePending,
  resolveMeetJoinUrl
} from "@/lib/google/meet";

const MEET_URL = "https://meet.google.com/abc-defg-hij";

describe("buildMeetConferenceRequest", () => {
  it("asks for hangoutsMeet and carries the caller's idempotency key", () => {
    expect(buildMeetConferenceRequest("req-1")).toEqual({
      createRequest: {
        requestId: "req-1",
        conferenceSolutionKey: { type: "hangoutsMeet" }
      }
    });
  });

  it("pins the solution type and the version opt-in", () => {
    // Both are sent to Google verbatim. `eventHangout` (the legacy value)
    // produces no Meet link, and without conferenceDataVersion=1 Google
    // ignores the conference block entirely, so a booking would silently
    // come back with no video link and no error.
    expect(MEET_CONFERENCE_SOLUTION).toBe("hangoutsMeet");
    expect(MEET_CONFERENCE_DATA_VERSION).toBe("1");
  });
});

describe("extractMeetJoinUrl", () => {
  it("prefers the top-level hangoutLink", () => {
    expect(extractMeetJoinUrl({ hangoutLink: MEET_URL })).toBe(MEET_URL);
  });

  it("falls back to the video entry point when hangoutLink is absent", () => {
    expect(
      extractMeetJoinUrl({
        conferenceData: { entryPoints: [{ entryPointType: "video", uri: MEET_URL }] }
      })
    ).toBe(MEET_URL);
  });

  it("never returns a phone entry point in place of the video link", () => {
    // Handing a customer a tel: URI when they were promised a video call is
    // worse than handing them nothing.
    expect(
      extractMeetJoinUrl({
        conferenceData: {
          entryPoints: [
            { entryPointType: "phone", uri: "tel:+1-555-0100" },
            { entryPointType: "more", uri: "https://tel.meet/abc" }
          ]
        }
      })
    ).toBeNull();
  });

  it("skips malformed entries and takes the first usable video one", () => {
    expect(
      extractMeetJoinUrl({
        conferenceData: {
          entryPoints: [null, "nope", { entryPointType: "video" }, { entryPointType: "video", uri: MEET_URL }]
        }
      })
    ).toBe(MEET_URL);
  });

  it("returns null for an empty hangoutLink, a missing conference, and junk bodies", () => {
    expect(extractMeetJoinUrl({ hangoutLink: "" })).toBeNull();
    expect(extractMeetJoinUrl({ id: "evt-1" })).toBeNull();
    expect(extractMeetJoinUrl({ conferenceData: null })).toBeNull();
    expect(extractMeetJoinUrl({ conferenceData: { entryPoints: "not-an-array" } })).toBeNull();
    expect(extractMeetJoinUrl(null)).toBeNull();
    expect(extractMeetJoinUrl("string")).toBeNull();
  });
});

describe("meetConferencePending", () => {
  it("is true only while Google is still provisioning", () => {
    const pending = { conferenceData: { createRequest: { status: { statusCode: "pending" } } } };
    expect(meetConferencePending(pending)).toBe(true);
  });

  it("is false for success, failure, and anything unshaped", () => {
    // `failure` matters as much as `success`: re-reading an event whose
    // conference Google gave up on would spend a round trip to learn nothing.
    for (const statusCode of ["success", "failure", undefined]) {
      expect(
        meetConferencePending({ conferenceData: { createRequest: { status: { statusCode } } } })
      ).toBe(false);
    }
    expect(meetConferencePending({ conferenceData: { createRequest: null } })).toBe(false);
    expect(meetConferencePending({})).toBe(false);
    expect(meetConferencePending(null)).toBe(false);
  });
});

describe("resolveMeetJoinUrl", () => {
  it("takes the link off the insert response without re-reading", async () => {
    const reread = vi.fn();
    expect(await resolveMeetJoinUrl({ hangoutLink: MEET_URL }, reread)).toBe(MEET_URL);
    expect(reread).not.toHaveBeenCalled();
  });

  it("re-reads exactly once when the conference is still pending", async () => {
    const reread = vi.fn(async () => ({ hangoutLink: MEET_URL }));
    const pending = { conferenceData: { createRequest: { status: { statusCode: "pending" } } } };
    expect(await resolveMeetJoinUrl(pending, reread)).toBe(MEET_URL);
    expect(reread).toHaveBeenCalledTimes(1);
  });

  it("gives up after one re-read that still has no link", async () => {
    // Never a poll loop: the appointment is already booked, and the caller
    // is often a live phone call waiting on the confirmation.
    const reread = vi.fn(async () => ({ conferenceData: { entryPoints: [] } }));
    const pending = { conferenceData: { createRequest: { status: { statusCode: "pending" } } } };
    expect(await resolveMeetJoinUrl(pending, reread)).toBeNull();
    expect(reread).toHaveBeenCalledTimes(1);
  });

  it("degrades to null when the re-read throws", async () => {
    const pending = { conferenceData: { createRequest: { status: { statusCode: "pending" } } } };
    const reread = vi.fn(async () => {
      throw new Error("proxy exploded");
    });
    await expect(resolveMeetJoinUrl(pending, reread)).resolves.toBeNull();
  });

  it("does not re-read when the conference already failed", async () => {
    const reread = vi.fn();
    const failed = { conferenceData: { createRequest: { status: { statusCode: "failure" } } } };
    expect(await resolveMeetJoinUrl(failed, reread)).toBeNull();
    expect(reread).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from "vitest";
import {
  buildZoomGuestHeadingTitle,
  extractFirstMinutesHeading,
  extractVttSpeakers,
  isGenericZoomTopic,
  pickZoomGuestName,
  ZOOM_GUEST_TITLE_SUFFIX,
  zoomTopicFromTitle
} from "@/lib/zoom/document-title";

/**
 * Zoom's default topics are shared across every instant meeting, so imports
 * collided in the Documents grid: several rows all reading "New Coworker's
 * Zoom Meeting" or the bare "Zoom meeting recording (transcript)". The
 * derived title uses what the transcript itself carries instead: who was on
 * the call, and what the minutes say it was about.
 */
describe("isGenericZoomTopic", () => {
  it("treats Zoom's defaults and blanks as no topic at all", () => {
    expect(isGenericZoomTopic(null)).toBe(true);
    expect(isGenericZoomTopic("")).toBe(true);
    expect(isGenericZoomTopic("   ")).toBe(true);
    expect(isGenericZoomTopic("Zoom Meeting")).toBe(true);
    expect(isGenericZoomTopic("zoom meeting")).toBe(true);
    expect(isGenericZoomTopic("New Coworker's Zoom Meeting")).toBe(true);
    expect(isGenericZoomTopic("Brian Lane's Personal Meeting Room")).toBe(true);
    expect(isGenericZoomTopic("Zoom meeting recording")).toBe(true);
  });

  it("keeps a topic the host actually chose", () => {
    expect(isGenericZoomTopic("Platform & Product Overview")).toBe(false);
    expect(isGenericZoomTopic("KYP onboarding")).toBe(false);
    // Contains "Zoom Meeting" but is clearly deliberate.
    expect(isGenericZoomTopic("Zoom Meeting with the Ashby team")).toBe(false);
  });
});

describe("zoomTopicFromTitle", () => {
  // Provisional titles have carried several shapes over time, and all of the
  // decoration is ours, not the host's words.
  it("strips every provisional-title shape back to the topic", () => {
    expect(zoomTopicFromTitle("Team sync (transcript)")).toBe("Team sync");
    expect(zoomTopicFromTitle("Team sync · Jul 29, 2026 (transcript)")).toBe("Team sync");
    // Older rows used a dash instead of parentheses.
    expect(zoomTopicFromTitle("Zoom meeting recording - transcript")).toBe(
      "Zoom meeting recording"
    );
    expect(zoomTopicFromTitle("Zoom meeting recording : transcript")).toBe(
      "Zoom meeting recording"
    );
    expect(zoomTopicFromTitle("Team sync")).toBe("Team sync");
  });

  // The dash-suffixed generic rows were being read as host-chosen titles and
  // skipped by the backfill.
  it("leaves a dash-suffixed generic title recognisable as generic", () => {
    expect(isGenericZoomTopic(zoomTopicFromTitle("Zoom meeting recording - transcript"))).toBe(
      true
    );
    expect(isGenericZoomTopic(zoomTopicFromTitle("KYP onboarding - transcript"))).toBe(false);
  });
});

describe("extractVttSpeakers", () => {
  it("returns speakers in first-spoken order, without duplicates", () => {
    const text = [
      "Brian Lane: Thanks for jumping on.",
      "Alexander: Happy to be here.",
      "Brian Lane: So the platform does three things.",
      "Alexander: Got it."
    ].join("\n");
    expect(extractVttSpeakers(text)).toEqual(["Brian Lane", "Alexander"]);
  });

  it("ignores lines that are not Speaker: words", () => {
    const text = ["No speaker here.", "Brian Lane: Hello.", "12:04", ""].join("\n");
    expect(extractVttSpeakers(text)).toEqual(["Brian Lane"]);
  });

  it("does not mistake a mid-sentence colon for a speaker", () => {
    // A long prefix is prose, not a name.
    const text = "So here is the thing about our pricing: it is per seat.";
    expect(extractVttSpeakers(text)).toEqual([]);
  });

  it("returns nothing for empty input", () => {
    expect(extractVttSpeakers("")).toEqual([]);
  });
});

describe("pickZoomGuestName", () => {
  it("picks the first speaker who is not the host", () => {
    expect(
      pickZoomGuestName({
        speakers: ["Brian Lane", "Alexander"],
        hostNames: ["Brian Lane", "New Coworker"]
      })
    ).toBe("Alexander");
  });

  it("matches hosts case-insensitively and ignores extra whitespace", () => {
    expect(
      pickZoomGuestName({
        speakers: ["  brian lane ", "Selena"],
        hostNames: ["Brian Lane"]
      })
    ).toBe("Selena");
  });

  it("prefers a nickname the summary introduces", () => {
    expect(
      pickZoomGuestName({
        speakers: ["Brian Lane", "Alexander"],
        hostNames: ["Brian Lane"],
        summary: 'Brian Lane and Alexander ("Bobby") discussed the platform.'
      })
    ).toBe("Bobby");
  });

  it("falls back to the first name of a full display name", () => {
    expect(
      pickZoomGuestName({
        speakers: ["Brian Lane", "Alexander Delacroix"],
        hostNames: ["Brian Lane"]
      })
    ).toBe("Alexander");
  });

  it("ignores a bracketed phrase that is not a nickname", () => {
    // The summary uses brackets for an aside, not an alias.
    expect(
      pickZoomGuestName({
        speakers: ["Brian Lane", "Alexander"],
        hostNames: ["Brian Lane"],
        summary: "Alexander (who runs the Phoenix branch office) asked about pricing."
      })
    ).toBe("Alexander");
  });

  it("falls back when the summary never mentions the guest", () => {
    expect(
      pickZoomGuestName({
        speakers: ["Brian Lane", "Alexander"],
        hostNames: ["Brian Lane"],
        summary: "Brian walked through the roadmap."
      })
    ).toBe("Alexander");
  });

  it("handles a summary with empty brackets", () => {
    expect(
      pickZoomGuestName({
        speakers: ["Brian Lane", "Alexander"],
        hostNames: ["Brian Lane"],
        summary: "Alexander () joined late."
      })
    ).toBe("Alexander");
  });

  it("escapes regex characters in a speaker name", () => {
    expect(
      pickZoomGuestName({
        speakers: ["A.J. (mobile)"],
        hostNames: [],
        summary: "no aliases here"
      })
    ).toBe("A.J.");
  });

  it("returns null when everyone on the call is a host", () => {
    expect(
      pickZoomGuestName({ speakers: ["Brian Lane"], hostNames: ["Brian Lane"] })
    ).toBeNull();
  });

  it("returns null with no speakers", () => {
    expect(pickZoomGuestName({ speakers: [], hostNames: ["Brian Lane"] })).toBeNull();
  });

  it("treats every speaker as a guest when no host is known", () => {
    expect(pickZoomGuestName({ speakers: ["Alexander"], hostNames: [] })).toBe("Alexander");
  });
});

describe("extractFirstMinutesHeading", () => {
  it("takes the first heading above the transcript section", () => {
    const md = [
      "Some preamble.",
      "",
      "### Platform & Product Overview",
      "",
      "- We covered pricing.",
      "",
      "## Transcript",
      "",
      "### Not this one"
    ].join("\n");
    expect(extractFirstMinutesHeading(md)).toBe("Platform & Product Overview");
  });

  it("skips an empty heading and takes the next real one", () => {
    expect(extractFirstMinutesHeading("###   \n\n## Pricing review")).toBe("Pricing review");
  });

  it("strips a closing hash run from a heading", () => {
    expect(extractFirstMinutesHeading("## Pricing review ##")).toBe("Pricing review");
  });

  it("skips a heading that is nothing but hashes", () => {
    // "## #" matches the heading shape but strips to empty.
    expect(extractFirstMinutesHeading("## #\n\n### Pricing review")).toBe("Pricing review");
  });

  it("ignores headings deeper than h3 and returns null when there are none", () => {
    expect(extractFirstMinutesHeading("#### Too deep\n\nbody")).toBeNull();
    expect(extractFirstMinutesHeading("just prose")).toBeNull();
    expect(extractFirstMinutesHeading("")).toBeNull();
  });

  it("does not reach past the transcript marker", () => {
    expect(extractFirstMinutesHeading("## Transcript\n\n### Later heading")).toBeNull();
  });
});

describe("buildZoomGuestHeadingTitle", () => {
  it("builds the guest + heading shape", () => {
    expect(
      buildZoomGuestHeadingTitle({ guest: "Bobby", heading: "Platform & Product Overview" })
    ).toBe(`Bobby Platform & Product Overview ${ZOOM_GUEST_TITLE_SUFFIX}`);
  });

  it("uses whichever half it has", () => {
    expect(buildZoomGuestHeadingTitle({ guest: "Bobby", heading: null })).toBe(
      `Bobby ${ZOOM_GUEST_TITLE_SUFFIX}`
    );
    expect(buildZoomGuestHeadingTitle({ guest: null, heading: "Pricing review" })).toBe(
      `Pricing review ${ZOOM_GUEST_TITLE_SUFFIX}`
    );
  });

  it("returns null when it has neither, so the caller keeps Zoom's title", () => {
    expect(buildZoomGuestHeadingTitle({ guest: null, heading: null })).toBeNull();
    expect(buildZoomGuestHeadingTitle({ guest: "  ", heading: "" })).toBeNull();
  });

  it("clamps to 200 characters without cutting mid-word", () => {
    const title = buildZoomGuestHeadingTitle({
      guest: "Bobby",
      heading: "Overview ".repeat(40).trim()
    });
    expect(title).not.toBeNull();
    expect((title as string).length).toBeLessThanOrEqual(200);
    expect(title as string).not.toMatch(/\s$/);
  });
});

import { describe, expect, it } from "vitest";
import {
  OWNER_DIRECT_ACK_WINDOW_MS,
  ownerDirectAlreadyStoppedText,
  ownerDirectNudgeText
} from "../supabase/functions/_shared/ai_flows/owner_direct";

/**
 * Keep-for-owner reminder copy. The FINAL reminder used to close with
 * REPLY "1" TO STOP THESE REMINDERS after nothing was left to stop, which
 * is how Amy Laidlaw's second "1" on Robert Braid late-claimed Jason Ellis
 * (2026-09-02).
 */

const BODY =
  "HIGH DOLLAR LEAD ($1M+) KEPT FOR YOU, NOT OFFERED TO THE TEAM.\nRobert Braid.";

describe("ownerDirectNudgeText", () => {
  it("the 10-minute reminder still invites a 1 to stop the ladder", () => {
    const text = ownerDirectNudgeText(BODY, 10, false);
    expect(text).toContain("REMINDER (10 MINUTES): HIGH-VALUE LEAD IS STILL WAITING FOR YOU.");
    expect(text).toContain(BODY);
    expect(text).toContain(`REPLY "1" TO STOP THESE REMINDERS.`);
    expect(text).not.toContain("NO REPLY NEEDED");
  });

  it("the final reminder does not invite a 1: nothing is left to stop", () => {
    const text = ownerDirectNudgeText(BODY, 30, true);
    expect(text).toContain(
      "FINAL REMINDER (30 MINUTES): HIGH-VALUE LEAD IS STILL WAITING FOR YOU."
    );
    expect(text).toContain(BODY);
    expect(text).toContain("THIS WAS THE LAST REMINDER. NO REPLY NEEDED.");
    expect(text).not.toContain(`REPLY "1" TO STOP THESE REMINDERS.`);
  });

  it("contains no em dash", () => {
    expect(ownerDirectNudgeText(BODY, 10, false).includes("\u2014")).toBe(false);
    expect(ownerDirectNudgeText(BODY, 30, true).includes("\u2014")).toBe(false);
  });
});

describe("ownerDirectAlreadyStoppedText", () => {
  it("names the lead and asks nothing", () => {
    const t = ownerDirectAlreadyStoppedText("Robert Braid");
    expect(t).toBe("Got it, the reminders for Robert Braid already stopped. Nothing else needed.");
  });

  it("falls back when the name is blank", () => {
    expect(ownerDirectAlreadyStoppedText("  ")).toContain("this lead");
  });

  it("contains no em dash", () => {
    expect(ownerDirectAlreadyStoppedText("Robert Braid").includes("\u2014")).toBe(false);
  });
});

describe("OWNER_DIRECT_ACK_WINDOW_MS", () => {
  it("is one hour", () => {
    expect(OWNER_DIRECT_ACK_WINDOW_MS).toBe(60 * 60 * 1000);
  });
});

/**
 * Calendly reconnect copy: account labels, paused-trigger wording, banner
 * sentences, last-check formatting. Pure; no DB.
 */
import { describe, expect, it } from "vitest";
import {
  CALENDLY_CALENDAR_PAUSED_COPY,
  calendlyAccountLabel,
  calendlyCalendarPausedCopy,
  calendlyReauthBannerBody,
  calendlyReconnectPath,
  flowHasCalendarTrigger,
  formatCalendlyLastHealthy,
  isCalendlyTokenRejected
} from "@/lib/calendly/reauth-copy";

describe("calendlyReconnectPath", () => {
  it("deep-links into Reconnect on THAT connection row", () => {
    expect(calendlyReconnectPath("aaaaaaaa-1111-4111-8111-111111111111")).toBe(
      "/dashboard/integrations/calendly?reconnect=aaaaaaaa-1111-4111-8111-111111111111"
    );
  });
});

describe("calendlyAccountLabel", () => {
  it("prefers the name, then email, then a generic Calendly label", () => {
    expect(calendlyAccountLabel({ account_name: "James Lee", account_email: "james@kyp.test" })).toBe(
      "James Lee"
    );
    expect(calendlyAccountLabel({ account_name: "  ", account_email: "james@kyp.test" })).toBe(
      "james@kyp.test"
    );
    expect(calendlyAccountLabel({ account_name: null, account_email: null })).toBe("Calendly");
  });
});

describe("formatCalendlyLastHealthy", () => {
  it("formats a usable ISO and returns null for missing or garbage", () => {
    expect(formatCalendlyLastHealthy("2026-09-16T12:01:00.000Z", "en-US")).toMatch(/Sep/);
    expect(formatCalendlyLastHealthy("2026-09-16T12:01:00.000Z", "en-US")).toMatch(/2026/);
    expect(formatCalendlyLastHealthy(null)).toBeNull();
    expect(formatCalendlyLastHealthy("not-a-date")).toBeNull();
  });
});

describe("calendlyReauthBannerBody", () => {
  it("names the account, says follow-ups are paused, and includes the last check", () => {
    const withWhen = calendlyReauthBannerBody({
      accountLabel: "James Lee",
      lastHealthyLabel: "Sep 16, 2026, 5:01 AM"
    });
    expect(withWhen).toContain("James Lee's Calendly needs a reconnect");
    expect(withWhen).toContain("Calendar follow-ups and booking checks for that account are paused");
    expect(withWhen).toContain("last successful check: Sep 16, 2026, 5:01 AM");
    expect(withWhen.toLowerCase()).not.toContain("token");
    expect(withWhen.toLowerCase()).not.toContain("rejected");

    const noWhen = calendlyReauthBannerBody({
      accountLabel: "James Lee",
      lastHealthyLabel: null
    });
    expect(noWhen).toContain("are paused.");
    expect(noWhen).not.toContain("last successful check");
  });
});

describe("calendlyCalendarPausedCopy", () => {
  it("pauses the trigger only when every Calendly account needs reconnect", () => {
    expect(
      calendlyCalendarPausedCopy({ hasHealthyCalendly: false, hasCalendlyNeedingReauth: true })
    ).toBe(CALENDLY_CALENDAR_PAUSED_COPY);
    expect(
      calendlyCalendarPausedCopy({ hasHealthyCalendly: true, hasCalendlyNeedingReauth: true })
    ).toBeNull();
    expect(
      calendlyCalendarPausedCopy({ hasHealthyCalendly: false, hasCalendlyNeedingReauth: false })
    ).toBeNull();
  });
});

describe("isCalendlyTokenRejected", () => {
  it("matches only the permanent-reject error string", () => {
    expect(isCalendlyTokenRejected(new Error("calendly_token_rejected"))).toBe(true);
    expect(isCalendlyTokenRejected(new Error("calendar_not_connected"))).toBe(false);
    expect(isCalendlyTokenRejected("calendly_token_rejected")).toBe(false);
  });
});

describe("flowHasCalendarTrigger", () => {
  it("is true for a primary or extra calendar trigger, otherwise false", () => {
    expect(flowHasCalendarTrigger({ trigger: { channel: "calendar" } })).toBe(true);
    expect(
      flowHasCalendarTrigger({
        trigger: { channel: "sms" },
        triggers: [{ channel: "calendar" }]
      })
    ).toBe(true);
    expect(flowHasCalendarTrigger({ trigger: { channel: "sms" }, triggers: [] })).toBe(false);
    expect(flowHasCalendarTrigger({})).toBe(false);
  });
});

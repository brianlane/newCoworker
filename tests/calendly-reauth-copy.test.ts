/**
 * Calendly reconnect copy: account labels, paused-trigger wording, last-check
 * formatting. Pure; no DB.
 */
import { describe, expect, it } from "vitest";
import {
  calendlyAccountLabel,
  calendlyCalendarPausedCopy,
  calendlyReconnectPath,
  calendlyUiPauseCopy,
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
  const iso = "2026-09-16T12:01:00.000Z";

  it("formats a usable ISO and returns null for missing or garbage", () => {
    expect(formatCalendlyLastHealthy(iso, "en-US")).toMatch(/Sep/);
    expect(formatCalendlyLastHealthy(iso, "en-US")).toMatch(/2026/);
    expect(formatCalendlyLastHealthy(null)).toBeNull();
    expect(formatCalendlyLastHealthy("not-a-date")).toBeNull();
  });

  it("uses the business timezone when given one (KYP is America/Phoenix)", () => {
    expect(formatCalendlyLastHealthy(iso, "en-US", "America/Phoenix")).toBe(
      "Sep 16, 2026, 5:01 AM"
    );
    // Explicit UTC is the banner's SSR / first-paint snapshot.
    expect(formatCalendlyLastHealthy(iso, "en-US", "UTC")).toBe("Sep 16, 2026, 12:01 PM");
  });

  it("falls back to UTC on an invalid IANA zone; blank tz uses the runtime default", () => {
    expect(formatCalendlyLastHealthy(iso, "en-US", "Not/AZone")).toBe("Sep 16, 2026, 12:01 PM");
    expect(formatCalendlyLastHealthy(iso, "en-US", "  ")).toMatch(/Sep/);
  });
});

describe("calendlyCalendarPausedCopy", () => {
  it("pauses the trigger only when every Calendly account needs reconnect", () => {
    expect(
      calendlyCalendarPausedCopy({ hasHealthyCalendly: false, hasCalendlyNeedingReauth: true })
    ).toBe("Paused until Calendly is reconnected.");
    expect(
      calendlyCalendarPausedCopy({ hasHealthyCalendly: true, hasCalendlyNeedingReauth: true })
    ).toBeNull();
    expect(
      calendlyCalendarPausedCopy({ hasHealthyCalendly: false, hasCalendlyNeedingReauth: false })
    ).toBeNull();
  });
});

describe("calendlyUiPauseCopy", () => {
  const paused = "Paused until Calendly is reconnected.";

  it("keeps the Calendly pause when follow-ups use Calendly or nothing is connected", () => {
    expect(
      calendlyUiPauseCopy({ pausedCopy: paused, resolvedCalendarProvider: "calendly" })
    ).toBe(paused);
    expect(calendlyUiPauseCopy({ pausedCopy: paused, resolvedCalendarProvider: null })).toBe(
      paused
    );
    expect(calendlyUiPauseCopy({ pausedCopy: paused })).toBe(paused);
  });

  it("hides the Calendly pause when another calendar provider is the book", () => {
    expect(
      calendlyUiPauseCopy({ pausedCopy: paused, resolvedCalendarProvider: "google" })
    ).toBeNull();
    expect(
      calendlyUiPauseCopy({ pausedCopy: paused, resolvedCalendarProvider: "vagaro" })
    ).toBeNull();
    expect(calendlyUiPauseCopy({ pausedCopy: null, resolvedCalendarProvider: "calendly" })).toBeNull();
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

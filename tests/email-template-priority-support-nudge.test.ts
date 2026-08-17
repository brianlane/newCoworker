import { describe, it, expect } from "vitest";

import { buildPrioritySupportNudgeEmail } from "@/lib/email/templates/priority-support-nudge";

const BASE = {
  coverageEndsAt: "2026-09-09T00:00:00Z",
  daysLeft: 5,
  recipientEmail: "owner@test.com",
  siteUrl: "https://app.test",
  // Pinned so the rendered date does not depend on the machine's zone: this
  // instant is Sept 8 in MST and Sept 9 in UTC, which would otherwise pass on
  // CI and fail on a developer's laptop.
  timeZone: "UTC"
};

describe("buildPrioritySupportNudgeEmail", () => {
  it("names the end date, the days remaining, and the price", () => {
    const email = buildPrioritySupportNudgeEmail(BASE);
    expect(email.subject).toBe("Your priority support is ending soon");
    expect(email.text).toContain("September 9, 2026");
    expect(email.text).toContain("5 days");
    expect(email.text).toContain("$400/month");
  });

  it("uses the singular day form at exactly one day left", () => {
    const email = buildPrioritySupportNudgeEmail({ ...BASE, daysLeft: 1 });
    expect(email.text).toContain("1 day away");
    expect(email.text).not.toContain("1 days");
  });

  it("links to billing in both the text fallback and the HTML CTA", () => {
    const email = buildPrioritySupportNudgeEmail(BASE);
    expect(email.text).toContain("https://app.test/dashboard/billing");
    expect(email.html).toContain("https://app.test/dashboard/billing");
  });

  it("strips a trailing slash from the site url so links never double up", () => {
    const email = buildPrioritySupportNudgeEmail({ ...BASE, siteUrl: "https://app.test/" });
    expect(email.text).toContain("https://app.test/dashboard/billing");
    expect(email.text).not.toContain("app.test//dashboard");
  });

  it("renders Spanish when the locale asks for it", () => {
    const email = buildPrioritySupportNudgeEmail({ ...BASE, locale: "es" });
    expect(email.subject).toBe("Tu soporte prioritario está por terminar");
    expect(email.text).toContain("5 días");
    expect(email.text).toContain("septiembre");
  });

  it("uses the Spanish singular at one day left", () => {
    const email = buildPrioritySupportNudgeEmail({ ...BASE, daysLeft: 1, locale: "es" });
    expect(email.text).toContain("en 1 día.");
  });

  it("defaults to English when no locale is given", () => {
    expect(buildPrioritySupportNudgeEmail(BASE).subject).toBe(
      "Your priority support is ending soon"
    );
  });

  it("formats the date in the tenant's timezone when one is given", () => {
    // Midnight UTC is still the previous evening in Los Angeles, so the
    // rendered date must shift back a day.
    const email = buildPrioritySupportNudgeEmail({
      ...BASE,
      timeZone: "America/Los_Angeles"
    });
    expect(email.text).toContain("September 8, 2026");
  });

  it("never contains an em dash", () => {
    for (const locale of ["en", "es"] as const) {
      const email = buildPrioritySupportNudgeEmail({ ...BASE, locale });
      expect(email.subject).not.toContain("—");
      expect(email.text).not.toContain("—");
      expect(email.html).not.toContain("—");
    }
  });
});

import { describe, expect, it } from "vitest";
import {
  buildMonthlyIntroNudgeEmail,
  monthlyIntroNudgeAmounts,
  ratePerMonthDisplay
} from "@/lib/email/templates/monthly-intro-nudge";

const mailCtx = {
  recipientEmail: "owner@example.com",
  siteUrl: "https://www.newcoworker.com/",
  periodEndAt: "2026-08-12T18:00:00.000Z",
  timeZone: "UTC"
};

describe("ratePerMonthDisplay / monthlyIntroNudgeAmounts", () => {
  it("omits .00 for whole-dollar rates and keeps cents for starter", () => {
    expect(ratePerMonthDisplay(19500)).toBe("$195/mo");
    expect(ratePerMonthDisplay(1599)).toBe("$15.99/mo");
    const standard = monthlyIntroNudgeAmounts("standard");
    expect(standard.introRate).toBe("$195/mo");
    expect(standard.renewalRate).toBe("$279/mo");
    expect(standard.biennialRate).toBe("$99/mo");
    expect(standard.biennialTotal).toBe("$2,376");
    expect(standard.annualRate).toBe("$109/mo");
    expect(standard.annualTotal).toBe("$1,308");
    const starter = monthlyIntroNudgeAmounts("starter");
    expect(starter.introRate).toBe("$15.99/mo");
    expect(starter.renewalRate).toBe("$26.99/mo");
  });
});

describe("buildMonthlyIntroNudgeEmail (Shape B)", () => {
  it("renders the soft-inform English copy with both contract options", () => {
    const { subject, text, html } = buildMonthlyIntroNudgeEmail({
      tier: "standard",
      ...mailCtx
    });
    expect(subject).toBe("A note about your next New Coworker invoice");
    expect(text).toMatch(/clear notice before your next invoice/i);
    expect(text).toContain("$195/mo");
    expect(text).toContain("August 12, 2026");
    expect(text).toContain("$279/mo");
    expect(text).toContain("24-month: $99/mo ($2,376 billed today)");
    expect(text).toContain("12-month: $109/mo ($1,308 billed today)");
    expect(text).toMatch(/No action is required/i);
    expect(text).toContain("Open Billing: https://www.newcoworker.com/dashboard/billing");
    expect(html).toContain("Review billing options");
    expect(html).toContain("/dashboard/billing");
    expect(html).toContain("logo.png");
    expect(text).not.toContain("\u2014");
    expect(html).not.toContain("\u2014");
  });

  it("localizes the Spanish variant", () => {
    const { subject, text, html } = buildMonthlyIntroNudgeEmail({
      tier: "starter",
      ...mailCtx,
      locale: "es"
    });
    expect(subject).toBe("Una nota sobre tu próxima factura de New Coworker");
    expect(text).toContain("$15.99/mo");
    expect(text).toContain("$26.99/mo");
    expect(text).toMatch(/No hace falta hacer nada/i);
    expect(html).toContain("Revisar opciones de facturación");
    expect(text).toContain("agosto");
  });
});

import { describe, expect, it } from "vitest";
import {
  buildContractTermNudgeEmail,
  contractTermNudgeAmounts
} from "@/lib/email/templates/contract-term-nudge";

const mailCtx = {
  recipientEmail: "owner@example.com",
  siteUrl: "https://www.newcoworker.com/",
  periodEndAt: "2026-08-12T18:00:00.000Z",
  timeZone: "UTC"
};

describe("contractTermNudgeAmounts", () => {
  it("formats annual and biennial contract rates", () => {
    const annual = contractTermNudgeAmounts("standard", "annual");
    expect(annual.term).toBe("12-month");
    expect(annual.contractRate).toBe("$109/mo");
    expect(annual.contractTotal).toBe("$1,308");
    expect(annual.renewalRate).toBe("$279/mo");

    const biennial = contractTermNudgeAmounts("starter", "biennial");
    expect(biennial.term).toBe("24-month");
    expect(biennial.contractRate).toBe("$9.99/mo");
    expect(biennial.renewalRate).toBe("$26.99/mo");
  });
});

describe("buildContractTermNudgeEmail (Shape B)", () => {
  it("renders English copy for an annual plan", () => {
    const { subject, text, html } = buildContractTermNudgeEmail({
      tier: "standard",
      billingPeriod: "annual",
      ...mailCtx
    });
    expect(subject).toBe("A note about your New Coworker contract");
    expect(text).toMatch(/before your contract term ends/i);
    expect(text).toContain("12-month");
    expect(text).toContain("$109/mo");
    expect(text).toContain("August 12, 2026");
    expect(text).toContain("$279/mo");
    expect(text).toContain("$1,308");
    expect(text).toMatch(/No action is required to roll to month-to-month/i);
    expect(text).toContain("Open Billing: https://www.newcoworker.com/dashboard/billing");
    expect(html).toContain("Review billing options");
    expect(text).not.toContain("\u2014");
    expect(html).not.toContain("\u2014");
  });

  it("localizes the Spanish variant", () => {
    const { subject, text, html } = buildContractTermNudgeEmail({
      tier: "starter",
      billingPeriod: "biennial",
      ...mailCtx,
      locale: "es"
    });
    expect(subject).toBe("Una nota sobre tu contrato de New Coworker");
    expect(text).toContain("24 meses");
    expect(text).toContain("$9.99/mo");
    expect(text).toMatch(/No hace falta hacer nada/i);
    expect(html).toContain("Revisar opciones de facturación");
  });

  it("uses the Spanish annual term label", () => {
    const { text } = buildContractTermNudgeEmail({
      tier: "standard",
      billingPeriod: "annual",
      ...mailCtx,
      locale: "es"
    });
    expect(text).toContain("12 meses");
  });
});

import { describe, expect, it } from "vitest";
import {
  buildContractTermNudgeEmail,
  contractTermNudgeAmounts
} from "@/lib/email/templates/contract-term-nudge";
import { getRenewalRateDisplay } from "@/lib/pricing";

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
    expect(annual.renewalRate).toBe("$209/mo");

    const biennial = contractTermNudgeAmounts("starter", "biennial");
    expect(biennial.term).toBe("24-month");
    expect(biennial.contractRate).toBe("$9.99/mo");
    expect(biennial.renewalRate).toBe("$19.99/mo");
  });

  /**
   * The email quotes what the tenant will actually be charged after the term
   * ends. contract_auto_renew = false means "roll to month-to-month AT THE
   * RENEWAL PRICE" (src/lib/db/subscriptions.ts), and /api/billing/auto-renew
   * OFF re-creates the commitment schedule whose phase 2 is
   * resolveRenewalPriceId(tier, billingPeriod): the TERM's renewal price, not
   * the monthly plan's.
   *
   * Asserted against the module the dashboard renders from rather than a
   * literal, because a literal is exactly what let the two drift: the email
   * said $279/mo while PlanCard said $189/mo for the same biennial tenant.
   */
  it("quotes the same rollover rate the billing page shows", () => {
    // The two surfaces format differently ($209/mo vs $209.00/mo), so compare
    // the amount rather than the string.
    const amount = (s: string): string => s.replace(/[^0-9.]/g, "").replace(/\.00$/, "");
    for (const tier of ["starter", "standard"] as const) {
      for (const period of ["annual", "biennial"] as const) {
        expect(amount(contractTermNudgeAmounts(tier, period).renewalRate)).toBe(
          amount(getRenewalRateDisplay(tier, period))
        );
      }
    }
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
    // The annual plan rolls to ITS renewal price, not the monthly plan's.
    expect(text).toContain("$209/mo");
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

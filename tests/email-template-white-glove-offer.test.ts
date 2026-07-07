import { describe, expect, it } from "vitest";
import { buildWhiteGloveOfferEmail } from "@/lib/email/templates/white-glove-offer";

const BASE = {
  offerName: "White-glove migration + 3 AiFlows",
  description: "Full migration from your old provider plus three custom AiFlows.",
  amountCents: 125_000,
  payUrl: "https://www.newcoworker.com/offer/tok-abc",
  recipientEmail: "prospect@example.com",
  siteUrl: "https://www.newcoworker.com/"
};

describe("buildWhiteGloveOfferEmail", () => {
  it("carries the deal name, price, description, and the durable pay link", () => {
    const { subject, text, html } = buildWhiteGloveOfferEmail(BASE);
    expect(subject).toBe("Your NewCoworker offer: White-glove migration + 3 AiFlows");
    expect(text).toContain("$1,250.00");
    expect(text).toContain("one-time");
    expect(text).toContain(BASE.description);
    expect(text).toContain(BASE.payUrl);
    expect(html).toContain(BASE.payUrl);
    expect(html).toContain("Pay $1,250.00 securely");
  });

  it("omits the description line when the admin left it blank", () => {
    const { text } = buildWhiteGloveOfferEmail({ ...BASE, description: "   " });
    expect(text).not.toContain("Full migration");
    expect(text).toContain(BASE.payUrl);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  computeOnboardingNudgeItems,
  nudgeAppUrl,
  type OnboardingNudgeInputs
} from "@/lib/admin/onboarding-nudge";

const APP_URL = "https://www.newcoworker.com";
const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;

/** A fully onboarded tenant: every check satisfied, so no items. */
function complete(overrides: Partial<OnboardingNudgeInputs> = {}): OnboardingNudgeInputs {
  return {
    subscription: { status: "active" },
    websiteMd: "# Acme\nWe sell widgets.",
    didE164: "+16025551234",
    offers: [],
    deals: [],
    ...overrides
  };
}

function labels(inputs: OnboardingNudgeInputs): string[] {
  return computeOnboardingNudgeItems(inputs).map((i) => i.label);
}

describe("computeOnboardingNudgeItems", () => {
  beforeAll(() => {
    process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  });
  afterAll(() => {
    if (originalAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
  });

  it("returns nothing when onboarding is complete", () => {
    expect(computeOnboardingNudgeItems(complete())).toEqual([]);
  });

  it("asks for checkout when there is no subscription at all", () => {
    expect(computeOnboardingNudgeItems(complete({ subscription: null }))).toEqual([
      {
        label: "Finish checkout to bring your coworker online",
        href: `${APP_URL}/pricing`
      }
    ]);
  });

  it("asks for checkout while the subscription is still pending", () => {
    expect(labels(complete({ subscription: { status: "pending" } }))).toEqual([
      "Finish checkout to bring your coworker online"
    ]);
  });

  it("does not ask for checkout on any other status", () => {
    for (const status of ["active", "past_due", "canceled"] as const) {
      expect(labels(complete({ subscription: { status } }))).toEqual([]);
    }
  });

  it("asks for the website when the knowledge is missing or only whitespace", () => {
    for (const websiteMd of [null, undefined, "", "   \n  "]) {
      expect(computeOnboardingNudgeItems(complete({ websiteMd }))).toEqual([
        {
          label: "Add your website so your coworker can answer customer questions",
          href: `${APP_URL}/dashboard/memory`
        }
      ]);
    }
  });

  it("flags a missing phone number with no link, since we handle it by hand", () => {
    for (const didE164 of [null, undefined, ""]) {
      const items = computeOnboardingNudgeItems(complete({ didE164 }));
      expect(items).toHaveLength(1);
      expect(items[0].label).toContain("doesn't have a phone number yet");
      expect(items[0].href).toBeUndefined();
    }
  });

  it("asks for payment on each OPEN white-glove offer, naming it", () => {
    const items = computeOnboardingNudgeItems(
      complete({
        offers: [
          { name: "Buildout", status: "open", pay_token: "tok_a" },
          { name: "Paid one", status: "paid", pay_token: "tok_b" },
          { name: "Revoked one", status: "revoked", pay_token: "tok_c" },
          { name: "Second open", status: "open", pay_token: "tok_d" }
        ]
      })
    );
    expect(items).toEqual([
      { label: 'Complete payment for "Buildout"', href: `${APP_URL}/offer/tok_a` },
      { label: 'Complete payment for "Second open"', href: `${APP_URL}/offer/tok_d` }
    ]);
  });

  it("asks for payment on each OPEN enterprise deal only", () => {
    const items = computeOnboardingNudgeItems(
      complete({
        deals: [
          { status: "open", pay_token: "deal_a" },
          { status: "active", pay_token: "deal_b" }
        ]
      })
    );
    expect(items).toEqual([
      {
        label: "Complete your enterprise plan payment",
        href: `${APP_URL}/enterprise-offer/deal_a`
      }
    ]);
  });

  it("lists a brand-new tenant's items in checkout, website, phone, payment order", () => {
    expect(
      labels({
        subscription: null,
        websiteMd: null,
        didE164: null,
        offers: [{ name: "Setup", status: "open", pay_token: "tok" }],
        deals: []
      })
    ).toEqual([
      "Finish checkout to bring your coworker online",
      "Add your website so your coworker can answer customer questions",
      "Your coworker doesn't have a phone number yet. Reply to this email and we'll sort it out.",
      'Complete payment for "Setup"'
    ]);
  });

  it("points the dashboard links and the pay links at the same host", () => {
    const items = computeOnboardingNudgeItems({
      subscription: null,
      websiteMd: null,
      didE164: "+16025551234",
      offers: [{ name: "Setup", status: "open", pay_token: "tok" }],
      deals: [{ status: "open", pay_token: "deal" }]
    });
    const hrefs = items.map((i) => i.href).filter((h): h is string => Boolean(h));
    expect(hrefs).toHaveLength(4);
    for (const href of hrefs) {
      expect(href.startsWith(`${APP_URL}/`)).toBe(true);
    }
  });

  it("never emits an em dash: this copy reaches the customer's inbox", () => {
    const items = computeOnboardingNudgeItems({
      subscription: null,
      websiteMd: null,
      didE164: null,
      offers: [{ name: "Setup", status: "open", pay_token: "tok" }],
      deals: [{ status: "open", pay_token: "deal" }]
    });
    for (const item of items) {
      expect(item.label).not.toContain("\u2014");
    }
  });
});

describe("nudgeAppUrl", () => {
  afterAll(() => {
    if (originalAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
  });

  it("falls back to localhost when the app URL is unset", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(nudgeAppUrl()).toBe("http://localhost:3000");
  });

  it("strips a trailing slash so links never double up", () => {
    process.env.NEXT_PUBLIC_APP_URL = `${APP_URL}/`;
    expect(nudgeAppUrl()).toBe(APP_URL);
  });
});

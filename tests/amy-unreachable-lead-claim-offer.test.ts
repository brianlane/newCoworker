import { describe, expect, it } from "vitest";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { PLANS, patchFlow as installGuard } from "../scripts/oneshot/amy-unreachable-lead-team-alert";
import {
  claimOffer,
  offerTemplate,
  patchFlow,
  sameShape
} from "../scripts/oneshot/amy-unreachable-lead-claim-offer";
import type { Definition } from "../scripts/oneshot/amy-under-500k-ai-owned";

/**
 * The no-phone guard used to be an ALERT on purpose: no deadline, nothing
 * waiting. Then a teammate replied "1" to one 57 seconds after it landed,
 * because every other team text on this account ends in "Reply 1 to claim".
 * Her "1" resolved against an unrelated older offer and the lead stayed
 * unowned. Both should work, so the alert becomes a real claim offer.
 */

const DECLARED: Record<string, string[]> = {
  // price_gate is declared here because the offer's own `when` reads it; the
  // validator rejects a condition on a var no earlier step produces, which is
  // what proves the live flows really do extract it.
  "Clever Lead - Accept": [
    "lead_name",
    "lead_phone",
    "lead_email",
    "lead_address",
    "price",
    "lead_url",
    "price_gate"
  ],
  "ReferralExchange Lead": ["lead_name", "lead_phone", "lead_email", "location", "price", "lead_type"],
  "Realtor.com Lead": [
    "lead_name",
    "lead_phone",
    "lead_email",
    "lead_address",
    "lead_price_details",
    "lead_url",
    "lead_type",
    "price_gate"
  ],
  "New Lead Intake": [
    "lead_name",
    "lead_phone",
    "lead_email",
    "lead_address",
    "price",
    "lead_details",
    "lead_type"
  ]
};

/** A definition with the guard already installed, as the live flows have it. */
const withGuard = (planIndex: number): Definition => {
  const plan = PLANS[planIndex];
  const def = {
    version: 1,
    trigger: { channel: "sms", conditions: [{ type: "contains", value: "lead" }] },
    steps: [
      {
        id: plan.after,
        type: "extract_text",
        fields: DECLARED[plan.flow].map((name) => ({ name, description: `the lead's ${name}` }))
      },
      { id: "later", type: "notify_owner", message: "done" }
    ]
  } as unknown as Definition;
  installGuard(def, plan);
  return def;
};

const guardArm = (def: Definition, prefix: string) =>
  (
    def.steps!.find((s) => (s as { id: string }).id === `${prefix}_no_phone_guard`) as unknown as {
      else: Array<Record<string, unknown>>;
    }
  ).else;

describe("the claim offer", () => {
  it("is a tag-narrowed whole-roster broadcast", () => {
    // broadcastAll alone would offer a seller lead to the buyer-only
    // teammate. The tag filter is what makes this conversion lossless.
    const offer = claimOffer(PLANS[0]);
    expect(offer.broadcastAll).toBe(true);
    expect(offer.teamTagTemplate).toBe("seller");
    expect(offer.type).toBe("route_to_team");
  });

  it("carries the reply-1 affordance, which is the entire point", () => {
    for (const plan of PLANS) {
      const t = offerTemplate(plan);
      expect(t, plan.flow).toContain("Reply 1 to claim");
      expect(t, plan.flow).toContain("{{offer.deadline}}");
    }
  });

  it("still leads with the fact that there is no phone", () => {
    // It changes what the teammate does next: open the referral, do not dial.
    for (const plan of PLANS) {
      expect(offerTemplate(plan), plan.flow).toContain("NO phone number");
    }
  });

  it("carries no em dashes in any flow's copy", () => {
    for (const plan of PLANS) expect(offerTemplate(plan)).not.toContain("—");
  });

  it("keeps every plan's lead-type tag exactly as the alert had it", () => {
    for (const plan of PLANS) {
      expect((claimOffer(plan) as { teamTagTemplate: string }).teamTagTemplate).toBe(plan.teamTag);
    }
  });
});

describe("patchFlow", () => {
  it("replaces the alert in place, leaving the guard's condition untouched", () => {
    const def = withGuard(0);
    const before = JSON.parse(
      JSON.stringify(
        (def.steps!.find((s) => (s as { id: string }).id === "clever_no_phone_guard") as never as {
          branches: unknown;
        }).branches
      )
    );
    const res = patchFlow(def, PLANS[0]);
    expect(res.changed).toBe(true);
    const arm = guardArm(def, "clever");
    expect(arm).toHaveLength(1);
    expect(arm[0].id).toBe("clever_no_phone_offer");
    // The "do we have a phone" test is unchanged; only the consequence moved.
    const after = (
      def.steps!.find((s) => (s as { id: string }).id === "clever_no_phone_guard") as never as {
        branches: unknown;
      }
    ).branches;
    expect(after).toEqual(before);
  });

  it("is idempotent", () => {
    const def = withGuard(0);
    patchFlow(def, PLANS[0]);
    const once = JSON.parse(JSON.stringify(def));
    const second = patchFlow(def, PLANS[0]);
    expect(second.changed).toBe(false);
    expect(def).toEqual(once);
  });

  it("converges an already-converted offer whose copy went stale", () => {
    const def = withGuard(0);
    patchFlow(def, PLANS[0]);
    guardArm(def, "clever")[0].offerTemplate = "stale wording";
    const res = patchFlow(def, PLANS[0]);
    expect(res.changed).toBe(true);
    expect(guardArm(def, "clever")[0].offerTemplate).toBe(offerTemplate(PLANS[0]));
  });

  it("refuses to run before the guard exists", () => {
    const def = {
      version: 1,
      trigger: { channel: "sms", conditions: [{ type: "contains", value: "lead" }] },
      steps: [{ id: "later", type: "notify_owner", message: "done" }]
    } as unknown as Definition;
    expect(() => patchFlow(def, PLANS[0])).toThrow(/run amy-unreachable-lead-team-alert/);
  });

  it("throws when the guard's else arm holds neither the alert nor the offer", () => {
    const def = withGuard(0);
    guardArm(def, "clever")[0].id = "something_else";
    expect(() => patchFlow(def, PLANS[0])).toThrow(/neither the alert nor the offer/);
  });

  it("produces a definition the validator accepts, for every flow", () => {
    for (let i = 0; i < PLANS.length; i++) {
      const def = withGuard(i);
      patchFlow(def, PLANS[i]);
      expect(() => parseAiFlowDefinition(def), PLANS[i].flow).not.toThrow();
    }
  });
});

/**
 * Postgres `jsonb` does not preserve key order, so a definition read back from
 * the database never matches a freshly built object under JSON.stringify. The
 * first live run of this script reported "offer refreshed" on every flow
 * because of exactly that. Only the round trip exposes it, so this pins the
 * comparison rather than the symptom.
 */
describe("sameShape", () => {
  it("ignores key order at every depth", () => {
    expect(sameShape({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })).toBe(true);
  });

  it("still sees real differences", () => {
    expect(sameShape({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameShape({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(sameShape({ a: 1, b: 2 }, { a: 1, c: 2 })).toBe(false);
  });

  it("compares arrays by position, not as sets", () => {
    expect(sameShape([1, 2], [1, 2])).toBe(true);
    expect(sameShape([1, 2], [2, 1])).toBe(false);
    expect(sameShape([1], [1, 2])).toBe(false);
  });

  it("handles primitives, null, and mismatched types", () => {
    expect(sameShape(null, null)).toBe(true);
    expect(sameShape("x", "x")).toBe(true);
    expect(sameShape(null, {})).toBe(false);
    expect(sameShape({}, [])).toBe(false);
    expect(sameShape(1, "1")).toBe(false);
  });

  it("treats a live-shaped offer as unchanged when only key order differs", () => {
    const want = claimOffer(PLANS[0]);
    const roundTripped = Object.fromEntries(Object.entries(want).reverse());
    expect(sameShape(roundTripped, want)).toBe(true);
  });
});

/**
 * A parked offer is not a fire-and-forget alert: two live claim windows on one
 * lead means two deadlines, two races, and teammates getting contradictory
 * texts. Clever's `route` and Realtor.com's `s4`/`s4_buyer` gate only on
 * price_gate, so a $500K+ no-phone lead would have been offered twice.
 * ReferralExchange and New Lead Intake route on vars that read "none" without
 * a phone, so their trunk routes already skip. (Bugbot, PR #1399.)
 */
describe("no double claim windows", () => {
  const byFlow = Object.fromEntries(PLANS.map((p) => [p.flow, claimOffer(p)]));

  it("gates the offer on the exact complement of the trunk route", () => {
    // route fires on price_gate != "ai"; this fires on price_gate == "ai".
    // Mutually exclusive by construction, not by luck.
    for (const flow of ["Clever Lead - Accept", "Realtor.com Lead"]) {
      expect(byFlow[flow].when, flow).toEqual({ var: "price_gate", equals: "ai" });
    }
  });

  it("leaves the reachability-gated flows ungated", () => {
    // Their trunk routes already skip without a phone, so a gate here would
    // suppress the only offer these leads get.
    for (const flow of ["ReferralExchange Lead", "New Lead Intake"]) {
      expect(byFlow[flow], flow).not.toHaveProperty("when");
    }
  });

  it("covers the AI-owned lead, which is the gap this guard exists for", () => {
    // The lead that started all of this was $425K: price_gate "ai", so the
    // trunk route was correctly skipped and nothing else offered it.
    expect(byFlow["Clever Lead - Accept"].when).toEqual({ var: "price_gate", equals: "ai" });
  });
});

import { describe, expect, it } from "vitest";
import { parseAiFlowDefinition, validateDefinitionSemantics } from "@/lib/ai-flows/schema";
import {
  MOVE_PLAN,
  OWNER_LINE,
  moveEmailsAfterRoute,
  withOwnerLine
} from "../scripts/oneshot/amy-owner-in-lead-emails";

/**
 * Amy's lead emails to herself now say who owns the lead. Five of them sat
 * BEFORE their flow's route_to_team step, so the claimer was not knowable from
 * where they stood: the reorder is required, not cosmetic.
 */

const cleverish = () => ({
  version: 1,
  trigger: { channel: "sms" as const, conditions: [{ type: "contains" as const, value: "Clever" }] },
  steps: [
    { id: "read", type: "extract_text", fields: [{ name: "lead_name" }, { name: "lead_phone" }] },
    { id: "qt_email", type: "send_email", to: "amy@amylaidlaw.com", subject: "QT", body: "New lead {{vars.lead_name}}" },
    { id: "call", type: "place_ai_call", toVar: "lead_phone", personaTemplate: "Hi", notifyOwner: true },
    {
      id: "route",
      type: "route_to_team",
      offerTemplate: "New lead, reply 1",
      ownerFallbackTemplate: "Nobody claimed it"
    },
    { id: "lead_reached", type: "goal", label: "Lead reached", events: [{ kind: "replied" }] },
    { id: "notify", type: "notify_owner", message: "done" }
  ]
});

describe("withOwnerLine", () => {
  it("appends the owner line and is idempotent", () => {
    const once = withOwnerLine("New lead Joe");
    expect(once).toBe(`New lead Joe\n${OWNER_LINE}`);
    expect(withOwnerLine(once)).toBe(once);
  });

  /**
   * `claimed_agent` reads "none" when nobody took the lead, which is the
   * honest answer and the reason these emails are NOT gated on a claim. An
   * unclaimed lead is the one Amy most needs to see.
   */
  it("names the claimer var, which doubles as the owner after a claim", () => {
    expect(OWNER_LINE).toContain("{{vars.claimed_agent}}");
  });
});

describe("moveEmailsAfterRoute", () => {
  /**
   * AFTER THE GOAL, not merely after the route, and this is the whole ballgame
   * on Clever. Its ladder parks in ai_call_1 BEFORE the route, and the
   * lead_reached goal sits after it. A lead who replies or books DURING that
   * call jumps straight to the goal and skips everything in between, so an
   * email anchored on the route would never send for exactly the leads who
   * engaged: the best ones, silently.
   */
  it("moves the email after the GOAL when the flow has one", () => {
    const def = cleverish();
    const res = moveEmailsAfterRoute("Clever Lead - Accept", def);
    expect(res.changed).toBe(true);
    const ids = def.steps.map((s) => s.id);
    expect(ids.indexOf("qt_email")).toBeGreaterThan(ids.indexOf("lead_reached"));
    expect(res.movedAfter).toBe("lead_reached");
    const email = def.steps.find((s) => s.id === "qt_email") as { body: string };
    expect(email.body).toContain(OWNER_LINE);
  });

  it("is a no-op on a second run", () => {
    const def = cleverish();
    moveEmailsAfterRoute("Clever Lead - Accept", def);
    expect(moveEmailsAfterRoute("Clever Lead - Accept", def).changed).toBe(false);
  });

  it("leaves the definition valid, with the claimer var now in scope", () => {
    const def = cleverish();
    moveEmailsAfterRoute("Clever Lead - Accept", def);
    const parsed = parseAiFlowDefinition(def);
    expect(validateDefinitionSemantics(parsed)).toEqual([]);
  });

  /**
   * ReferralExchange has THREE route steps gated by lead type and only one
   * fires. After ALL of them is the only position from which the claim is
   * known whichever arm ran.
   */
  /**
   * A goal step is a jump TARGET, so steps after it run on BOTH paths: the
   * normal one where the route resolved the claim, and the jump where the
   * route never ran and the owner is legitimately blank. Hence the label
   * explains its own blank, since send_email renders with no collapseEmpty and
   * an unset var would otherwise leave a dangling "Lead owner:".
   */
  it("explains what a blank owner means", () => {
    expect(OWNER_LINE).toContain("blank if nobody has claimed it yet");
  });

  it("falls back to the last route when the flow has no goal", () => {
    const def = {
      steps: [
        { id: "browse", type: "extract_text", fields: [{ name: "lead_name" }] },
        { id: "email_buyer", type: "send_email", to: "amy@amylaidlaw.com", subject: "s", body: "b" },
        { id: "email_seller", type: "send_email", to: "amy@amylaidlaw.com", subject: "s", body: "b" },
        { id: "email_both", type: "send_email", to: "amy@amylaidlaw.com", subject: "s", body: "b" },
        { id: "route_buyer", type: "route_to_team", offerTemplate: "o", ownerFallbackTemplate: "f" },
        { id: "route_seller", type: "route_to_team", offerTemplate: "o", ownerFallbackTemplate: "f" },
        { id: "route_both", type: "route_to_team", offerTemplate: "o", ownerFallbackTemplate: "f" }
      ]
    };
    const res = moveEmailsAfterRoute("ReferralExchange Lead", { steps: def.steps });
    expect(res.movedAfter).toBe("route_both");
    // All three land after the last route, in their original order.
    expect(def.steps.map((s) => s.id)).toEqual([
      "browse",
      "route_buyer",
      "route_seller",
      "route_both",
      "email_buyer",
      "email_seller",
      "email_both"
    ]);
  });

  // A moved step id means the live flow changed shape, and shuffling a
  // definition we no longer recognize is the wrong response to that.
  it("aborts rather than guessing when a step is gone or is not an email", () => {
    const gone = cleverish();
    gone.steps = gone.steps.filter((s) => s.id !== "qt_email");
    expect(() => moveEmailsAfterRoute("Clever Lead - Accept", gone)).toThrow(/is missing or not top level/);

    const wrongType = cleverish();
    (wrongType.steps[1] as Record<string, unknown>).type = "notify_owner";
    expect(() => moveEmailsAfterRoute("Clever Lead - Accept", wrongType)).toThrow(/not an email/);

    const noRoute = cleverish();
    noRoute.steps = noRoute.steps.filter((s) => s.type !== "route_to_team");
    expect(() => moveEmailsAfterRoute("Clever Lead - Accept", noRoute)).toThrow(/no top-level route_to_team/);

    const noBody = cleverish();
    delete (noBody.steps[1] as Record<string, unknown>).body;
    expect(() => moveEmailsAfterRoute("Clever Lead - Accept", noBody)).toThrow(/has no body/);
  });

  it("refuses a flow it has no plan for", () => {
    expect(() => moveEmailsAfterRoute("HomeLight Referral", { steps: [] })).toThrow(/no move plan/);
  });

  /**
   * HomeLight is deliberately absent: its qt_email already sits after the
   * route and already names the claimer. It is the model these four are being
   * brought in line with, not a flow that needs changing.
   */
  it("covers exactly the flows whose emails lacked the owner", () => {
    expect(Object.keys(MOVE_PLAN).sort()).toEqual([
      "Clever Lead - Accept",
      "Realtor.com Lead",
      "ReferralExchange Lead"
    ]);
    expect(MOVE_PLAN["ReferralExchange Lead"]).toHaveLength(3);
  });
});

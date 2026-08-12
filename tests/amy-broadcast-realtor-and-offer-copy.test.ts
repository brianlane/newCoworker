import { describe, expect, it } from "vitest";
import { parseAiFlowDefinition, validateDefinitionSemantics } from "@/lib/ai-flows/schema";
import {
  BROADCAST_NAMES,
  CASCADE_CLAUSE,
  FIRST_TO_CLAIM,
  patchCleverCopy,
  patchRealtorBroadcast,
  withFirstToClaim,
  withoutCascadeClause
} from "../scripts/oneshot/amy-broadcast-realtor-and-offer-copy";

/**
 * Amy, pointing at a Clever offer: "why was this lead not broadcasted then?"
 * It WAS. The run's outcome line says "offered simultaneously to Gabrielle
 * Mota, Amy Laidlaw, Dave Lane, first to claim". The offer COPY still said
 * "or it goes to the next agent", wording left behind when that step became a
 * broadcast on Aug 8, and the same message contradicts itself three lines
 * later with "First to reply 1 gets it".
 */

describe("copy helpers", () => {
  it("strips only the cascade clause, keeping the deadline sentence", () => {
    const before =
      "Reply 1 to claim or 2 to pass by {{offer.deadline}}, or it goes to the next agent.\nNext line.";
    expect(withoutCascadeClause(before)).toBe(
      "Reply 1 to claim or 2 to pass by {{offer.deadline}}.\nNext line."
    );
  });

  /**
   * The deadline still matters on a broadcast: it is when the whole offer
   * lapses to the owner. Only the "next agent" half is untrue.
   */
  it("keeps the deadline placeholder", () => {
    expect(withoutCascadeClause(`x${CASCADE_CLAUSE}.`)).toContain("x.");
  });

  it("is idempotent and leaves rotation copy alone", () => {
    const rotation = "Reply 1 to claim by {{offer.deadline}}.";
    expect(withoutCascadeClause(rotation)).toBe(rotation);
    const once = withoutCascadeClause(`a${CASCADE_CLAUSE}`);
    expect(withoutCascadeClause(once)).toBe(once);
  });

  it("adds the first-to-claim line once", () => {
    const out = withFirstToClaim("offer");
    expect(out).toBe(`offer\n${FIRST_TO_CLAIM}`);
    expect(withFirstToClaim(out)).toBe(out);
  });
});

describe("Clever: broadcast already, copy wrong", () => {
  const def = (): { steps: Array<Record<string, unknown>> } => ({
    steps: [
      { id: "x", type: "extract_text", fields: [{ name: "lead_name" }] },
      {
        id: "route",
        type: "route_to_team",
        agentNames: [...BROADCAST_NAMES],
        offerTemplate:
          "New Clever lead {{vars.lead_name}}\nReply 1 to claim or 2 to pass by {{offer.deadline}}, or it goes to the next agent.\nFirst to reply 1 gets it.",
        ownerFallbackTemplate: "Nobody claimed it"
      }
    ]
  });

  it("removes the cascade clause and leaves the routing alone", () => {
    const d = def();
    expect(patchCleverCopy(d).touched).toEqual(["route.offerTemplate"]);
    const step = d.steps[1] as { offerTemplate: string; agentNames: string[] };
    expect(step.offerTemplate).not.toContain("next agent");
    expect(step.offerTemplate).toContain(FIRST_TO_CLAIM);
    expect(step.agentNames).toEqual(BROADCAST_NAMES);
  });

  it("is a no-op on a second run", () => {
    const d = def();
    patchCleverCopy(d);
    expect(patchCleverCopy(d).changed).toBe(false);
  });

  /**
   * If somebody converts that step back to a rotation, "next agent" becomes
   * TRUE again and removing it would be the wrong edit. Abort rather than
   * reword a step whose behavior has changed underneath us.
   */
  it("refuses to reword a step that is no longer a broadcast", () => {
    const d = def();
    delete (d.steps[1] as Record<string, unknown>).agentNames;
    expect(() => patchCleverCopy(d)).toThrow(/no longer a broadcast/);
  });
});

describe("Realtor.com: rotation with no lead-type gate", () => {
  const def = (): { version: number; trigger: unknown; steps: Array<Record<string, unknown>> } => ({
    version: 1,
    trigger: { channel: "sms" as const, conditions: [{ type: "contains" as const, value: "rltr" }] },
    steps: [
      { id: "s1", type: "extract_text", fields: [{ name: "lead_name" }] },
      {
        id: "s4",
        type: "route_to_team",
        offerTemplate:
          "New Realtor.com Buyer Lead: {{vars.lead_name}}\nReply 1 to claim or 2 to pass by {{offer.deadline}}, or it goes to the next agent.\nLead source: Realtor.com",
        ownerFallbackTemplate: "Nobody claimed {{vars.lead_name}}"
      }
    ]
  });

  /**
   * Its single route has NO lead-type gate, so any seller arriving through
   * Realtor.com was round-robined. It now broadcasts to the same trio every
   * other seller route uses.
   */
  it("becomes a broadcast to the standard trio", () => {
    const d = def();
    const res = patchRealtorBroadcast(d);
    expect(res.touched).toEqual(["s4.agentNames", "s4.offerTemplate"]);
    expect((d.steps[1] as { agentNames: string[] }).agentNames).toEqual(BROADCAST_NAMES);
  });

  it("fixes the copy to match: no cascade, first to claim", () => {
    const d = def();
    patchRealtorBroadcast(d);
    const t = (d.steps[1] as { offerTemplate: string }).offerTemplate;
    expect(t).not.toContain("next agent");
    expect(t).toContain(FIRST_TO_CLAIM);
  });

  /**
   * A broadcast pins nobody, so a leftover single-agent pin has to go or the
   * schema rejects the step for setting two recipient sources.
   */
  it("clears any single-agent pin and stays valid", () => {
    const d = def();
    (d.steps[1] as Record<string, unknown>).agentName = "Dave Lane";
    patchRealtorBroadcast(d);
    expect(d.steps[1]).not.toHaveProperty("agentName");
    const parsed = parseAiFlowDefinition(d);
    expect(validateDefinitionSemantics(parsed)).toEqual([]);
  });

  it("is a no-op on a second run", () => {
    const d = def();
    patchRealtorBroadcast(d);
    expect(patchRealtorBroadcast(d).changed).toBe(false);
  });

  it("aborts when the step moved or is not a route", () => {
    const gone = def();
    gone.steps = gone.steps.filter((s) => s.id !== "s4");
    expect(() => patchRealtorBroadcast(gone)).toThrow(/step "s4" is missing/);
    const wrong = def();
    (wrong.steps[1] as Record<string, unknown>).type = "notify_owner";
    expect(() => patchRealtorBroadcast(wrong)).toThrow(/not a route/);
  });
});

describe("who is broadcast to", () => {
  /**
   * Full names, because broadcast matching is exact: "Gabby" reaches nobody.
   * And agentNames rather than broadcastAll, because Amy's roster row carries
   * team_broadcast_enabled=false and broadcastAll would silently drop her from
   * her own offers.
   */
  it("uses the same trio as every other seller route", () => {
    expect(BROADCAST_NAMES).toEqual(["Gabrielle Mota", "Amy Laidlaw", "Dave Lane"]);
    for (const n of BROADCAST_NAMES) expect(n.split(" ").length).toBeGreaterThan(1);
  });
});

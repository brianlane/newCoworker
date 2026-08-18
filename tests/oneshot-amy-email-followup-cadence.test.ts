/**
 * Amy's email follow-up cadence (scripts/oneshot/amy-email-followup-cadence.ts).
 *
 * The behaviours pinned here are the ones that were wrong in an earlier draft
 * or that have burned this account before: a stop must cascade, an alert must
 * fire once, a mailbox read must write something when the mailbox is quiet,
 * and appending must not move a parked run.
 */
import { describe, expect, it } from "vitest";
import {
  AMY_MAILBOX_CONNECTION_ID,
  EFU,
  FOLLOW_UPS,
  ROUND_GAP_MINUTES,
  TARGET_FLOWS,
  applyEmailFollowUp,
  buildEmailFollowUpBlock,
  revertEmailFollowUp,
  stopVar
} from "../scripts/oneshot/amy-email-followup-cadence";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { flattenSteps } from "../supabase/functions/_shared/ai_flows/branching";
import { FINAL_REMINDER_BANNER } from "../supabase/functions/_shared/ai_flows/offer_reminders";

type Step = Record<string, unknown> & { id: string; type: string };

/** A definition shaped like the live lead flows: it produces the two gate vars. */
function fixture(): { version: number; trigger: unknown; steps: Step[] } {
  return {
    version: 1,
    trigger: { channel: "sms", conditions: [{ type: "has_url" }] },
    steps: [
      { id: "url", type: "extract_url", saveAs: "url" },
      {
        id: "browse",
        type: "browse_extract",
        urlVar: "url",
        fields: [
          { name: "lead_name", description: "The lead's full name, or none" },
          { name: "lead_phone", description: "E.164 phone, or exactly: none" },
          { name: "lead_email", description: "Email address, or exactly: none" }
        ]
      },
      { id: "notify", type: "notify_owner", message: "a lead arrived: {{vars.lead_name}}" }
    ] as Step[]
  };
}

function allSteps(steps: unknown[], out: Step[] = []): Step[] {
  for (const s of steps) {
    if (!s || typeof s !== "object") continue;
    const step = s as Step & { steps?: unknown[]; branches?: Array<{ steps?: unknown[] }>; else?: unknown[] };
    out.push(step);
    for (const arm of step.branches ?? []) allSteps(arm.steps ?? [], out);
    allSteps(step.else ?? [], out);
  }
  return out;
}

function stepById(id: string): Step {
  const found = allSteps([buildEmailFollowUpBlock()]).find((s) => s.id === id);
  if (!found) throw new Error(`no step ${id}`);
  return found;
}

describe("the gates that decide who gets this at all", () => {
  it("uses the SAME has-a-phone predicate the flows' own no-phone guards use", () => {
    // Two different predicates for "has a phone" would eventually disagree,
    // and this cadence would either double up with the SMS one or skip a lead.
    const root = stepById(`${EFU}_root`) as Step & { branches: Array<{ condition: unknown }> };
    expect(root.branches[0].condition).toEqual({ var: "lead_phone", contains: "+" });
  });

  it("puts the cadence in the ELSE of the phone gate, so a lead with a phone gets nothing new", () => {
    const root = stepById(`${EFU}_root`) as Step & { branches: Array<{ steps: unknown[] }> };
    expect(root.branches[0].steps).toEqual([]);
  });

  it("requires an actual email address before running", () => {
    const gate = stepById(`${EFU}_email_gate`) as Step & { branches: Array<{ condition: unknown }> };
    expect(gate.branches[0].condition).toEqual({ var: "lead_email", contains: "@" });
  });
});

describe("the stop cascade", () => {
  it("round 1 reads the mailbox unconditionally; later rounds only if the last one found nothing", () => {
    expect(stepById(`${EFU}_check_1`).when).toBeUndefined();
    expect(stepById(`${EFU}_wait_1`).when).toBeUndefined();
    for (const n of [2, 3]) {
      expect(stepById(`${EFU}_check_${n}`).when).toEqual({ var: stopVar(n - 1), equals: "none" });
      expect(stepById(`${EFU}_wait_${n}`).when).toEqual({ var: stopVar(n - 1), equals: "none" });
    }
  });

  it("a send is gated on its OWN round's answer, so a skipped check stops it too", () => {
    // A skipped email_extract writes nothing, its var reads "", and every
    // gate below fails. That is what carries "stop everything" without a
    // branch per round (the schema caps branch nesting at three levels).
    for (const n of [1, 2, 3]) {
      expect(stepById(`${EFU}_send_${n}`).when).toEqual({ var: stopVar(n), equals: "none" });
    }
  });

  it("gives every round its own stop var, so one reply cannot alert three times", () => {
    // A single shared var is sticky once it reads "replied": a flat cadence
    // gated on it would re-alert on every later round for one reply.
    const vars = [1, 2, 3].map(stopVar);
    expect(new Set(vars).size).toBe(3);
    for (const n of [1, 2, 3]) {
      expect(stepById(`${EFU}_replied_${n}`).when).toEqual({ var: stopVar(n), equals: "replied" });
      expect(stepById(`${EFU}_bounced_${n}`).when).toEqual({ var: stopVar(n), equals: "bounced" });
    }
  });
});

describe("the mailbox read", () => {
  it("always writes a no-match value, so a quiet mailbox does not leave the ladder inert", () => {
    // Amy's HomeLight reveal ladder sat inert exactly this way (2026-08-16):
    // no noMatchVars, so the gate var never existed and nothing ever fired.
    for (const n of [1, 2, 3]) {
      const check = stepById(`${EFU}_check_${n}`) as Step & { noMatchVars: Record<string, string> };
      expect(check.noMatchVars).toEqual({ [stopVar(n)]: "none" });
    }
  });

  it("does NOT filter by sender, because a bounce comes from a postmaster", () => {
    // Matching on fromContains: {{vars.lead_email}} would catch replies and
    // miss every delivery failure, which is the case that matters most here.
    const check = stepById(`${EFU}_check_1`);
    expect(check.fromContains).toBeUndefined();
    expect(check.matchTemplates).toEqual(["{{vars.lead_email}}"]);
  });

  it("looks back exactly as far as the gap between rounds", () => {
    // email_extract caps lookbackMinutes at 1440, so anything longer than a
    // day between rounds would leave a blind window.
    expect(ROUND_GAP_MINUTES).toBe(1440);
    for (const n of [1, 2, 3]) {
      expect(stepById(`${EFU}_check_${n}`).lookbackMinutes).toBe(ROUND_GAP_MINUTES);
    }
  });

  it("reads from the same mailbox the flows already send from", () => {
    for (const n of [1, 2, 3]) {
      expect(stepById(`${EFU}_check_${n}`).connectionId).toBe(AMY_MAILBOX_CONNECTION_ID);
      expect(stepById(`${EFU}_send_${n}`).fromConnectionId).toBe(AMY_MAILBOX_CONNECTION_ID);
    }
  });
});

describe("the copy", () => {
  it("sends three follow-ups, the last of which says it is the last", () => {
    expect(FOLLOW_UPS).toHaveLength(3);
    expect(FOLLOW_UPS[2].body.toLowerCase()).toContain("last note");
  });

  it("asks for a reply rather than a call back, since there is no phone", () => {
    for (const copy of FOLLOW_UPS) expect(copy.body.toLowerCase()).toContain("repl");
  });

  it("carries no em dashes anywhere", () => {
    for (const copy of FOLLOW_UPS) {
      expect(copy.subject).not.toContain("—");
      expect(copy.body).not.toContain("—");
    }
    for (const n of [1, 2, 3]) {
      expect(String(stepById(`${EFU}_replied_${n}`).message)).not.toContain("—");
      expect(String(stepById(`${EFU}_bounced_${n}`).message)).not.toContain("—");
    }
  });

  it("banners a bounce with the same marker the rest of the account uses", () => {
    expect(String(stepById(`${EFU}_bounced_1`).message).startsWith(FINAL_REMINDER_BANNER)).toBe(true);
  });

  it("routes a reply to whoever owns the lead, falling back to the team", () => {
    const replied = stepById(`${EFU}_replied_1`);
    expect(replied.type).toBe("notify_lead_owner");
    expect(replied.unownedFallback).toBe("team");
  });
});

describe("applying it", () => {
  it("validates against the real schema", () => {
    const def = fixture();
    applyEmailFollowUp(def as never, []);
    expect(() => parseAiFlowDefinition(def)).not.toThrow();
  });

  it("is a PURE APPEND, so no parked run changes meaning", () => {
    // current_step is a flat index over the flattened definition. Anything
    // other than an append renumbers steps a live run is parked past.
    const before = fixture();
    const after = fixture();
    applyEmailFollowUp(after as never, []);
    const a = flattenSteps(before.steps as never).map((s) => (s.step as { id: string }).id);
    const b = flattenSteps(after.steps as never).map((s) => (s.step as { id: string }).id);
    expect(b.slice(0, a.length)).toEqual(a);
    expect(b.length).toBeGreaterThan(a.length);
  });

  it("is idempotent, and reverts cleanly", () => {
    const def = fixture();
    expect(applyEmailFollowUp(def as never, [])).toBe(true);
    expect(applyEmailFollowUp(def as never, [])).toBe(false);
    expect(revertEmailFollowUp(def as never, [])).toBe(true);
    expect(revertEmailFollowUp(def as never, [])).toBe(false);
    expect(def.steps.map((s) => s.id)).toEqual(fixture().steps.map((s) => s.id));
  });

  it("refuses a flow that cannot produce the gate vars, rather than shipping a dead block", () => {
    const def = fixture();
    // Drop the extractor entirely: nothing produces lead_email/lead_phone.
    def.steps = [{ id: "noop", type: "notify_owner", message: "hi" } as Step];
    expect(() => applyEmailFollowUp(def as never, [])).toThrow(/lead_email/);
  });

  it("leaves HomeLight alone, which runs its own email ladder", () => {
    expect(TARGET_FLOWS).not.toContain("HomeLight Referral");
    expect(TARGET_FLOWS).toHaveLength(4);
  });
});

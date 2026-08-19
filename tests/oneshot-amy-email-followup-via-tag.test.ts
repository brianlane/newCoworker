/**
 * One email follow-up, in the cadence, reached by a tag
 * (scripts/oneshot/amy-email-followup-via-tag.ts).
 *
 * The inline rounds and the cadence's rounds were the same three emails from
 * the same builder. Keeping both meant a tagged email-only lead would get six,
 * which is why tagging was never switched on. This swaps the inline copy for
 * the tag that starts the cadence, so there is one sequence and one place to
 * edit its copy.
 */
import { describe, expect, it } from "vitest";
import {
  EFU,
  EFU_TAG,
  EMAIL_ONLY_TAG_NOTE,
  FOLLOW_UP_TAG,
  buildEmailFollowUpBlock,
  buildEmailOnlyTagBlock
} from "../scripts/oneshot/_amy-email-followup-block";
import {
  TARGET_FLOWS,
  alreadyPatched,
  applyTagHandover,
  inlineBlockStartIndex,
  revertTagHandover
} from "../scripts/oneshot/amy-email-followup-via-tag";
import { AUTO_TAG_NOTE } from "../scripts/oneshot/amy-needs-follow-up-definition";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { flattenSteps } from "../supabase/functions/_shared/ai_flows/branching";

type Step = Record<string, unknown> & { id: string; type: string };
type Def = { version: number; trigger: unknown; steps: Step[] };

/** Shaped like the live lead flows: it produces both gate vars. */
function fixture(): Def {
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
    const step = s as Step & {
      steps?: unknown[];
      branches?: Array<{ steps?: unknown[] }>;
      else?: unknown[];
    };
    out.push(step);
    for (const arm of step.branches ?? []) allSteps(arm.steps ?? [], out);
    allSteps(step.else ?? [], out);
  }
  return out;
}

describe("the tag block", () => {
  it("reuses the SAME two gates as the rounds, so 'email only' cannot mean two things", () => {
    const tagRoot = buildEmailOnlyTagBlock() as Step & {
      branches: Array<{ condition: unknown }>;
      else: Step[];
    };
    const roundsRoot = buildEmailFollowUpBlock() as Step & {
      branches: Array<{ condition: unknown }>;
      else: Step[];
    };
    expect(tagRoot.branches[0].condition).toEqual(roundsRoot.branches[0].condition);
    const tagGate = tagRoot.else[0] as Step & { branches: Array<{ condition: unknown }> };
    const roundsGate = roundsRoot.else[0] as Step & { branches: Array<{ condition: unknown }> };
    expect(tagGate.branches[0].condition).toEqual(roundsGate.branches[0].condition);
  });

  it("tags with an emailVar, which is the only way the tag lands on a phoneless lead", () => {
    const tag = allSteps([buildEmailOnlyTagBlock()]).find((s) => s.id === EFU_TAG)!;
    expect(tag.type).toBe("update_contact");
    expect(tag.emailVar).toBe("lead_email");
    expect(tag.phoneVar).toBe("lead_phone");
    expect(tag.addTags).toEqual([FOLLOW_UP_TAG]);
  });

  it("does NOT carry the auto-first-contact note, which would be a lie here", () => {
    // AUTO_TAG_NOTE says the AI already called and texted. This lead has no
    // phone, which is the whole reason they are being tagged. The note is read
    // by a human and extracted into tag_auto, so it has to be true.
    const tag = allSteps([buildEmailOnlyTagBlock()]).find((s) => s.id === EFU_TAG)!;
    expect(tag.noteTemplate).toBe(EMAIL_ONLY_TAG_NOTE);
    expect(tag.noteTemplate).not.toBe(AUTO_TAG_NOTE);
    expect(String(tag.noteTemplate)).not.toContain("auto_first_contact");
  });

  it("contains no send_email at all: the emails live in the cadence now", () => {
    const kinds = allSteps([buildEmailOnlyTagBlock()]).map((s) => s.type);
    expect(kinds).not.toContain("send_email");
    expect(kinds).not.toContain("email_extract");
    expect(kinds).not.toContain("sleep");
  });

  it("FILES the lead before tagging, so it does not depend on an earlier email", () => {
    // update_contact skips when there is no contact row. Tagging alone would
    // have leaned on an earlier send_email in the flow having succeeded (that
    // is what files an emailed lead), so a skipped or failed intro email would
    // silently end all outreach. The inline rounds needed no contact at all.
    const steps = allSteps([buildEmailOnlyTagBlock()]);
    const file = steps.find((s) => s.id === `${EFU_TAG}_file`)!;
    expect(file.type).toBe("upsert_customer");
    expect(file.emailVar).toBe("lead_email");
    expect(file.phoneVar).toBe("lead_phone");
    // Order matters: the row has to exist before the tag looks for it.
    const ids = steps.map((s) => s.id);
    expect(ids.indexOf(`${EFU_TAG}_file`)).toBeLessThan(ids.indexOf(EFU_TAG));
  });
});

describe("swapping the inline rounds for the tag", () => {
  it("removes the rounds, appends the tag, and still validates", () => {
    const def = fixture();
    def.steps.push(buildEmailFollowUpBlock() as Step);
    expect(inlineBlockStartIndex(def)).toBe(3);

    const notes: string[] = [];
    expect(applyTagHandover(def, notes)).toBe(true);
    expect(notes.join(" ")).toContain("removed the inline");

    const ids = flattenSteps(def.steps as never).map((e) => e.step.id);
    expect(ids.some((id) => id === `${EFU}_root`)).toBe(false);
    expect(ids).toContain(`${EFU_TAG}_root`);
    expect(ids).toContain(EFU_TAG);
    // The real gate: the engine's own validator has to accept the result.
    expect(() => parseAiFlowDefinition(def)).not.toThrow();
  });

  it("is a no-op when already swapped", () => {
    const def = fixture();
    def.steps.push(buildEmailOnlyTagBlock() as Step);
    expect(alreadyPatched(def)).toBe(true);
    expect(applyTagHandover(def, [])).toBe(false);
  });

  it("applies to a flow that never had the inline rounds", () => {
    // Idempotent either direction: a flow the earlier one-shot missed still
    // ends up handing its email-only leads to the cadence.
    const def = fixture();
    expect(inlineBlockStartIndex(def)).toBeNull();
    expect(applyTagHandover(def, [])).toBe(true);
    expect(alreadyPatched(def)).toBe(true);
    expect(() => parseAiFlowDefinition(def)).not.toThrow();
  });

  it("leaves every step before the block exactly where it was", () => {
    // current_step indexes the FLATTENED definition, so a renumber below a
    // parked run walks it onto the wrong instruction. The block is last, so
    // the prefix must be untouched.
    const def = fixture();
    def.steps.push(buildEmailFollowUpBlock() as Step);
    const before = flattenSteps(def.steps as never).map((e) => e.step.id).slice(0, 3);
    applyTagHandover(def, []);
    const after = flattenSteps(def.steps as never).map((e) => e.step.id).slice(0, 3);
    expect(after).toEqual(before);
  });

  it("reverts to the inline rounds", () => {
    const def = fixture();
    def.steps.push(buildEmailFollowUpBlock() as Step);
    applyTagHandover(def, []);
    const notes: string[] = [];
    expect(revertTagHandover(def, notes)).toBe(true);
    expect(notes.join(" ")).toContain("restored");
    const ids = flattenSteps(def.steps as never).map((e) => e.step.id);
    expect(ids).toContain(`${EFU}_root`);
    expect(ids.some((id) => id === `${EFU_TAG}_root`)).toBe(false);
    expect(() => parseAiFlowDefinition(def)).not.toThrow();
  });

  it("revert is a no-op when the tag block is not there", () => {
    expect(revertTagHandover(fixture(), [])).toBe(false);
  });
});

describe("targets", () => {
  it("covers the four lead flows that carried the inline rounds", () => {
    expect([...TARGET_FLOWS]).toEqual([
      "ReferralExchange Lead",
      "Realtor.com Lead",
      "New Lead Intake",
      "Clever Lead - Accept"
    ]);
    // HomeLight is absent on purpose: it runs its own email ladder.
    expect([...TARGET_FLOWS]).not.toContain("HomeLight Referral");
  });
});

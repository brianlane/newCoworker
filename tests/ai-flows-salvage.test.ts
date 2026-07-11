import { describe, expect, it } from "vitest";
import {
  parseAiFlowDefinition,
  salvageFlowDefinition,
  type AiFlowDefinition
} from "@/lib/ai-flows/schema";

/**
 * Best-effort salvage of AI-authored drafts that failed validation: keep
 * everything valid, mechanically repair/remove the rest, never error the
 * owner out of their (paid) generation.
 */

const VALID: AiFlowDefinition = {
  version: 1,
  trigger: { channel: "webhook", conditions: [] },
  steps: [
    { id: "e", type: "extract_text", fields: [{ name: "lead_phone" }] },
    { id: "s", type: "send_sms", to: "{{vars.lead_phone}}", body: "Hi!" }
  ]
};

describe("salvageFlowDefinition: unusable inputs", () => {
  it("returns null for non-objects", () => {
    expect(salvageFlowDefinition(null)).toBeNull();
    expect(salvageFlowDefinition("x")).toBeNull();
    expect(salvageFlowDefinition([1, 2])).toBeNull();
  });
});

describe("salvageFlowDefinition: already-valid input", () => {
  it("round-trips a valid definition with no warnings", () => {
    const res = salvageFlowDefinition(VALID);
    expect(res).not.toBeNull();
    expect(res!.warnings).toEqual([]);
    expect(res!.definition).toEqual(parseAiFlowDefinition(VALID));
  });
});

describe("salvageFlowDefinition: trigger salvage", () => {
  it("falls back to Run-now when the trigger is missing or invalid", () => {
    const res = salvageFlowDefinition({ version: 1, steps: VALID.steps });
    expect(res!.definition.trigger).toEqual({ channel: "manual" });
    expect(res!.warnings.join(" ")).toContain("Run-now button");

    const bad = salvageFlowDefinition({
      version: 1,
      trigger: { channel: "carrier_pigeon" },
      steps: VALID.steps
    });
    expect(bad!.definition.trigger).toEqual({ channel: "manual" });
  });

  it("keeps valid extra triggers, dropping invalid/voice/over-cap ones", () => {
    const res = salvageFlowDefinition({
      ...VALID,
      triggers: [
        { channel: "tenant_email", conditions: [] },
        { channel: "voice", fromE164: "+16025551234" }, // voice can't join a set
        { channel: "nope" }, // invalid
        { channel: "manual" },
        { channel: "manual" },
        { channel: "manual" },
        { channel: "manual" } // 5th valid extra: over the cap of 4
      ]
    });
    expect(res!.definition.triggers).toHaveLength(4);
    expect(res!.warnings.join(" ")).toContain("Removed 3 additional trigger(s)");
  });

  it("ignores a non-array triggers value", () => {
    const res = salvageFlowDefinition({ ...VALID, triggers: "x" });
    expect(res!.definition.triggers).toBeUndefined();
    expect(res!.warnings).toEqual([]);
  });

  it("drops from_matches conditions with no usable sender (primary and extras)", () => {
    const res = salvageFlowDefinition({
      version: 1,
      trigger: {
        channel: "sms",
        conditions: [{ type: "from_matches" }, { type: "has_url" }]
      },
      triggers: [
        {
          channel: "webhook",
          conditions: [
            {
              type: "from_matches",
              value: "zillow",
              ref: { source: "contact", id: "22222222-2222-4222-8222-222222222222" }
            }
          ]
        }
      ],
      steps: [{ id: "n", type: "notify_owner", message: "lead!" }]
    });
    const trig = res!.definition.trigger;
    expect(trig.channel === "sms" && trig.conditions).toEqual([{ type: "has_url" }]);
    const extra = res!.definition.triggers![0];
    expect(extra.channel === "webhook" && extra.conditions).toEqual([]);
    expect(res!.warnings.filter((w) => w.includes("from matches"))).toHaveLength(2);
  });
});

describe("salvageFlowDefinition: step salvage (zod level)", () => {
  it("drops non-object and missing-required-field steps, keeping the rest", () => {
    const res = salvageFlowDefinition({
      ...VALID,
      steps: [
        "junk",
        { id: "bad", type: "send_sms" }, // no body
        { id: "n", type: "notify_owner", message: "ok" },
        { type: "mystery_step" }
      ]
    });
    expect(res!.definition.steps.map((s) => s.type)).toEqual(["notify_owner"]);
    expect(res!.warnings.join("\n")).toContain("Removed step 1");
    expect(res!.warnings.join("\n")).toContain('Removed step 2 ("send_sms")');
    expect(res!.warnings.join("\n")).toContain('Removed step 4 ("mystery_step")');
  });

  it("mints missing ids and de-dupes duplicates", () => {
    const res = salvageFlowDefinition({
      ...VALID,
      steps: [
        { type: "notify_owner", message: "a" }, // no id → s1
        { id: "s1", type: "notify_owner", message: "b" } // collides → s1_2
      ]
    });
    expect(res!.definition.steps.map((s) => s.id)).toEqual(["s1", "s1_2"]);
  });

  it("drops a step whose when-retry still fails, and one with no type at all", () => {
    const res = salvageFlowDefinition({
      ...VALID,
      steps: [
        // Broken guard AND missing body: removing the guard doesn't save it.
        { id: "s", type: "send_sms", to: "+16025551234", when: { var: "x" } },
        { id: "q" }, // no type at all
        { id: "n", type: "notify_owner", message: "ok" }
      ]
    });
    expect(res!.definition.steps.map((s) => s.type)).toEqual(["notify_owner"]);
    expect(res!.warnings.join("\n")).toContain('Removed step 1 ("send_sms")');
    expect(res!.warnings.join("\n")).toContain("Removed step 2:");
  });

  it("salvages a step by removing its broken when-guard", () => {
    const res = salvageFlowDefinition({
      ...VALID,
      steps: [
        { id: "e", type: "extract_text", fields: [{ name: "lead_phone" }] },
        {
          id: "s",
          type: "send_sms",
          to: "{{vars.lead_phone}}",
          body: "Hi!",
          when: { var: "x" } // no equals/contains/notEquals → invalid guard
        }
      ]
    });
    expect(res!.definition.steps).toHaveLength(2);
    expect(res!.definition.steps[1].when).toBeUndefined();
    expect(res!.warnings.join(" ")).toContain("broken run-condition");
  });

  it("warns when steps past the 25-step cap are dropped", () => {
    const res = salvageFlowDefinition({
      version: 1,
      trigger: { channel: "manual" },
      steps: Array.from({ length: 28 }, (_, i) => ({
        id: `n${i}`,
        type: "notify_owner",
        message: `m${i}`
      }))
    });
    expect(res!.definition.steps).toHaveLength(25);
    expect(res!.warnings.join(" ")).toContain("Removed 3 step(s) past the 25-step limit");
  });

  it("adds a placeholder notify-me step when nothing survives", () => {
    const res = salvageFlowDefinition({ version: 1, trigger: { channel: "manual" }, steps: "x" });
    expect(res!.definition.steps).toHaveLength(1);
    expect(res!.definition.steps[0].type).toBe("notify_owner");
    expect(res!.warnings.join(" ")).toContain("notify-me step was added");
  });

  it("carries only truthy options and tolerates a non-object options value", () => {
    const withOpts = salvageFlowDefinition({
      ...VALID,
      options: { suppressDefaultReply: true, captureStepScreenshots: false, junk: 1 }
    });
    expect(withOpts!.definition.options).toEqual({
      suppressDefaultReply: true,
      captureStepScreenshots: undefined
    });
    const badOpts = salvageFlowDefinition({ ...VALID, options: "nope" });
    expect(badOpts!.definition.options).toBeUndefined();
    const captureOnly = salvageFlowDefinition({
      ...VALID,
      options: { captureStepScreenshots: true }
    });
    expect(captureOnly!.definition.options).toEqual({
      suppressDefaultReply: undefined,
      captureStepScreenshots: true
    });
  });
});

describe("salvageFlowDefinition: semantic repair loop", () => {
  it("drops a step that uses a var no earlier step produces", () => {
    const res = salvageFlowDefinition({
      version: 1,
      trigger: { channel: "manual" },
      steps: [
        { id: "s", type: "send_sms", to: "{{vars.ghost}}", body: "Hi!" },
        { id: "n", type: "notify_owner", message: "done" }
      ]
    });
    expect(res!.definition.steps.map((s) => s.type)).toEqual(["notify_owner"]);
    expect(res!.warnings.join(" ")).toContain("{{vars.ghost}}");
  });

  it("mends attachScreenshot (keeps the send, strips the flag)", () => {
    const res = salvageFlowDefinition({
      version: 1,
      trigger: { channel: "manual" },
      steps: [
        {
          id: "m",
          type: "send_email",
          to: "o@x.com",
          subject: "s",
          body: "b",
          attachScreenshot: true // no earlier screenshot capture
        }
      ]
    });
    const step = res!.definition.steps[0];
    expect(step.type).toBe("send_email");
    expect(step.type === "send_email" && step.attachScreenshot).toBeUndefined();
    expect(res!.warnings.join(" ")).toContain("Adjusted step 1");
  });

  it("mends a sleep with both wait modes by keeping the relative minutes", () => {
    const res = salvageFlowDefinition({
      version: 1,
      trigger: { channel: "manual" },
      steps: [
        { id: "z", type: "sleep", minutes: 60, untilTime: "08:30", timezone: "America/Phoenix" },
        { id: "n", type: "notify_owner", message: "later" }
      ]
    });
    const sleep = res!.definition.steps[0];
    expect(sleep.type === "sleep" && sleep.minutes).toBe(60);
    expect(sleep.type === "sleep" && sleep.untilTime).toBeUndefined();
  });

  it("mends a sleep mixing time-of-day and date modes by dropping the date templates", () => {
    const res = salvageFlowDefinition({
      version: 1,
      trigger: { channel: "manual" },
      steps: [
        {
          id: "z",
          type: "sleep",
          untilTime: "08:30",
          timezone: "America/Phoenix",
          untilDateTemplate: "2026-08-01"
        },
        { id: "n", type: "notify_owner", message: "later" }
      ]
    });
    const sleep = res!.definition.steps[0];
    expect(sleep.type === "sleep" && sleep.untilTime).toBe("08:30");
    expect(sleep.type === "sleep" && sleep.untilDateTemplate).toBeUndefined();
  });

  it("mends a route_to_team pinned to both agentName and agentRef by keeping the name", () => {
    const res = salvageFlowDefinition({
      version: 1,
      trigger: { channel: "manual" },
      steps: [
        {
          id: "r",
          type: "route_to_team",
          offerTemplate: "Lead! 1/2",
          ownerFallbackTemplate: "back to you",
          agentName: "Dave",
          agentRef: { source: "employee", id: "22222222-2222-4222-8222-222222222222" }
        }
      ]
    });
    const r = res!.definition.steps[0];
    expect(r.type === "route_to_team" && r.agentName).toBe("Dave");
    expect(r.type === "route_to_team" && r.agentRef).toBeUndefined();
  });

  it("drops a half-configured keep-for-owner pair", () => {
    const res = salvageFlowDefinition({
      version: 1,
      trigger: { channel: "manual" },
      steps: [
        {
          id: "r",
          type: "route_to_team",
          offerTemplate: "Lead! 1/2",
          ownerFallbackTemplate: "back to you",
          ownerDirectTemplate: "kept for you" // ownerDirectWhen missing
        }
      ]
    });
    const r = res!.definition.steps[0];
    expect(r.type === "route_to_team" && r.ownerDirectTemplate).toBeUndefined();
  });

  it("mends a send_sms whose mediaUrlVar no earlier step produces (keeps the text send)", () => {
    const res = salvageFlowDefinition({
      version: 1,
      trigger: { channel: "manual" },
      steps: [
        { id: "s", type: "send_sms", to: "+16025551234", body: "hi", mediaUrlVar: "ghost_img" }
      ]
    });
    const s = res!.definition.steps[0];
    expect(s.type).toBe("send_sms");
    expect(s.type === "send_sms" && s.mediaUrlVar).toBeUndefined();
    expect(res!.warnings.join(" ")).toContain("Adjusted step 1");
  });

  it("mends a generate_image whose inputImageTemplate references an unproduced var", () => {
    const res = salvageFlowDefinition({
      version: 1,
      trigger: { channel: "manual" },
      steps: [
        {
          id: "g",
          type: "generate_image",
          promptTemplate: "a banner",
          inputImageTemplate: "{{vars.ghost_img}}",
          saveAs: "img"
        }
      ]
    });
    const g = res!.definition.steps[0];
    expect(g.type).toBe("generate_image");
    expect(g.type === "generate_image" && g.inputImageTemplate).toBeUndefined();
    expect(res!.warnings.join(" ")).toContain("Adjusted step 1");
  });

  it("still drops a generate_image whose PROMPT references an unproduced var", () => {
    const res = salvageFlowDefinition({
      version: 1,
      trigger: { channel: "manual" },
      steps: [
        {
          id: "g",
          type: "generate_image",
          promptTemplate: "a banner for {{vars.ghost}}",
          inputImageTemplate: "{{vars.ghost}}",
          saveAs: "img"
        },
        { id: "n", type: "notify_owner", message: "done" }
      ]
    });
    expect(res!.definition.steps.map((s) => s.type)).toEqual(["notify_owner"]);
  });

  it("mends a send_sms with multiple recipients (to > toAgentName > replyToGroup)", () => {
    const keepTo = salvageFlowDefinition({
      version: 1,
      trigger: { channel: "sms", conditions: [] },
      steps: [
        { id: "s", type: "send_sms", to: "+16025551234", toAgentName: "Dave", body: "hi" }
      ]
    });
    const s1 = keepTo!.definition.steps[0];
    expect(s1.type === "send_sms" && s1.to).toBe("+16025551234");
    expect(s1.type === "send_sms" && s1.toAgentName).toBeUndefined();

    const keepAgent = salvageFlowDefinition({
      version: 1,
      trigger: { channel: "sms", conditions: [] },
      steps: [
        { id: "s", type: "send_sms", toAgentName: "Dave", replyToGroup: true, body: "hi" }
      ]
    });
    const s2 = keepAgent!.definition.steps[0];
    expect(s2.type === "send_sms" && s2.toAgentName).toBe("Dave");
    expect(s2.type === "send_sms" && s2.replyToGroup).toBeUndefined();

    const keepGroup = salvageFlowDefinition({
      version: 1,
      trigger: { channel: "sms", conditions: [] },
      steps: [
        {
          id: "s",
          type: "send_sms",
          toRef: { source: "employee", id: "22222222-2222-4222-8222-222222222222" },
          replyToGroup: true,
          body: "hi"
        }
      ]
    });
    const s3 = keepGroup!.definition.steps[0];
    expect(s3.type === "send_sms" && s3.replyToGroup).toBe(true);
    expect(s3.type === "send_sms" && s3.toRef).toBeUndefined();
  });

  it("resets a broken voice trigger to Run-now and clears the stranded voice steps", () => {
    const res = salvageFlowDefinition({
      version: 1,
      // Zod-valid voice trigger, but semantically incomplete: an inbound
      // voice flow needs fromE164/fromRef (a non-step issue).
      trigger: { channel: "voice" },
      steps: [{ id: "v", type: "ring_handoff", toE164: "+16025551234" }]
    });
    expect(res!.definition.trigger).toEqual({ channel: "manual" });
    // The ring_handoff can't run under a manual trigger → removed → placeholder.
    expect(res!.definition.steps.map((s) => s.type)).toEqual(["notify_owner"]);
    expect(res!.warnings.join(" ")).toContain("couldn't be repaired");
  });

  it("salvages a VALID voice trigger whose steps all failed (Bugbot a61cd2d8: no placeholder loop)", () => {
    const res = salvageFlowDefinition({
      version: 1,
      // Fully valid inbound voice trigger — kept at the zod stage.
      trigger: { channel: "voice", fromE164: "+16025551234" },
      // No step survives zod, so the placeholder path runs under voice.
      steps: [{ id: "v", type: "ring_handoff" }] // no toE164/toRef
    });
    expect(res).not.toBeNull();
    expect(res!.definition.trigger).toEqual({ channel: "manual" });
    expect(res!.definition.steps.map((s) => s.type)).toEqual(["notify_owner"]);
    expect(res!.warnings.join(" ")).toContain("no usable call steps");
    // The placeholder was injected exactly once, not once per loop pass.
    expect(res!.warnings.filter((w) => w.includes("notify-me step was added"))).toHaveLength(1);
  });

  it("always returns a definition that passes full validation", () => {
    const res = salvageFlowDefinition({
      version: 999,
      trigger: { channel: "sms", conditions: [{ type: "from_matches" }] },
      triggers: [{ channel: "bogus" }],
      steps: [
        { id: "dup", type: "notify_owner", message: "a" },
        { id: "dup", type: "send_sms", body: "no recipient... wait, none" },
        { id: "s3", type: "send_email", to: "x@y.com", subject: "s", body: "b", attachScreenshot: true },
        { id: "s4", type: "wait_for_reply", phoneVar: "never_extracted" }
      ],
      options: { suppressDefaultReply: true }
    });
    expect(res).not.toBeNull();
    expect(() => parseAiFlowDefinition(res!.definition)).not.toThrow();
    expect(res!.warnings.length).toBeGreaterThan(0);
  });
});

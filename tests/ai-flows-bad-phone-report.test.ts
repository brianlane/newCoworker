import { describe, expect, it } from "vitest";
import {
  addBadPhoneAgentReport,
  buildBadPhoneSteps,
  FLOW_CONFIGS,
  type Definition,
  type FlowConfig
} from "../scripts/oneshot/add-bad-phone-agent-report";
import { parseAiFlowDefinition, AiFlowValidationError } from "../src/lib/ai-flows/schema";

/**
 * The one-shot's pure patch helpers, validated through the SAME
 * parseAiFlowDefinition the dashboard (and the script's own pre-write check)
 * uses. Each config's templates may only reference vars the real flow
 * produces — the fixtures here declare exactly the extraction fields the
 * live flows have, so a config referencing a var the flow doesn't produce
 * fails HERE instead of at apply time against production data.
 */

/** Extraction fields the live flows produce (per flow name). */
const FLOW_FIELDS: Record<string, string[]> = {
  "Realtor.com Lead": [
    "lead_name",
    "lead_phone",
    "lead_email",
    "lead_address",
    "lead_price_details",
    "lead_url",
    "lead_first_name",
    "price_band"
  ],
  "ReferralExchange Lead": [
    "lead_type",
    "lead_name",
    "lead_phone",
    "lead_email",
    "location",
    "price",
    "web_source",
    "price_band"
  ],
  "HomeLight Referral": [
    "lead_first_name",
    "price",
    "city",
    "lead_type",
    "lead_name",
    "lead_phone",
    "lead_email",
    "lead_address"
  ],
  "Clever Lead - Accept": ["lead_name", "lead_phone", "lead_email", "lead_address"]
};

function fixtureFor(cfg: FlowConfig): Definition {
  const fields = FLOW_FIELDS[cfg.flowName];
  if (!fields) throw new Error(`no fixture fields for ${cfg.flowName}`);
  const def: Definition = {
    version: 1,
    trigger: { channel: "sms", conditions: [{ type: "has_url" }] },
    steps: [
      { id: "url", type: "extract_url", saveAs: "leadUrl" },
      {
        id: "extract",
        type: "extract_text",
        fields: fields.map((name) => ({ name, description: `The ${name}` }))
      },
      {
        id: "route",
        type: "route_to_team",
        offerTemplate: "New lead {{vars.lead_phone}} — reply 1 to claim or 2 to pass.",
        ownerFallbackTemplate: "No one claimed it — back to you.",
        responseMinutes: 10
      },
      { id: "notify", type: "notify_owner", message: "Outcome: {{vars.actions_taken}}" }
    ]
  };
  parseAiFlowDefinition(def);
  return def;
}

describe("buildBadPhoneSteps", () => {
  it.each(FLOW_CONFIGS.map((c) => [c.flowName, c] as const))(
    "%s: appended steps validate against the flow's vars",
    (_name, cfg) => {
      const def = fixtureFor(cfg);
      const before = (def.steps ?? []).length;
      expect(addBadPhoneAgentReport(def, cfg)).toBe(true);
      expect((def.steps ?? []).length).toBe(before + 4);
      try {
        parseAiFlowDefinition(def);
      } catch (err) {
        const issues = err instanceof AiFlowValidationError ? err.issues.join("\n") : String(err);
        throw new Error(`${cfg.flowName} became invalid:\n${issues}`);
      }
    }
  );

  it("is idempotent — a second apply is a no-op", () => {
    const cfg = FLOW_CONFIGS[0];
    const def = fixtureFor(cfg);
    expect(addBadPhoneAgentReport(def, cfg)).toBe(true);
    const after = JSON.stringify(def);
    expect(addBadPhoneAgentReport(def, cfg)).toBe(false);
    expect(JSON.stringify(def)).toBe(after);
  });

  it("upgrades stale bp_ steps in place (replaced, never duplicated)", () => {
    const cfg = FLOW_CONFIGS[0];
    const def = fixtureFor(cfg);
    const baseCount = (def.steps ?? []).length;
    // A previously-applied older version of the patch.
    def.steps = [
      ...(def.steps ?? []),
      { id: "bp_wait", type: "wait_for_reply", phoneVar: "claimed_agent_phone" }
    ];
    expect(addBadPhoneAgentReport(def, cfg)).toBe(true);
    const ids = (def.steps ?? []).map((s) => s.id);
    expect(ids.filter((i) => i === "bp_wait")).toHaveLength(1);
    expect((def.steps ?? []).length).toBe(baseCount + 4);
    expect(() => parseAiFlowDefinition(def)).not.toThrow();
  });

  it("waits on the claimer with the ETA + 60 window and gates everything off no_reply", () => {
    const steps = buildBadPhoneSteps(FLOW_CONFIGS[0]);
    const [math, wait, classify, branch] = steps as Array<Record<string, any>>;

    expect(math).toMatchObject({
      type: "math",
      operation: "add",
      left: "{{vars.claimed_agent_eta_minutes}}",
      right: "60",
      saveAs: "report_wait_minutes"
    });
    // No `when` guard: an unclaimed run's claimed_agent_phone = "none" makes
    // the wait planner resolve straight to no_reply (no park), which the
    // classify/forward gates below turn into a fully silent path.
    expect(wait).toMatchObject({
      type: "wait_for_reply",
      phoneVar: "claimed_agent_phone",
      saveAs: "agent_report",
      timeoutMinutes: 60,
      timeoutMinutesTemplate: "{{vars.report_wait_minutes}}"
    });
    expect(wait.when).toBeUndefined();
    expect(classify).toMatchObject({
      type: "classify",
      textVar: "agent_report",
      saveAs: "agent_report_class",
      when: { var: "agent_report", notEquals: "no_reply" }
    });
    expect((classify.categories as Array<{ value: string }>).map((c) => c.value)).toEqual([
      "bad_phone_number",
      "other_update"
    ]);
    expect(branch.type).toBe("branch");
    expect(branch.branches[0].condition).toEqual({
      var: "agent_report_class",
      equals: "bad_phone_number"
    });
    // else forward (other_update + unclear) must stay silent on no_reply.
    expect(branch.else[0]).toMatchObject({
      type: "notify_owner",
      when: { var: "agent_report", notEquals: "no_reply" }
    });
  });

  /** The nested email branch inside the bad-phone arm for one config. */
  function emailBranchOf(cfg: FlowConfig): Record<string, any> {
    const branch = buildBadPhoneSteps(cfg)[3] as Record<string, any>;
    return branch.branches[0].steps[0] as Record<string, any>;
  }

  it("bad-phone arm splits on lead_email: with an address Amy's report says the lead WAS emailed", () => {
    for (const cfg of FLOW_CONFIGS) {
      const emailBranch = emailBranchOf(cfg);
      expect(emailBranch.type).toBe("branch");
      expect(emailBranch.branches[0].condition).toEqual({ var: "lead_email", contains: "@" });
      const [amyEmail, ...leadEmails] = emailBranch.branches[0].steps as Array<
        Record<string, any>
      >;
      expect(amyEmail).toMatchObject({ type: "send_email", to: "amy@amylaidlaw.com" });
      expect(amyEmail.body).toContain("{{vars.agent_report}}");
      expect(amyEmail.body).toContain("{{vars.claimed_agent}}");
      expect(amyEmail.body).toContain("HAS been emailed");
      expect(amyEmail.fromConnectionId).toBeUndefined(); // coworker mailbox, like the flows' other Amy notices
      expect(leadEmails.length).toBeGreaterThan(0);
      for (const e of leadEmails) {
        expect(e).toMatchObject({
          type: "send_email",
          to: "{{vars.lead_email}}",
          fromConnectionId: "9ddd5344-14f2-46df-a89d-dddc2d50e944"
        });
        expect(e.body).toContain("best phone number");
      }
    }
    // ReferralExchange sends the lead-type-matched intro copy.
    const re = FLOW_CONFIGS.find((c) => c.flowName === "ReferralExchange Lead")!;
    const reLeadEmails = emailBranchOf(re).branches[0].steps.slice(1) as Array<
      Record<string, any>
    >;
    expect(reLeadEmails.map((e) => e.when)).toEqual([
      { var: "lead_type", equals: "buyer" },
      { var: "lead_type", equals: "seller" },
      { var: "lead_type", equals: "both" }
    ]);
  });

  it("no email on file: Amy's report explicitly says NO follow-up email was sent", () => {
    for (const cfg of FLOW_CONFIGS) {
      const noEmailArm = emailBranchOf(cfg).else as Array<Record<string, any>>;
      expect(noEmailArm).toHaveLength(1);
      const report = noEmailArm[0];
      expect(report).toMatchObject({ type: "send_email", to: "amy@amylaidlaw.com" });
      expect(report.subject).toContain("NO EMAIL");
      expect(report.body).toContain("NO follow-up email was sent");
      expect(report.body).toContain("{{vars.agent_report}}");
      // No lead-facing email in this arm — there is no address to send to.
      expect(noEmailArm.some((s) => s.to === "{{vars.lead_email}}")).toBe(false);
    }
  });
});

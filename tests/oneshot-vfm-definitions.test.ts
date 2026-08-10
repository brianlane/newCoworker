/**
 * Regression pins for the Vantage Flow Media (VFM) second-brand rollout on
 * the KYP Ads tenant: the lead-flow builder
 * (scripts/oneshot/vfm-lead-flow-definition.ts) and the vault-content
 * builders (scripts/oneshot/vfm-brand-content.ts).
 *
 * Rules pinned here, each learned or decided the hard way:
 *  - PRICE SILENCE. VFM is testing three price points and a flow cannot
 *    know which offer a lead saw, so no flow copy and no vault line may
 *    state a management price. The vault must carry the never-quote rule.
 *  - Quiet hours: every nudge carries the US Eastern gate; the greeting,
 *    the T-60 confirmation, and the ack stay ungated (deferring a T-60
 *    check past the call time would defeat it; the KYP 2 AM incident is
 *    what the nudge gates prevent).
 *  - Bad-phone arm: guarded on lead_phone equals "none", customer sends on
 *    notEquals, so an unreachable lead is a designed path, not a dead run
 *    (the KYP Aug 1 2026 lesson).
 *  - Trigger coverage: all three Meta form names enroll, via OR'd triggers
 *    (conditions within one trigger AND together, so one trigger cannot
 *    carry them).
 *  - Email-only mode carries no roster-dependent step (a roster row cannot
 *    exist without a phone), and every teammate touch goes to the assignee
 *    email instead.
 *  - Marker idempotency: re-applying the vault sections converges instead
 *    of stacking copies.
 */
import { describe, expect, it } from "vitest";

import {
  buildVfmLeadFlowDefinition,
  VFM_FLOW_NAME,
  VFM_FORM_NAMES,
  VFM_QUIET_HOURS,
  VFM_PARSER_AGENT_INSTRUCTIONS,
  type VfmFlowOptions
} from "../scripts/oneshot/vfm-lead-flow-definition";
import {
  applyMarkedSection,
  buildVfmIdentitySection,
  buildVfmSoulSection,
  VFM_BOOKING_LINK,
  VFM_IDENTITY_START,
  VFM_IDENTITY_END,
  VFM_SOUL_START,
  VFM_SOUL_END
} from "../scripts/oneshot/vfm-brand-content";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";

type StepJson = {
  id?: string;
  type?: string;
  to?: string;
  toAgentName?: string;
  body?: string;
  subject?: string;
  agentName?: string;
  when?: { var?: string; equals?: string; notEquals?: string };
  quietHours?: { timezone?: string; noSendAfter?: string; resumeAt?: string };
  relativeToTemplate?: string;
  offsetMinutes?: number;
  minutes?: number;
  addTags?: string[];
  input?: string;
};

type DefinitionJson = {
  trigger: { channel: string; conditions: Array<{ type: string; value: string }> };
  triggers?: Array<{ channel: string; conditions: Array<{ type: string; value: string }> }>;
  steps: StepJson[];
};

const PARSER_ID = "00000000-0000-0000-0000-000000000000";
const ROSTER_OPTS: VfmFlowOptions = {
  assigneeName: "Liz",
  assigneeEmail: "assignee@example.com",
  emailOnly: false,
  parserAgentId: PARSER_ID
};
const EMAIL_OPTS: VfmFlowOptions = {
  assigneeEmail: "assignee@example.com",
  emailOnly: true,
  parserAgentId: PARSER_ID
};

const rosterDef = buildVfmLeadFlowDefinition(ROSTER_OPTS) as unknown as DefinitionJson;
const emailDef = buildVfmLeadFlowDefinition(EMAIL_OPTS) as unknown as DefinitionJson;

const byId = (def: DefinitionJson, id: string): StepJson | undefined =>
  def.steps.find((s) => s.id === id);

/** Literal expected gate, independent of the exported constant. */
const EXPECTED_QUIET_HOURS = {
  timezone: "America/New_York",
  noSendAfter: "20:00",
  resumeAt: "09:00"
};

describe("VFM lead-flow definition", () => {
  it("validates as a well-formed AiFlow definition in both modes", () => {
    expect(() => parseAiFlowDefinition(rosterDef)).not.toThrow();
    expect(() => parseAiFlowDefinition(emailDef)).not.toThrow();
  });

  it("covers all three Meta form names via OR'd webhook triggers", () => {
    for (const def of [rosterDef, emailDef]) {
      const all = [def.trigger, ...(def.triggers ?? [])];
      const values = all.map((t) => {
        expect(t.channel).toBe("webhook");
        expect(t.conditions).toHaveLength(1);
        return t.conditions[0].value;
      });
      expect(values).toEqual([...VFM_FORM_NAMES]);
    }
    // The third form name shares no substring with the first two; a single
    // "VFM" contains-condition would silently drop it.
    expect(VFM_FORM_NAMES[2].includes("VFM")).toBe(false);
  });

  it("never states a management price anywhere in the flow copy", () => {
    for (const def of [rosterDef, emailDef]) {
      const rendered = JSON.stringify(def);
      expect(rendered).not.toMatch(/\$\s?\d/);
      expect(rendered).not.toMatch(/\b(100|150|200)\s*(\/|per)\s*week/i);
      expect(rendered).not.toMatch(/\bper channel\b/i);
    }
  });

  it("gates every nudge on US Eastern quiet hours and keeps first touch, ack and T-60 ungated", () => {
    expect(VFM_QUIET_HOURS).toEqual(EXPECTED_QUIET_HOURS);
    for (const def of [rosterDef, emailDef]) {
      for (const id of ["s_nudge_1", "s_nudge_2"]) {
        expect(byId(def, id)?.quietHours).toEqual(EXPECTED_QUIET_HOURS);
      }
      for (const id of ["s_greet", "s_ack", "s_confirm"]) {
        expect(byId(def, id)?.quietHours).toBeUndefined();
      }
    }
  });

  it("keeps the bad-phone arm designed: alert + lead email on none, customer sends on notEquals", () => {
    for (const def of [rosterDef, emailDef]) {
      expect(byId(def, "s_bad_phone_alert")?.when).toEqual({ var: "lead_phone", equals: "none" });
      expect(byId(def, "s_bad_phone_email")?.when).toEqual({ var: "lead_phone", equals: "none" });
      expect(byId(def, "s_bad_phone_email")?.body).toContain(VFM_BOOKING_LINK);
      for (const id of ["s_delay", "s_greet", "s_wait_1"]) {
        expect(byId(def, id)?.when).toEqual({ var: "lead_phone", notEquals: "none" });
      }
    }
  });

  it("waits 5 minutes before the booking link, per the owner's spec", () => {
    for (const def of [rosterDef, emailDef]) {
      expect(byId(def, "s_delay")?.minutes).toBe(5);
      expect(byId(def, "s_greet")?.body).toContain(VFM_BOOKING_LINK);
    }
  });

  it("tags the contact VFM at intake and Inactive when the ladder runs dry", () => {
    for (const def of [rosterDef, emailDef]) {
      expect(byId(def, "s_tag")?.addTags).toEqual(["VFM"]);
      expect(byId(def, "s_mark_inactive")?.addTags).toEqual(["Inactive"]);
      expect(byId(def, "s_mark_inactive")?.when).toEqual({ var: "reply_3", equals: "no_reply" });
    }
  });

  it("anchors the confirmation at T-60 from the parsed reply time, gated on a known time", () => {
    for (const def of [rosterDef, emailDef]) {
      const parse = byId(def, "s_parse_time");
      expect(parse?.type).toBe("run_agent");
      // Relative phrases ("Tuesday 2pm") need a date anchor.
      expect(parse?.input).toContain("{{now.today.iso}}");
      const sleep = byId(def, "s_sleep_t60");
      expect(sleep?.relativeToTemplate).toBe("{{vars.call_time}}");
      expect(sleep?.offsetMinutes).toBe(-60);
      for (const id of ["s_ack", "s_sleep_t60", "s_confirm", "s_confirm_wait", "s_outcome"]) {
        expect(byId(def, id)?.when).toEqual({ var: "call_time", notEquals: "none" });
      }
      // The owner's framing must survive copy edits.
      expect(byId(def, "s_confirm")?.body).toMatch(/limited number of new accounts/i);
    }
  });

  it("roster mode pins the assignee; email-only mode has no roster-dependent step", () => {
    const route = byId(rosterDef, "s_route");
    expect(route?.type).toBe("route_to_team");
    expect(route?.agentName).toBe("Liz");
    expect(byId(rosterDef, "s_outcome")?.toAgentName).toBe("Liz");

    const emailRendered = JSON.stringify(emailDef);
    expect(emailRendered).not.toContain("route_to_team");
    expect(emailRendered).not.toContain("toAgentName");
    for (const id of ["s_fyi", "s_final_flag", "s_outcome", "s_bad_phone_alert"]) {
      const step = byId(emailDef, id);
      expect(step?.type).toBe("send_email");
      expect(step?.to).toBe("assignee@example.com");
    }
  });

  it("parser contract: single line, ISO with US Eastern offset, or the exact token none", () => {
    expect(VFM_PARSER_AGENT_INSTRUCTIONS).toContain("ISO");
    expect(VFM_PARSER_AGENT_INSTRUCTIONS).toContain("US Eastern");
    expect(VFM_PARSER_AGENT_INSTRUCTIONS).toContain("exactly: none");
    expect(VFM_PARSER_AGENT_INSTRUCTIONS).toContain("single line");
  });

  it("uses no em dash anywhere in flow copy or the flow name", () => {
    expect(JSON.stringify(rosterDef)).not.toContain("—");
    expect(JSON.stringify(emailDef)).not.toContain("—");
    expect(VFM_FLOW_NAME).not.toContain("—");
  });
});

describe("VFM vault content", () => {
  const identity = buildVfmIdentitySection();
  const soul = buildVfmSoulSection();

  it("identity carries the booking link, the ad-spend floor, and the never-quote rule", () => {
    expect(identity).toContain(VFM_BOOKING_LINK);
    expect(identity).toContain("$30/day");
    expect(identity).toMatch(/never state, estimate,\s+confirm, or compare/i);
    // The tested management price points must NOT be written anywhere the
    // model could quote them from.
    expect(identity).not.toMatch(/\$\s?(100|150|200)\b/);
  });

  it("soul forbids asking which business and cross-mentioning brands", () => {
    expect(soul).toMatch(/Do NOT ask which business/);
    expect(soul).toMatch(/Never mention the other business/);
  });

  it("contains no em dash", () => {
    expect(identity).not.toContain("—");
    expect(soul).not.toContain("—");
  });

  it("applyMarkedSection is idempotent and preserves surrounding content", () => {
    const base = "# Existing KYP identity\n\nKYP facts stay untouched.\n";
    const once = applyMarkedSection(base, VFM_IDENTITY_START, VFM_IDENTITY_END, identity);
    const twice = applyMarkedSection(once, VFM_IDENTITY_START, VFM_IDENTITY_END, identity);
    expect(twice).toBe(once);
    expect(once).toContain("KYP facts stay untouched.");
    expect(once).toContain(VFM_IDENTITY_START);
    expect(once).toContain(VFM_IDENTITY_END);
  });

  it("applyMarkedSection replaces a stale section instead of stacking", () => {
    const stale = applyMarkedSection("", VFM_SOUL_START, VFM_SOUL_END, "old content");
    const fresh = applyMarkedSection(stale, VFM_SOUL_START, VFM_SOUL_END, soul);
    expect(fresh).not.toContain("old content");
    expect(fresh.split(VFM_SOUL_START)).toHaveLength(2);
  });

  it("applyMarkedSection appends to an empty document", () => {
    const out = applyMarkedSection("", VFM_IDENTITY_START, VFM_IDENTITY_END, identity);
    expect(out.startsWith(VFM_IDENTITY_START)).toBe(true);
  });
});

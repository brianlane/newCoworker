import { describe, it, expect } from "vitest";
import {
  ALERT_MESSAGE,
  COUNT_VAR,
  FEEDBACK_NEEDLE,
  FEEDBACK_SENDER,
  LINK_VAR,
  NAME_VAR,
  STEP_DETAILS,
  STEP_NOTIFY,
  STEP_URL,
  buildDefinition
} from "../scripts/oneshot/amy-homelight-feedback-request-definition";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";

/**
 * Pins the flow that finally owns HomeLight's feedback number.
 *
 * On 2026-08-07 that number reached the general assistant, which answered
 * HomeLight's autoresponder, addressed it as "Aaron", and traded 30 messages
 * over 16 minutes. The only reason Aug 13 did not repeat it is PR #1239's
 * robot-loop cap. A named owner plus `suppressDefaultReply` is the actual fix.
 */

/** The real nudge, quoted from `sms_inbound_jobs` (2026-08-13). */
const NUDGE =
  "Great job connecting with Nicole! You have 2 referrals that are pending your feedback. " +
  "Let HomeLight know how we can improve your referral quality.\n\nhttps://hmlt.co/26cefca0";

function conditions(def = buildDefinition()) {
  return (def.trigger as { conditions: Array<{ type: string; value?: string }> }).conditions;
}

describe("trigger", () => {
  it("claims the number that has been unowned since Aug 7", () => {
    expect(conditions().find((c) => c.type === "from_matches")?.value).toBe(FEEDBACK_SENDER);
    expect(FEEDBACK_SENDER).toBe("4155491442");
  });

  it("matches the real nudge", () => {
    const needles = conditions().filter((c) => c.type === "contains");
    expect(needles).toHaveLength(1);
    for (const n of needles) expect(NUDGE.toLowerCase()).toContain(String(n.value).toLowerCase());
  });

  it("anchors on the ask, not the templated greeting", () => {
    // "Great job connecting with <Name>!" changes per lead, and HomeLight has
    // reworded surrounding copy before. "pending your feedback" is the part
    // that states what the message wants.
    expect(FEEDBACK_NEEDLE).toBe("pending your feedback");
    expect(FEEDBACK_NEEDLE).not.toMatch(/great job|connecting with/i);
    expect(FEEDBACK_NEEDLE.length).toBeLessThanOrEqual(30);
  });

  it("requires a url, since the alert is worthless without the link", () => {
    expect(conditions().some((c) => c.type === "has_url")).toBe(true);
  });
});

describe("the flow answers nobody", () => {
  it("suppresses the default reply, which is the whole fix", () => {
    const opts = (buildDefinition() as { options?: Record<string, unknown> }).options;
    expect(opts?.suppressDefaultReply).toBe(true);
  });

  it("sends no SMS to the trigger number", () => {
    const json = JSON.stringify(buildDefinition());
    expect(json).not.toContain("send_sms");
    expect(json).not.toContain("{{trigger.from}}");
  });

  it("writes nothing to HomeLight", () => {
    // Deliberate: HomeLight's feedback prompt asks for a subjective REFERRAL
    // QUALITY rating, which shapes the referrals Amy is sent next. A canned
    // automated answer is worth less to her than her own, and could degrade
    // her lead flow. The factual stage update is a separate surface.
    const json = JSON.stringify(buildDefinition());
    expect(json).not.toContain("browse_action");
    expect(json).not.toContain("browse_extract");
  });
});

describe("the alert Amy receives", () => {
  it("carries the link, the count and the name", () => {
    expect(ALERT_MESSAGE).toContain(`{{vars.${LINK_VAR}}}`);
    expect(ALERT_MESSAGE).toContain(`{{vars.${COUNT_VAR}}}`);
    expect(ALERT_MESSAGE).toContain(`{{vars.${NAME_VAR}}}`);
  });

  it("tells her plainly that the assistant did not answer for her", () => {
    expect(ALERT_MESSAGE).toMatch(/has not replied/i);
  });

  it("says why it is worth her own time", () => {
    expect(ALERT_MESSAGE).toMatch(/shape the referrals/i);
  });
});

describe("shape", () => {
  it("produces the three steps in the order the vars require", () => {
    const ids = buildDefinition().steps.map((s) => s.id);
    expect(ids).toEqual([STEP_URL, STEP_DETAILS, STEP_NOTIFY]);
  });

  it("produces every var before the step that renders it", () => {
    const ids = buildDefinition().steps.map((s) => s.id);
    expect(ids.indexOf(STEP_URL)).toBeLessThan(ids.indexOf(STEP_NOTIFY));
    expect(ids.indexOf(STEP_DETAILS)).toBeLessThan(ids.indexOf(STEP_NOTIFY));
  });

  it("passes the authoring validator the dashboard and CRUD API use", () => {
    expect(() => parseAiFlowDefinition(buildDefinition())).not.toThrow();
  });

  it("stays valid with overridden sender and needle", () => {
    const def = buildDefinition({ sender: "5550001111", needle: "needs your rating" });
    expect(() => parseAiFlowDefinition(def)).not.toThrow();
    expect(conditions(def).find((c) => c.type === "from_matches")?.value).toBe("5550001111");
  });

  it("is deterministic, so a re-seed produces an identical definition", () => {
    expect(buildDefinition()).toEqual(buildDefinition());
  });
});

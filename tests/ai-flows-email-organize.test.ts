import { describe, expect, it } from "vitest";
import { parseAiFlowDefinition, AiFlowValidationError } from "@/lib/ai-flows/schema";
import { scrubDefinition } from "@/lib/ai-flows/scrub";
import { planStep } from "../supabase/functions/_shared/ai_flows/steps";
import { simulateTestAction } from "../supabase/functions/_shared/ai_flows/test_mode";
import type { FlowStep } from "../supabase/functions/_shared/ai_flows/types";
import type { StepAction } from "../supabase/functions/_shared/ai_flows/steps";

const CONN = "16cff2b9-b4d3-421c-b25d-b40edd80c9a8";

describe("email_organize schema + planner", () => {
  it("parses a tenant-mailbox organize step", () => {
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "tenant_email", conditions: [] },
      steps: [
        {
          id: "org1",
          type: "email_organize",
          archive: true,
          markRead: true,
          addLabels: ["Sales"]
        }
      ]
    });
    expect(def.steps[0]).toMatchObject({
      type: "email_organize",
      archive: true,
      markRead: true,
      addLabels: ["Sales"]
    });
  });

  it("rejects a step with no actions", () => {
    expect(() =>
      parseAiFlowDefinition({
        version: 1,
        trigger: { channel: "tenant_email", conditions: [] },
        steps: [{ id: "org1", type: "email_organize" }]
      })
    ).toThrow(AiFlowValidationError);
  });

  it("rejects markRead+markUnread and archive+unarchive conflicts", () => {
    expect(() =>
      parseAiFlowDefinition({
        version: 1,
        trigger: { channel: "tenant_email", conditions: [] },
        steps: [{ id: "org1", type: "email_organize", markRead: true, markUnread: true }]
      })
    ).toThrow(AiFlowValidationError);
    expect(() =>
      parseAiFlowDefinition({
        version: 1,
        trigger: { channel: "tenant_email", conditions: [] },
        steps: [{ id: "org1", type: "email_organize", archive: true, unarchive: true }]
      })
    ).toThrow(AiFlowValidationError);
  });

  it("plans message id and email_log_id from the trigger scope", () => {
    const plan = planStep(
      {
        id: "org1",
        type: "email_organize",
        archive: true,
        addLabels: ["{{vars.bucket}}"]
      } as FlowStep,
      {
        vars: { bucket: "Billing" },
        trigger: {
          channel: "tenant_email",
          windowText: "hi",
          url: null,
          from: "a@b.com",
          message_id: "rfc-123",
          email_log_id: "00000000-0000-4000-8000-000000000099"
        }
      }
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.action).toMatchObject({
      kind: "email_organize",
      messageId: "rfc-123",
      emailLogId: "00000000-0000-4000-8000-000000000099",
      archive: true,
      addLabels: ["Billing"]
    });
  });

  it("carries `trash` from the authored step into the planned action", () => {
    /**
     * The producer end of the trash plumbing. A `trash` that validates at
     * authoring but never reaches the action is the exact shape that let
     * `message_ref` ship emitted-but-unreferenceable: the schema accepts it,
     * the gateway handles it, and the planner in between quietly drops it, so
     * the flow files the mail and never bins it.
     */
    const plan = planStep(
      {
        id: "org1",
        type: "email_organize",
        markRead: true,
        addLabels: ["HQ/Automated"],
        trash: true
      } as FlowStep,
      {
        vars: {},
        trigger: {
          channel: "email",
          windowText: "hi",
          url: null,
          from: "noreply@zapier.com",
          message_id: "rfc-zap"
        }
      }
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.action).toMatchObject({
      kind: "email_organize",
      messageId: "rfc-zap",
      markRead: true,
      addLabels: ["HQ/Automated"],
      trash: true
    });
  });

  it("carries `star` and `unstar` from the authored step into the planned action", () => {
    /**
     * Same seam as `trash`: valid at authoring, handled at the gateway, and
     * dropped by the planner in between would mean the receipt is labelled and
     * never starred, with the step still reporting success.
     */
    for (const flag of ["star", "unstar"] as const) {
      const plan = planStep(
        { id: "org1", type: "email_organize", [flag]: true } as unknown as FlowStep,
        {
          vars: {},
          trigger: {
            channel: "email",
            windowText: "hi",
            url: null,
            from: "invoice@vercel.com",
            message_id: "rfc-r"
          }
        }
      );
      expect(plan.ok, flag).toBe(true);
      if (!plan.ok) return;
      expect(plan.action, flag).toMatchObject({ kind: "email_organize", [flag]: true });
    }
  });

  it("omits `star` when the step did not ask for it", () => {
    const plan = planStep(
      { id: "org1", type: "email_organize", markRead: true } as FlowStep,
      {
        vars: {},
        trigger: { channel: "email", windowText: "hi", url: null, from: "a@b.c", message_id: "m" }
      }
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.action).not.toHaveProperty("star");
    expect(plan.action).not.toHaveProperty("unstar");
  });

  it("omits `trash` entirely when the step did not ask for it", () => {
    // Never a literal false: the gateway treats presence as intent, and a
    // stray `trash: false` on every organize action is one refactor away from
    // binning mail nobody asked to bin.
    const plan = planStep(
      { id: "org1", type: "email_organize", archive: true } as FlowStep,
      {
        vars: {},
        trigger: { channel: "email", windowText: "hi", url: null, from: "a@b.com", message_id: "m" }
      }
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.action).not.toHaveProperty("trash");
  });

  it("accepts a trash-only step at authoring, since trash IS an action", () => {
    expect(() =>
      parseAiFlowDefinition({
        version: 1,
        trigger: { channel: "tenant_email", conditions: [] },
        steps: [{ id: "org1", type: "email_organize", trash: true }]
      })
    ).not.toThrow();
  });

  it("falls back to trigger.connection_id on connected email triggers", () => {
    const plan = planStep(
      {
        id: "org1",
        type: "email_organize",
        archive: true
      } as FlowStep,
      {
        vars: {},
        trigger: {
          channel: "email",
          windowText: "hi",
          url: null,
          from: "a@b.com",
          message_id: "gmail-1",
          connection_id: CONN
        }
      }
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.action).toMatchObject({
      kind: "email_organize",
      messageId: "gmail-1",
      connectionId: CONN,
      archive: true
    });
  });

  it("plans with empty message id when tenant email_log_id is present", () => {
    const plan = planStep(
      {
        id: "org1",
        type: "email_organize",
        messageIdTemplate: "{{vars.missing}}",
        markRead: true
      } as FlowStep,
      {
        vars: {},
        trigger: {
          channel: "tenant_email",
          email_log_id: "00000000-0000-4000-8000-000000000099"
        }
      }
    );
    expect(plan.ok).toBe(true);
  });

  it("fails when connected mailbox has no message id", () => {
    const plan = planStep(
      {
        id: "org1",
        type: "email_organize",
        connectionId: CONN,
        messageIdTemplate: "{{vars.missing}}",
        markRead: true
      } as FlowStep,
      { vars: {}, trigger: { channel: "email" } }
    );
    expect(plan).toEqual({
      ok: false,
      error: "email_organize: message id is empty after templating"
    });
  });

  it("fails tenant path when message id and email_log_id are both missing", () => {
    const plan = planStep(
      {
        id: "org1",
        type: "email_organize",
        messageIdTemplate: "{{vars.missing}}",
        markRead: true
      } as FlowStep,
      { vars: {}, trigger: { channel: "tenant_email" } }
    );
    expect(plan.ok).toBe(false);
  });

  it("scrubs connectionId from library copies", () => {
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "tenant_email", conditions: [] },
      steps: [
        {
          id: "org1",
          type: "email_organize",
          connectionId: CONN,
          archive: true
        }
      ]
    });
    const scrubbed = scrubDefinition(def) as {
      steps: Array<{ type: string; connectionId?: string }>;
    };
    const step = scrubbed.steps[0];
    expect(step.type).toBe("email_organize");
    expect(step.connectionId).toBeUndefined();
  });

  it("simulates in test mode", () => {
    const action = {
      kind: "email_organize",
      messageId: "m1",
      connectionId: CONN,
      archive: true,
      markRead: true
    } as StepAction;
    expect(simulateTestAction(action, { vars: {} })).toMatchObject({
      simulated: "email_organize",
      messageId: "m1",
      archive: true,
      markRead: true
    });
    expect(
      simulateTestAction(
        { kind: "email_organize", messageId: "m2" } as StepAction,
        { vars: {} }
      )
    ).toMatchObject({
      simulated: "email_organize",
      connectionId: null,
      archive: false,
      markRead: false
    });
  });

  it("plans removeLabels and moveToFolder templates", () => {
    const plan = planStep(
      {
        id: "org1",
        type: "email_organize",
        connectionId: CONN,
        removeLabels: ["{{vars.old}}"],
        moveToFolder: "{{vars.folder}}",
        unarchive: true,
        markUnread: true
      } as FlowStep,
      {
        vars: { old: "Stale", folder: "Inbox" },
        trigger: { message_id: "m9" }
      }
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.action).toMatchObject({
      kind: "email_organize",
      connectionId: CONN,
      removeLabels: ["Stale"],
      moveToFolder: "Inbox",
      unarchive: true,
      markUnread: true
    });
  });
});

describe("email_organize importanceTemplate: producer end", () => {
  /**
   * Asserted at the PLANNER, not on a hand-built action. The schema accepting a
   * field and the gateway handling it buy nothing if the planner in between
   * drops it, which is exactly how `message_ref` shipped
   * emitted-but-unreferenceable.
   */
  const scope = (vars: Record<string, string>) => ({
    vars,
    trigger: {
      channel: "email" as const,
      windowText: "hi",
      url: null,
      from: "a@b.com",
      message_id: "gmail-1",
      email_log_id: "00000000-0000-4000-8000-000000000099"
    }
  });

  it("renders the score and carries it onto the action", () => {
    const plan = planStep(
      {
        id: "org1",
        type: "email_organize",
        addLabels: ["HQ/Automated"],
        importanceTemplate: "{{vars.email_importance}}"
      } as FlowStep,
      scope({ email_importance: "6" })
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    // Carried as TEXT, unparsed: the gateway owns the 1-10 rule so it lives in
    // one place next to the column's check constraint.
    expect(plan.action).toMatchObject({ kind: "email_organize", importanceText: "6" });
  });

  it("passes prose straight through for the gateway to reject", () => {
    const plan = planStep(
      {
        id: "org1",
        type: "email_organize",
        addLabels: ["HQ/Automated"],
        importanceTemplate: "{{vars.email_importance}}"
      } as FlowStep,
      scope({ email_importance: "high" })
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.action).toMatchObject({ importanceText: "high" });
  });

  it("omits the key when the var rendered empty, rather than sending a blank", () => {
    // An unset var collapses to "". Sending importanceText:"" would ask the
    // gateway to score the message null, wiping any score already there; the
    // step never asked for that, so the key must simply not be present.
    const plan = planStep(
      {
        id: "org1",
        type: "email_organize",
        addLabels: ["HQ/Automated"],
        importanceTemplate: "{{vars.email_importance}}"
      } as FlowStep,
      scope({})
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.action).not.toHaveProperty("importanceText");
  });

  it("omits the key when the step never asked for a score", () => {
    const plan = planStep(
      { id: "org1", type: "email_organize", addLabels: ["HQ/Automated"] } as FlowStep,
      scope({ email_importance: "6" })
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.action).not.toHaveProperty("importanceText");
  });
});

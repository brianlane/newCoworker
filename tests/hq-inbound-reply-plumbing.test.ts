/**
 * The plumbing the James/King reply needs, and does not have.
 *
 * tests/e2e/hq-intro-reply.e2e.test.ts proves the MODEL can write Brian's
 * reply. That was never the blocker. The blocker is that nothing can deliver
 * what it writes:
 *
 *   1. An inbound email's thread identity is thrown away. `email_log` keeps a
 *      provider message id and nothing else, so there is no thread id and no
 *      RFC Message-Id to reply against.
 *   2. No flow step can send a reply. `send_email` always starts a new
 *      conversation; `sendFromMailboxConnection` accepts a `thread` argument
 *      that nothing outside the email coworker ever populates.
 *   3. The approval gate is digit-only, so the way Brian actually answers
 *      ("yes but shorter, drop the second paragraph") falls through it.
 *
 * These are hermetic on purpose. tests/e2e has no database and no send
 * interception, so the threading contract cannot be asserted there.
 */
import { describe, expect, it } from "vitest";

import { emailTriggerScope } from "@/lib/ai-flows/trigger-eval";
import { parseAiFlowDefinition, type AiFlowDefinition } from "@/lib/ai-flows/schema";
import { planStep } from "../supabase/functions/_shared/ai_flows/steps";
import {
  approvalOptionForReply,
  type ApprovalGateOption
} from "../supabase/functions/_shared/ai_flows/approval_options";
import type { FlowStep } from "../supabase/functions/_shared/ai_flows/types";

const CONNECTION = "16cff2b9-b4d3-421c-b25d-b40edd80c9a8";

describe("inbound email keeps the identity a reply needs", () => {
  it("exposes the RFC Message-Id as {{trigger.message_ref}}", () => {
    // threadId arrived in #1185. The Message-Id is the other half: Gmail
    // files by threadId, but In-Reply-To/References carry this, and a strict
    // client on a long thread needs them to nest the reply correctly.
    const scope = emailTriggerScope({
      id: "m1",
      fromEmail: "james@kypads.com",
      subject: "Introductions",
      bodyText: "Brian, King - connecting you two.",
      threadId: "199abc4d5e6f7890",
      messageRef: "<CAJ=intro@mail.gmail.com>"
    });
    expect(scope.thread_id).toBe("199abc4d5e6f7890");
    expect(scope.message_ref).toBe("<CAJ=intro@mail.gmail.com>");
  });

  it("lets a flow actually TEMPLATE the fields it emits", () => {
    // Emitting a trigger field at run time without allowlisting it in
    // TRIGGER_SCOPE_KEYS means every flow that references it is rejected at
    // authoring. That gap is exactly why the HQ flow paid a model call to
    // re-derive a subject already in scope (fixed in #1185), and the first
    // draft of THIS change reintroduced it for message_ref. Asserting the
    // emission alone does not catch it; authoring a flow that uses it does.
    for (const field of ["message_ref", "thread_id", "message_id", "email_log_id"]) {
      expect(() =>
        parseAiFlowDefinition({
          version: 1,
          trigger: { channel: "email", connectionId: CONNECTION, conditions: [] },
          steps: [{ id: "a", type: "notify_owner", message: `Mail: {{trigger.${field}}}` }]
        })
      , `{{trigger.${field}}} must be authorable`).not.toThrow();
    }
  });

  it("OMITS message_ref rather than emitting an empty one", () => {
    // Same rule as thread_id: a blank identifier must not look like a real
    // one, or a reply would be threaded against nothing.
    const scope = emailTriggerScope({
      id: "m2",
      fromEmail: "a@b.c",
      subject: "s",
      bodyText: "body"
    });
    expect("message_ref" in scope).toBe(false);
  });
});

describe("a flow can send a reply, not just a new conversation", () => {
  function definitionWith(step: Record<string, unknown>): AiFlowDefinition {
    return parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "email", connectionId: CONNECTION, conditions: [] },
      steps: [step]
    });
  }

  it("accepts replyToEmailLogId on send_email", () => {
    const def = definitionWith({
      id: "s_reply",
      type: "send_email",
      to: "{{trigger.from}}",
      subject: "Re: {{trigger.subject}}",
      body: "Thanks for connecting us!",
      replyToEmailLogId: "{{trigger.email_log_id}}"
    });
    expect(def.steps[0]).toMatchObject({ replyToEmailLogId: "{{trigger.email_log_id}}" });
  });

  it("carries the resolved email_log id onto the planned action", () => {
    // The worker needs the RESOLVED id to load the row and build the thread
    // argument; a template that reaches the executor unrendered is a bug.
    const step: FlowStep = {
      id: "s_reply",
      type: "send_email",
      to: "{{trigger.from}}",
      subject: "Re: {{trigger.subject}}",
      body: "Thanks for connecting us!",
      replyToEmailLogId: "{{trigger.email_log_id}}"
    } as FlowStep;
    const planned = planStep(step, {
      vars: {},
      trigger: {
        from: "james@kypads.com",
        subject: "Introductions",
        email_log_id: "8f3a5c21-0000-4000-8000-000000000001"
      }
    });
    expect(planned.ok).toBe(true);
    expect(planned.ok && planned.action).toMatchObject({
      kind: "send_email",
      replyToEmailLogId: "8f3a5c21-0000-4000-8000-000000000001"
    });
  });
});

describe("the approval gate takes the answer Brian actually sends", () => {
  const OFFERED: ApprovalGateOption[] = ["approve", "skip", "cancel"];

  it("still resolves a bare digit exactly as before", () => {
    // Guards the regression the modify branch could cause: the digit
    // vocabulary is globally ordered and must not shift underneath it.
    expect(approvalOptionForReply(OFFERED, "1")).toBe("approve");
    expect(approvalOptionForReply(OFFERED, "2")).toBe("skip");
    expect(approvalOptionForReply(OFFERED, "3")).toBe("cancel");
    expect(approvalOptionForReply(OFFERED, "9")).toBeNull();
  });

  it("accepts allowModify on an approval_gate step", () => {
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "email", connectionId: CONNECTION, conditions: [] },
      steps: [
        // The real shape: the drafter is the rewind target.
        {
          id: "s_draft",
          type: "run_agent",
          agentId: "3f7a1c90-1111-4111-8111-2c4e8b1f6a37",
          input: "{{trigger.windowText}}",
          saveAs: "email_draft"
        },
        {
          id: "s_gate",
          type: "approval_gate",
          prompt: "Send this reply?",
          allowModify: { redraftStepId: "s_draft" }
        }
      ]
    });
    expect(def.steps[1]).toMatchObject({ allowModify: { redraftStepId: "s_draft" } });
  });

  it("rejects an allowModify pointing at a step that does not exist", () => {
    // A rewind target that is not in the flow would park the run forever.
    expect(() =>
      parseAiFlowDefinition({
        version: 1,
        trigger: { channel: "email", connectionId: CONNECTION, conditions: [] },
        steps: [
          {
            id: "s_gate",
            type: "approval_gate",
            prompt: "Send this reply?",
            allowModify: { redraftStepId: "s_nope" }
          }
        ]
      })
    ).toThrow();
  });
});

describe("the modify loop is authorable end to end", () => {
  it("lets the redraft step read the owner's own words", () => {
    // The whole point of rewinding is that the drafting step acts on what the
    // owner said. {{vars.approval_note}} is engine-provided, so the flow can
    // reference it without an earlier step producing it.
    const def = parseAiFlowDefinition({
      version: 1,
      trigger: { channel: "email", connectionId: CONNECTION, conditions: [] },
      steps: [
        {
          id: "s_draft",
          type: "run_agent",
          agentId: "3f7a1c90-1111-4111-8111-2c4e8b1f6a37",
          input: "{{trigger.windowText}}\n\nOwner's changes: {{vars.approval_note}}",
          saveAs: "email_draft"
        },
        {
          id: "s_gate",
          type: "approval_gate",
          prompt: "Send this reply?",
          allowModify: { redraftStepId: "s_draft" }
        },
        {
          id: "s_send",
          type: "send_email",
          to: "{{trigger.from}}",
          subject: "Re: {{trigger.subject}}",
          body: "{{vars.email_draft}}",
          replyToEmailLogId: "{{trigger.email_log_id}}"
        }
      ]
    });
    expect(def.steps).toHaveLength(3);
  });
});

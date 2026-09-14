import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Source pins for the webhook's persist-before-eval order.
 *
 * HomeLight (2026-09-13, Sonia R.): the warm-transfer alert and the hmlt.co
 * URL arrived 35ms apart. Each webhook evaluated triggers BEFORE inserting
 * sms_inbound_jobs, so neither SMS saw the other. The AND of has_url plus
 * `New HomeLight (Referral|Warm Transfer)` failed both times. Sixteen seconds
 * later the withdrawal text correlated against both prior jobs and started
 * the run. The webhook is Deno-side and outside tsc/coverage, so these pins
 * guard the structural claims.
 */
const webhook = readFileSync("supabase/functions/telnyx-sms-inbound/index.ts", "utf8");

describe("persist inbound before AiFlow trigger eval", () => {
  it("inserts the pending job before evaluateAndEnqueueAiFlows on the main path", () => {
    const persistComment = webhook.indexOf(
      'Persist the inbound job BEFORE wait-resume / trigger evaluation'
    );
    expect(persistComment).toBeGreaterThan(-1);
    const pending = webhook.indexOf('status: "pending"', persistComment);
    const evaluate = webhook.indexOf("await evaluateAndEnqueueAiFlows", persistComment);
    expect(pending).toBeGreaterThan(persistComment);
    expect(evaluate).toBeGreaterThan(pending);
    expect(webhook.slice(persistComment, persistComment + 400)).toContain("35ms");
  });

  it("does not return early on a 23505 from that persist (a crash between insert and eval must not drop the lead)", () => {
    const persistComment = webhook.indexOf(
      "Persist the inbound job BEFORE wait-resume / trigger evaluation"
    );
    const pendingBlock = webhook.slice(
      persistComment,
      webhook.indexOf("await evaluateAndEnqueueAiFlows", persistComment)
    );
    expect(pendingBlock).toContain('code !== "23505"');
    expect(pendingBlock).toContain('return new Response("Queue error"');
    expect(pendingBlock).not.toMatch(/if \(persistErr\) \{\s*console\.error\("sms queue insert"/);
  });

  it("skips appending the current inbound when the just-persisted job already has the same text", () => {
    expect(webhook).toContain("lastFromSender.text !== current.text");
    expect(webhook).toContain(
      "The webhook persists the job BEFORE evaluation so a sibling"
    );
  });

  it("skips enqueue when an active run already carries this trigger URL", () => {
    expect(webhook).toContain('from "../_shared/ai_flows/trigger_url_dedupe.ts"');
    expect(webhook).toContain("findActiveRunWithTriggerUrl(supabase, { businessId, flowId: m.id, url: m.url })");
  });

  it("Safe Mode also persists before evaluate so a forwarded lead can still correlate", () => {
    const smPersist = webhook.indexOf("Persist FIRST so a sibling");
    expect(smPersist).toBeGreaterThan(-1);
    const smEval = webhook.indexOf("await evaluateAndEnqueueAiFlows", smPersist);
    expect(smEval).toBeGreaterThan(smPersist);
    const smReturn = webhook.indexOf('skip: "safe_mode_forwarded"', smEval);
    expect(smReturn).toBeGreaterThan(smEval);
  });
});

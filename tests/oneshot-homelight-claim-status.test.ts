import { describe, expect, it } from "vitest";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import {
  CLAIMING_LINE,
  FALSE_CALL_LINE,
  MAX_AWAIT_MINUTES,
  OFFER_STEP_ID,
  patchDefinition,
  WAIT_STEP_ID
} from "../scripts/oneshot/homelight-claim-status-honesty";

/**
 * homelight-claim-status-honesty.ts.
 *
 * Amy C., 2026-08-14. The flow clicked "Call me to claim referral" at
 * 08:09:51 and waited 3 minutes for HomeLight to call back. HomeLight called
 * at 10:26, 137 minutes later. The step recorded `no_call` and the run
 * carried on telling everyone the referral was claimed: the teammate got
 * "HomeLight lead is yours" and the owner got "HomeLight referral claimed by
 * Gabrielle Mota", while the saved portal HTML from that same minute still
 * showed the unclicked "Call me to claim referral" button. HomeLight's own
 * 90-minute nudge confirms it considered the referral unanswered.
 *
 * Two things are wrong and this fixes both.
 *
 * The wait was too short by six seconds on a real referral: Kevin's callback
 * (2026-08-11) landed at 3.1 minutes against `awaitStartMinutes: 3`, so a
 * live HomeLight call was missed by rounding. Measured callbacks since Jul 1
 * were -0.8, -0.5, 3.1, 19.0 and 137 minutes, with five referrals getting no
 * call at all, so a long wait is not the answer either: half of all runs
 * would pay it for nothing, and the dossier is explicit that every minute
 * here delays the teammate's hand-off.
 *
 * The claim wording asserted something the flow never checked. It now states
 * the assignment (true: routing did assign it) and the claim-call outcome
 * verbatim from the engine's own phrase, so "no call came in" reaches the
 * reader instead of "yours".
 */

/** The live copy this patch is written against, verbatim. */
const LIVE_OFFER =
  "New HomeLight referral: {{vars.lead_first_name}}, {{vars.lead_type}} in {{vars.city}} (~{{vars.price}}).\n" +
  "Address: {{vars.lead_address}}\n" +
  "Our AI coworker answered HomeLight's call and is talking to them now.\n" +
  "Portal: {{vars.leadUrl}}\n" +
  "Reply 1 to take the follow-up or 2 to pass by {{offer.deadline}}.\n" +
  'You can also reply "1, <ETA>" to claim and tell us when you\'ll reach out (e.g. "1, 20 min").\n' +
  'Passing? You can reply "2, <reason>" to tell us why (e.g. "2, out of town").\n' +
  "First to reply 1 gets it.";

const LIVE_TO_AGENT =
  "HomeLight lead is yours: {{vars.lead_name}} {{vars.lead_phone}} {{vars.lead_email}}\n" +
  "Address: {{vars.lead_address}}\n" +
  "Seller said on the call: {{vars.call_phone}}\n" +
  "({{vars.lead_type}} in {{vars.city}}, ~{{vars.price}})\n" +
  'When can you call? Reply 1 if you\'re calling now, or "1, 20 min" to tell us when.\n' +
  "If the number is bad, just say so.\n" +
  "Price: {{vars.email_price}}\n" +
  "Timeframe: {{vars.email_timeframe}}";

const LIVE_QT_EMAIL =
  "HomeLight referral claimed by {{vars.claimed_agent}}.\n" +
  "Lead: {{vars.lead_name}} ({{vars.lead_phone}}) {{vars.lead_email}}\n" +
  "Address: {{vars.lead_address}}\n" +
  "Seller said on the call: {{vars.call_phone}} {{vars.call_email}}\n" +
  "{{vars.lead_type}} in {{vars.city}}, ~{{vars.price}}\n" +
  "Lead source: HomeLight\n\nOriginal alert:\n{{trigger.windowText}}\n\nQT attached.\n\n" +
  "What HomeLight revealed in the email:\n{{vars.email_summary}}\n" +
  "Exact price: {{vars.email_price}}\nTimeframe: {{vars.email_timeframe}}";

/** A trimmed stand-in carrying the four steps the patch touches. */
function flowFixture(over: Record<string, string> = {}): Record<string, unknown> {
  return {
    version: 1,
    trigger: { channel: "sms", conditions: [] },
    steps: [
      { id: "url", type: "extract_url", saveAs: "leadUrl" },
      {
        id: "alert",
        type: "extract_text",
        fields: [
          { name: "lead_first_name", description: "First name" },
          { name: "lead_name", description: "Full name" },
          { name: "lead_type", description: "buyer or seller" },
          { name: "city", description: "City" },
          { name: "price", description: "Rounded price" },
          { name: "lead_address", description: "Address" },
          { name: "lead_phone", description: "Phone" },
          { name: "lead_email", description: "Email" },
          { name: "email_price", description: "Exact price" },
          { name: "email_timeframe", description: "Timeframe" },
          { name: "email_summary", description: "What HomeLight revealed" }
        ]
      },
      {
        id: OFFER_STEP_ID,
        type: "route_to_team",
        offerTemplate: over.offer ?? LIVE_OFFER,
        ownerFallbackTemplate: "No one claimed it.",
        responseMinutes: 10
      },
      {
        id: WAIT_STEP_ID,
        type: "wait_for_call",
        fromE164: "+14159851909",
        withinMinutes: 30,
        timeoutMinutes: 45,
        awaitStartMinutes: 3,
        saveAs: "hl_call_outcome",
        capturePrefix: "call_"
      },
      {
        id: "lost_branch",
        type: "branch",
        question: "Is this referral still ours?",
        else: [{ id: "lost_notify", type: "notify_owner", message: "Lost it." }],
        branches: [
          {
            id: "still_ours",
            label: "Still ours",
            condition: { var: "hl_call_outcome", notEquals: "lost" },
            steps: [
              {
                id: "to_agent",
                type: "send_sms",
                to: "{{vars.claimed_agent_phone}}",
                body: over.toAgent ?? LIVE_TO_AGENT
              },
              {
                id: "qt_email",
                type: "send_email",
                to: "owner@example.com",
                subject: "{{vars.lead_name}} QT HL CC DAVE",
                body: over.qtEmail ?? LIVE_QT_EMAIL
              }
            ]
          }
        ]
      }
    ]
  };
}

function stepById(def: Record<string, unknown>, id: string): Record<string, unknown> {
  const found: Record<string, unknown>[] = [];
  const walk = (steps: unknown): void => {
    if (!Array.isArray(steps)) return;
    for (const s of steps as Record<string, unknown>[]) {
      if (!s || typeof s !== "object") continue;
      if (s.id === id) found.push(s);
      for (const arm of Array.isArray(s.branches) ? s.branches : []) {
        walk((arm as Record<string, unknown>)?.steps);
      }
      walk(s.else);
    }
  };
  walk(def.steps);
  if (found.length !== 1) throw new Error(`expected one step "${id}", found ${found.length}`);
  return found[0]!;
}

describe("homelight-claim-status-honesty: the wait", () => {
  it("raises awaitStartMinutes past the callback we measurably missed", () => {
    const def = flowFixture();
    const edits = patchDefinition(def, 6);
    expect(edits).toContain(`${WAIT_STEP_ID}.awaitStartMinutes=6`);
    // 6 clears Kevin's real 3.1-minute callback with margin. It is NOT raised
    // to cover the 137-minute outlier: half of all referrals never get a call,
    // and every minute here is a minute the claimer waits for lead details.
    expect(stepById(def, WAIT_STEP_ID).awaitStartMinutes).toBe(6);
  });

  it("leaves the other wait config alone", () => {
    const def = flowFixture();
    patchDefinition(def, 6);
    const step = stepById(def, WAIT_STEP_ID);
    expect(step.timeoutMinutes).toBe(45);
    expect(step.withinMinutes).toBe(30);
    expect(step.fromE164).toBe("+14159851909");
  });

  it("refuses a wait longer than the ceiling", () => {
    expect(() => patchDefinition(flowFixture(), MAX_AWAIT_MINUTES + 1)).toThrow(/ceiling/i);
  });
});

describe("homelight-claim-status-honesty: the claim wording", () => {
  it("stops the offer claiming the AI is already talking to the seller", () => {
    // Sent at the route step, BEFORE any call exists. On the text-claim path
    // there is no call at all, which the dossier already flagged as wrong.
    const def = flowFixture();
    patchDefinition(def, 6);
    const offer = stepById(def, OFFER_STEP_ID).offerTemplate as string;
    expect(offer).not.toContain(FALSE_CALL_LINE);
    expect(offer).toContain(CLAIMING_LINE);
    // Everything else about the offer survives untouched.
    expect(offer).toContain("Reply 1 to take the follow-up or 2 to pass by {{offer.deadline}}.");
    expect(offer).toContain("First to reply 1 gets it.");
  });

  it("tells the teammate it is assigned, not claimed, and names the call outcome", () => {
    const def = flowFixture();
    patchDefinition(def, 6);
    const body = stepById(def, "to_agent").body as string;
    expect(body).not.toContain("HomeLight lead is yours");
    expect(body).toContain("HomeLight lead assigned to you:");
    // The engine's own phrase, so "no call came in" reaches the reader.
    expect(body).toContain("HomeLight claim call: {{vars.hl_call_outcome_label}}.");
    // The portal link is what makes the no_call case actionable: the teammate
    // can finish the claim by hand instead of waiting on a callback that
    // never comes.
    expect(body).toContain("Portal: {{vars.leadUrl}}");
    expect(body).toContain("Timeframe: {{vars.email_timeframe}}");
  });

  it("tells the owner it is assigned, not claimed, and names the call outcome", () => {
    const def = flowFixture();
    patchDefinition(def, 6);
    const body = stepById(def, "qt_email").body as string;
    expect(body).not.toContain("HomeLight referral claimed by");
    expect(body).toContain("HomeLight referral assigned to {{vars.claimed_agent}}.");
    expect(body).toContain("HomeLight claim call: {{vars.hl_call_outcome_label}}.");
    expect(body).toContain("What HomeLight revealed in the email:");
  });

  it("adds no em dash to any copy it writes", () => {
    const def = flowFixture();
    patchDefinition(def, 6);
    for (const id of [OFFER_STEP_ID, "to_agent", "qt_email"]) {
      const step = stepById(def, id);
      const copy = String(step.offerTemplate ?? step.body ?? "");
      expect(copy.includes("\u2014")).toBe(false);
    }
  });
});

describe("homelight-claim-status-honesty: safety", () => {
  it("is idempotent: a second apply reports nothing to do", () => {
    const def = flowFixture();
    expect(patchDefinition(def, 6).length).toBeGreaterThan(0);
    expect(patchDefinition(def, 6)).toEqual([]);
  });

  it("refuses when the live offer copy is not what this patch was written against", () => {
    // An unledgered live edit must stop the apply, not be silently reverted.
    const def = flowFixture({ offer: "Someone rewrote this in the builder." });
    expect(() => patchDefinition(def, 6)).toThrow(/offerTemplate/);
  });

  it("refuses when the teammate copy has already been reworded elsewhere", () => {
    const def = flowFixture({ toAgent: "Totally different text." });
    expect(() => patchDefinition(def, 6)).toThrow(/to_agent/);
  });

  it("refuses when the owner email copy has been reworded elsewhere", () => {
    const def = flowFixture({ qtEmail: "Totally different text." });
    expect(() => patchDefinition(def, 6)).toThrow(/qt_email/);
  });

  it("refuses a flow with no wait step rather than patching half of it", () => {
    const def = flowFixture();
    def.steps = (def.steps as Array<{ id: string }>).filter((s) => s.id !== WAIT_STEP_ID);
    expect(() => patchDefinition(def, 6)).toThrow(new RegExp(WAIT_STEP_ID));
  });

  it("produces a definition the schema still accepts", () => {
    const def = flowFixture();
    patchDefinition(def, 6);
    expect(() => parseAiFlowDefinition(def)).not.toThrow();
  });
});

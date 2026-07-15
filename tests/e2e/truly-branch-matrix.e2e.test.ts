import { beforeAll, describe, expect, it } from "vitest";
import { flattenSteps } from "../../supabase/functions/_shared/ai_flows/branching";
import { NO_REPLY_SENTINEL } from "../../supabase/functions/_shared/ai_flows/steps";
import { geminiJson } from "./gemini";
import { stepOf } from "./flow-walker";
import { walkFlowTimed, type TimedWalkResult } from "./flow-run-replay";
import { TRIGGER, trulyFlowSteps } from "./truly-privyr-flow.fixture";

/**
 * Full branch matrix for Truly Insurance's VERBATIM production flow — one
 * timed walk per branch arm, driven by live Gemini decisions, using the
 * lead replies actually RECORDED in the tenant's run history wherever one
 * exists (run ids noted per scenario; synthetic text is called out).
 *
 * The closing meta-assertion is the "every action item covered" guarantee:
 * it unions the DONE steps across every walk and fails if ANY step id in
 * the definition was never executed by some scenario — so when Truly's
 * flow gains a step, this suite refuses to stay green until a walk covers
 * it. (The Alex renewal-capture scenario lives in
 * truly-renewal-context.e2e.test.ts; its arm is re-covered here by the
 * Junaid walk so this file's coverage union stands alone.)
 *
 * Timing model (flow-run-replay.ts): wait_intro 120m, wait_renewal 30m,
 * wait2 1440m, wait3 4320m, each route_to_team offer window 10m. Replies
 * are placed on that clock to steer which wait consumes them.
 */

const walks: Record<string, TimedWalkResult> = {};

async function walkWith(
  name: string,
  inbound: Array<{ text: string; atMinutes: number }>
): Promise<void> {
  walks[name] = await walkFlowTimed(trulyFlowSteps(), {
    trigger: TRIGGER,
    inbound,
    ai: { json: geminiJson }
  });
}

beforeAll(async () => {
  // Sequential on purpose: each walk makes 1-2 live model calls and the
  // e2e suite runs file-serial to stay under Gemini rate limits.
  //
  // Recorded reply provenance:
  //   Junaid run 2b7ce0c7: "Hi i am looking for a auto quote"
  //   Juhu run 70d90bc7 renewal answer: "I want to reschedule appointment "
  //   Dawnia run 5575c2b2 late reply: "I would like to book a call "
  //   Shahid run 38d17410: "I need Auto and home insurance quote"
  await walkWith("gave_info", [
    { text: "Hi i am looking for a auto quote", atMinutes: 0.5 },
    { text: "I want to reschedule appointment ", atMinutes: 2 }
  ]);
  await walkWith("wants_call", [
    // No first-reply call request exists in the run history; Dawnia's
    // recorded call request (a late reply in production) is a real lead
    // utterance with the same meaning, used here as the intro answer.
    { text: "I would like to book a call ", atMinutes: 0.5 }
  ]);
  await walkWith("not_interested", [
    // Synthetic: no recorded opt-out reply exists for this flow yet.
    { text: "No thanks, I'm all set with my current provider", atMinutes: 0.5 }
  ]);
  await walkWith("customer_called", [
    // The customer_called sentinel is stamped by the voice goal jump when
    // the lead phones the office instead of texting back (goal_events);
    // the walker feeds it as the consumed "reply" to reach that arm.
    { text: "customer_called", atMinutes: 0.5 }
  ]);
  await walkWith("silent", []);
  await walkWith("late_gave_info", [
    // Shahid's recorded reply, arriving AFTER wait_intro's 120m timeout —
    // consumed by wait2 (the nudge follow-up window).
    { text: "I need Auto and home insurance quote", atMinutes: 200 }
  ]);
  await walkWith("late_wants_call", [
    // Dawnia's exact production case (run 5575c2b2): silent through the
    // intro, then "I would like to book a call " after nudge1 — the
    // pre-patch dead end that got pure silence.
    { text: "I would like to book a call ", atMinutes: 200 }
  ]);
  await walkWith("late_not_interested", [
    { text: "Please don't text me again, I'm all set", atMinutes: 200 }
  ]);
  await walkWith("reply_after_second_nudge", [
    // Past wait2's 120+1440m horizon so nudge2 goes out, then the lead
    // finally answers inside wait3 — the only path that runs late_engaged_2.
    { text: "Sorry for the delay - yes I'm still interested", atMinutes: 1700 }
  ]);
}, 600_000);

describe("first-reply arms (recorded replies, live classify)", () => {
  it("Junaid's 'auto quote' reply takes the gave_info else-arm and captures Juhu's non-date renewal answer", () => {
    const w = walks.gave_info;
    expect(w.vars.intent).toBe("gave_info");
    expect(stepOf(w, "continue_convo").status).toBe("done");
    expect(stepOf(w, "tag_engaged").status).toBe("done");
    // Juhu's recorded renewal answer is prose, not a date — the flow must
    // capture and acknowledge it all the same (run 70d90bc7 did).
    expect(w.vars.renewal_timing).toBe("I want to reschedule appointment ");
    expect(stepOf(w, "renewal_ack").status).toBe("done");
    expect(stepOf(w, "offer_team").status).toBe("done");
    expect(String(stepOf(w, "offer_team").result.offer)).toContain(
      'Renewal: "{{vars.renewal_timing}}"'
    );
    expect(w.fellThroughToGenericPath).toEqual([]);
  });

  it("a call request takes the wants_a_call arm: ack + hot-lead routing, no renewal question", () => {
    const w = walks.wants_call;
    expect(w.vars.intent).toBe("wants_a_call");
    expect(stepOf(w, "call_ack").status).toBe("done");
    expect(stepOf(w, "tag_engaged_call").status).toBe("done");
    expect(stepOf(w, "offer_team_call").status).toBe("done");
    expect(String(stepOf(w, "offer_team_call").result.offer)).toContain("WANTS A CALL");
    expect(stepOf(w, "continue_convo").status).toBe("skipped");
    expect(w.sends.some((s) => s.body.includes("policy renew"))).toBe(false);
  });

  it("an opt-out takes the not_interested arm: polite close, Lost tag, owner note, no follow-ups", () => {
    const w = walks.not_interested;
    expect(w.vars.intent).toBe("not_interested");
    expect(stepOf(w, "polite_close").status).toBe("done");
    expect(stepOf(w, "tag_lost").status).toBe("done");
    expect(stepOf(w, "lost_note").status).toBe("done");
    expect(stepOf(w, "offer_team").status).toBe("skipped");
    const last = w.sends[w.sends.length - 1];
    expect(last.body).toContain("No problem at all");
  });

  it("the customer_called sentinel pauses outreach and notes the owner (voice goal jump arm)", () => {
    const w = walks.customer_called;
    expect(stepOf(w, "called_note").status).toBe("done");
    expect(String(stepOf(w, "called_note").result.message)).toContain(
      "called the office instead of texting back"
    );
    // The Replied arm (classify etc.) must NOT run for a phone-in.
    expect(stepOf(w, "classify_reply").status).toBe("skipped");
    expect(stepOf(w, "nudge1").status).toBe("skipped");
  });
});

describe("silent + late-reply arms (the Dawnia incident family)", () => {
  it("a fully silent lead gets both nudges, the final touch, and the Inactive tag", () => {
    const w = walks.silent;
    expect(w.vars.reply_text).toBe(NO_REPLY_SENTINEL);
    expect(w.vars.reply2).toBe(NO_REPLY_SENTINEL);
    expect(w.vars.reply3).toBe(NO_REPLY_SENTINEL);
    expect(stepOf(w, "nudge1").status).toBe("done");
    expect(stepOf(w, "nudge2").status).toBe("done");
    expect(stepOf(w, "final_touch").status).toBe("done");
    expect(stepOf(w, "tag_inactive").status).toBe("done");
    expect(stepOf(w, "late_engaged_2").status).toBe("skipped");
    expect(stepOf(w, "classify_late").status).toBe("skipped");
  });

  it("a late info reply is classified and routed (not dropped — the old dead end)", () => {
    const w = walks.late_gave_info;
    expect(w.vars.reply_text).toBe(NO_REPLY_SENTINEL);
    expect(w.vars.reply2).toBe("I need Auto and home insurance quote");
    expect(w.vars.late_intent).toBe("gave_info");
    expect(stepOf(w, "late_engaged_1").status).toBe("done");
    expect(stepOf(w, "late_continue").status).toBe("done");
    expect(stepOf(w, "late_offer_team").status).toBe("done");
    expect(w.fellThroughToGenericPath).toEqual([]);
  });

  it("Dawnia's exact late 'book a call' routes as a hot lead (run 5575c2b2's fixed path)", () => {
    const w = walks.late_wants_call;
    expect(w.vars.late_intent).toBe("wants_a_call");
    expect(stepOf(w, "late_call_ack").status).toBe("done");
    expect(stepOf(w, "late_offer_call").status).toBe("done");
    expect(stepOf(w, "late_polite_close").status).toBe("skipped");
    expect(stepOf(w, "nudge2").status).toBe("skipped");
  });

  it("a late opt-out closes politely with the Lost tag and owner note", () => {
    const w = walks.late_not_interested;
    expect(w.vars.late_intent).toBe("not_interested");
    expect(stepOf(w, "late_polite_close").status).toBe("done");
    expect(stepOf(w, "late_tag_lost").status).toBe("done");
    expect(stepOf(w, "late_lost_note").status).toBe("done");
    expect(stepOf(w, "late_call_ack").status).toBe("skipped");
  });

  it("a reply after the SECOND nudge re-engages the contact instead of closing them out", () => {
    const w = walks.reply_after_second_nudge;
    expect(w.vars.reply2).toBe(NO_REPLY_SENTINEL);
    expect(w.vars.reply3).toBe("Sorry for the delay - yes I'm still interested");
    expect(stepOf(w, "late_engaged_2").status).toBe("done");
    expect(stepOf(w, "final_touch").status).toBe("skipped");
    expect(stepOf(w, "tag_inactive").status).toBe("skipped");
  });
});

describe("every action item in the flow is covered", () => {
  it("each step id in the VERBATIM definition executes (done) in at least one walk", () => {
    const allStepIds = flattenSteps(trulyFlowSteps()).map((e) => e.step.id);
    expect(allStepIds.length).toBeGreaterThanOrEqual(39);
    const executed = new Set<string>();
    for (const w of Object.values(walks)) {
      for (const s of w.steps) if (s.status === "done") executed.add(s.id);
    }
    const uncovered = allStepIds.filter((id) => !executed.has(id));
    // A failure here means Truly's flow gained (or renamed) an action no
    // scenario executes — add a walk for it above.
    expect(uncovered).toEqual([]);
  });
});

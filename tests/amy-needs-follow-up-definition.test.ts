import { describe, expect, it } from "vitest";
import { parseAiFlowDefinition, validateDefinitionSemantics } from "@/lib/ai-flows/schema";
import {
  FOLLOW_UP_TAG,
  ROUNDS,
  ROUND_GAP_MINUTES,
  buildNeedsFollowUpDefinition
} from "../scripts/oneshot/amy-needs-follow-up-definition";

/**
 * The cadence Amy asked for: a call every three days, a voicemail then a text
 * when nobody answers, silence when the lead is simply cold.
 */

const def = buildNeedsFollowUpDefinition();
const parsed = parseAiFlowDefinition(def);
const steps = parsed.steps as Array<Record<string, unknown>>;
/** Depth-first: rounds 2+ live inside a branch arm. */
function findStep(list: Array<Record<string, unknown>>, id: string): Record<string, unknown> {
  for (const s of list) {
    if (s.id === id) return s;
    if (s.type === "branch") {
      for (const arm of (s.branches as Array<{ steps: Array<Record<string, unknown>> }>) ?? []) {
        const hit = list === steps ? tryFind(arm.steps, id) : undefined;
        if (hit) return hit;
      }
    }
  }
  throw new Error(`no step ${id}`);
}
function tryFind(list: Array<Record<string, unknown>>, id: string) {
  return list.find((s) => s.id === id);
}
const byId = (id: string) => findStep(steps, id);

describe("shape", () => {
  it("is a valid definition with no semantic issues", () => {
    expect(validateDefinitionSemantics(parsed)).toEqual([]);
  });

  it("starts from the Needs Follow Up tag being added", () => {
    expect(parsed.trigger).toMatchObject({
      channel: "tag_changed",
      tag: FOLLOW_UP_TAG,
      change: "added"
    });
  });

  /**
   * A lead re-tagged while a cadence is already running must not get two sets
   * of calls. The run already in flight IS the follow-up.
   */
  it("blocks re-entry", () => {
    expect(parsed.options?.allowReentry).toBe(false);
  });

  /**
   * The wait IS the gap between rounds. A goal step would have been the
   * obvious way to stop on a reply, but its reached-marker is
   * underscore-prefixed and a `when` var must start with a letter, so nothing
   * downstream could branch on it. wait_for_reply's saveAs is an ordinary var.
   */
  it("has all eight rounds, each waiting three days for a reply", () => {
    for (let n = 1; n <= ROUNDS; n += 1) {
      expect(byId(`r${n}_call`)).toMatchObject({ type: "place_ai_call" });
      expect(byId(`r${n}_text`)).toMatchObject({ type: "send_sms" });
      expect(byId(`r${n}_wait`)).toMatchObject({
        type: "wait_for_reply",
        saveAs: "lead_reply",
        timeoutMinutes: ROUND_GAP_MINUTES
      });
    }
    expect(ROUND_GAP_MINUTES).toBe(4320);
  });

  /**
   * Flat, not nested: the same shape the Clever spoke check uses, and branch
   * nesting is capped at 3 levels anyway. A reply in round 2 leaves every
   * later round's guard unmet, so the cadence simply stops.
   */
  it("guards every round after the first on the lead still being silent", () => {
    for (let n = 2; n <= ROUNDS; n += 1) {
      expect(byId(`r${n}`)).toMatchObject({
        type: "branch",
        when: { var: "lead_reply", equals: "no_reply" }
      });
    }
  });
});

describe("the rung: voicemail, then text, and only when nobody answered", () => {
  it("gives every round a voicemail so a no-answer is not silent", () => {
    for (let n = 1; n <= ROUNDS; n += 1) {
      expect(byId(`r${n}_call`).voicemailTemplate).toBeTruthy();
    }
  });

  /**
   * Someone who just spoke to the AI must not also receive "we tried to reach
   * you". The text is gated on the call outcome, not sent unconditionally.
   */
  it("texts only on a no-answer", () => {
    for (let n = 1; n <= ROUNDS; n += 1) {
      expect(byId(`r${n}_text`).when).toEqual({ var: "call_outcome", equals: "no_answer" });
    }
  });

  /**
   * "skip" rather than "defer": a round coming due at 2am should drop its call
   * and let the cadence stay on schedule, not park the run and push every
   * later round back with it.
   */
  it("keeps calls inside Phoenix daytime and skips outside it", () => {
    expect(byId("r1_call").callWindow).toMatchObject({
      timezone: "America/Phoenix",
      outside: "skip"
    });
  });

  it("never tells the AI to ask when to call back", () => {
    for (let n = 1; n <= ROUNDS; n += 1) {
      const persona = String(byId(`r${n}_call`).personaTemplate);
      expect(persona).toContain("Never ask them when to call back");
    }
  });
});

describe("copy", () => {
  const spoken = Array.from({ length: ROUNDS }, (_, i) => String(byId(`r${i + 1}_call`).voicemailTemplate));
  const texted = Array.from({ length: ROUNDS }, (_, i) => String(byId(`r${i + 1}_text`).body));

  // Eight identical messages from one number over three and a half weeks reads
  // as a malfunction.
  it("says something different every round, in both channels", () => {
    expect(new Set(spoken).size).toBe(ROUNDS);
    expect(new Set(texted).size).toBe(ROUNDS);
  });

  it("says the last round is the last", () => {
    expect(spoken[ROUNDS - 1].toLowerCase()).toContain("last call");
    expect(texted[ROUNDS - 1].toLowerCase()).toContain("last message");
  });

  it("references the lead's source site, city and intent as Amy asked", () => {
    expect(spoken[0]).toContain("{{vars.lead_site}}");
    expect(spoken[0]).toContain("{{vars.lead_city}}");
    expect(spoken[0]).toContain("{{vars.lead_intent}}");
  });

  it.each([...spoken, ...texted])("keeps %j free of em dashes and price", (msg) => {
    expect(msg).not.toContain("—");
    expect(msg).not.toMatch(/\{\{vars\.price/);
  });

  it("keeps every voicemail inside the 600-character cap", () => {
    for (const s of spoken) expect(s.length).toBeLessThanOrEqual(600);
  });
});

describe("who hears about a reply", () => {
  /**
   * THE subtle one. A `goal` step is a JUMP TARGET, so the steps after it also
   * run in normal sequence when the ladder simply finishes. Without this gate
   * every lead who ignored all eight rounds would page the team at the end,
   * which is the opposite of "nothing to notify if the lead is cold".
   */
  /**
   * Rule 3, and the whole reason the notice is gated at all: a lead who
   * ignores all eight rounds ends with lead_reply still "no_reply", so nobody
   * is paged about someone who is simply cold.
   */
  it("notifies only when the lead actually said something", () => {
    expect(byId("tell_owner").when).toEqual({ var: "lead_reply", notEquals: "no_reply" });
  });

  /**
   * Booked and claimed are EXTERNAL milestones nothing in this flow observes,
   * so they stay a goal: either one jumps the run out of a parked wait and
   * stops the AI calling someone a teammate already took.
   */
  it("stops the cadence when the lead books or a teammate claims them", () => {
    expect(byId("converted")).toMatchObject({
      type: "goal",
      events: [{ kind: "appointment_booked" }, { kind: "claimed" }]
    });
  });

  /**
   * Resolved at RUN TIME rather than from a var read at step 0: a lead claimed
   * halfway through the cadence is owned by someone the opening extraction
   * could not have known about.
   */
  it("routes to whoever owns the lead now, not who owned it at the start", () => {
    expect(byId("tell_owner")).toMatchObject({
      type: "notify_lead_owner",
      phoneVar: "lead_phone",
      nameVar: "lead_name"
    });
  });

  it("puts the notice last, after every round", () => {
    expect(steps.findIndex((s) => s.id === "tell_owner")).toBe(steps.length - 1);
    expect(steps.findIndex((s) => s.id === "converted")).toBeGreaterThan(
      steps.findIndex((s) => s.id === `r${ROUNDS}`)
    );
  });

  it("quotes the lead's own words back to whoever hears about it", () => {
    expect(String(byId("tell_owner").message)).toContain("{{vars.lead_reply}}");
  });
});

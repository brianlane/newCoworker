import { describe, expect, it } from "vitest";
import { parseAiFlowDefinition, validateDefinitionSemantics } from "@/lib/ai-flows/schema";
import { flattenSteps } from "../supabase/functions/_shared/ai_flows/branching";
import {
  AUTO_TAG_NOTE,
  FOLLOW_UP_TAG,
  ROUNDS,
  ROUND_GAP_MINUTES,
  buildNeedsFollowUpDefinition
} from "../scripts/oneshot/amy-needs-follow-up-definition";
import {
  AUTO_TAG_NOTE as RE_AUTO_TAG_NOTE,
  buildAiFirstContactSteps
} from "../scripts/oneshot/referralexchange-ai-first-contact-definition";

/**
 * The cadence Amy asked for: a call every three days, a voicemail then a text
 * when nobody answers, silence when the lead is simply cold.
 */

const def = buildNeedsFollowUpDefinition();

/** Find a step by id anywhere in the (possibly nested) definition. */
function findDeep(steps: unknown[], id: string): unknown {
  for (const s of steps) {
    if (!s || typeof s !== "object") continue;
    const step = s as { id?: string; steps?: unknown[]; branches?: Array<{ steps?: unknown[] }>; else?: unknown[] };
    if (step.id === id) return step;
    for (const arm of step.branches ?? []) {
      const hit = findDeep(arm.steps ?? [], id);
      if (hit) return hit;
    }
    const inElse = findDeep(step.else ?? [], id);
    if (inElse) return inElse;
  }
  return undefined;
}
const parsed = parseAiFlowDefinition(def);
const steps = parsed.steps as Array<Record<string, unknown>>;
/** Depth-first: rounds 2+ live inside a branch arm. */
function findStep(list: Array<Record<string, unknown>>, id: string): Record<string, unknown> {
  const hit = tryFind(list, id);
  if (hit) return hit;
  throw new Error(`no step ${id}`);
}
/** Fully recursive: the react branch nests routes two branch levels down. */
function tryFind(
  list: Array<Record<string, unknown>>,
  id: string
): Record<string, unknown> | undefined {
  for (const s of list) {
    if (s.id === id) return s;
    if (s.type === "branch") {
      for (const arm of (s.branches as Array<{ steps: Array<Record<string, unknown>> }>) ?? []) {
        const hit = tryFind(arm.steps ?? [], id);
        if (hit) return hit;
      }
      const inElse = tryFind((s.else as Array<Record<string, unknown>>) ?? [], id);
      if (inElse) return inElse;
    }
  }
  return undefined;
}
const byId = (id: string) => findStep(steps, id);
/** Step ids of one round, in order (round 1 is top level, 2+ are in a branch arm). */
function roundStepIds(n: number): string[] {
  if (n === 1) return steps.map((s) => String(s.id));
  const branch = steps.find((s) => s.id === `r${n}`) as { else: Array<{ id: string }> };
  return branch.else.map((s) => s.id);
}

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
   * The double-call fix (Jessica Gutierrez, Aug 12 2026: first-contact call at
   * 6:30, cadence round 1 at 6:32, two voicemails in two minutes). An
   * automated first-contact ladder marks its tag with AUTO_TAG_NOTE; round 1's
   * call skips when the extraction saw it, so the cadence's first touch is the
   * 3-day wait. A manual tag (teammate "F", dashboard editor) has no note,
   * extracts "no" (or misses and reads ""), and keeps the immediate call.
   */
  it("skips round 1's call on an auto-tag, and ONLY round 1's", () => {
    expect((byId("r1_call") as { when?: unknown }).when).toEqual({
      var: "tag_auto",
      notEquals: "yes"
    });
    for (let n = 2; n <= ROUNDS; n++) {
      expect((byId(`r${n}_call`) as { when?: unknown }).when).toBeUndefined();
    }
    const fields = (byId("read_lead") as { fields: Array<{ name: string }> }).fields;
    expect(fields.map((f) => f.name)).toContain("tag_auto");
  });

  it("matches the marker the ReferralExchange ladder actually sends (lockstep copies)", () => {
    expect(RE_AUTO_TAG_NOTE).toBe(AUTO_TAG_NOTE);
    const ref = { label: "x", source: "employee" as const };
    const reSteps = buildAiFirstContactSteps({
      dave: { id: "d", ...ref },
      gabby: { id: "g", ...ref },
      amy: { id: "a", ...ref }
    });
    const tagStep = reSteps.find((s) => s.id === "ai_no_answer_followup") as {
      noteTemplate?: string;
    };
    expect(tagStep.noteTemplate).toBe(AUTO_TAG_NOTE);
    // The extraction matches on this exact token; if either side rewords it,
    // this is the assertion that should fail.
    expect(AUTO_TAG_NOTE).toContain("auto_first_contact");
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
  /**
   * Stop ONLY when the lead was actually reached: empty arms for the reached
   * outcomes and the work in `else`, the same shape the Clever spoke check
   * uses.
   *
   * The inverse (continue only on `no_answer`) reads equivalently and is wrong
   * twice over. Answering is not replying, so a lead who SPOKE to the AI has
   * to end the cadence; but a transient `failed`, or a `not_placed` from the
   * fleet-wide dial cap, would ALSO have ended it, abandoning a lead nobody
   * ever reached because one dial did not go out.
   */
  it("stops a later round only when the lead was actually reached", () => {
    for (let n = 2; n <= ROUNDS; n += 1) {
      const branch = byId(`r${n}`) as Record<string, unknown>;
      expect(branch).toMatchObject({ type: "branch", when: { var: "lead_reply", equals: "no_reply" } });
      const arms = branch.branches as Array<{ condition: unknown; steps: unknown[] }>;
      expect(arms.map((a) => a.condition)).toEqual([
        { var: "call_outcome", equals: "transferred" },
        { var: "call_outcome", equals: "answered" }
      ]);
      // The stop arms do nothing; the round lives in else.
      expect(arms.every((a) => a.steps.length === 0)).toBe(true);
      expect((branch.else as unknown[]).length).toBeGreaterThan(0);
    }
  });

  // A dial that never went out must not end the sequence.
  it("keeps going after a failed or dial-capped call", () => {
    const branch = byId("r2") as Record<string, unknown>;
    const stopOn = (branch.branches as Array<{ condition: { equals: string } }>).map(
      (a) => a.condition.equals
    );
    expect(stopOn).not.toContain("failed");
    expect(stopOn).not.toContain("not_placed");
    expect(stopOn).not.toContain("no_answer");
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
  /**
   * "defer", not "skip", and this is the one that would have silently broken
   * the whole feature. Every round waits exactly 72 hours, so all eight land
   * at the same clock time as the first. With "skip" a lead tagged at 2am
   * resolves round 1 to `not_placed`, which is not `no_answer`, so the text
   * does not send either, and three days later it is 2am again. One unlucky
   * tagging time and the lead is never contacted at all.
   */
  it("defers a night-time round to morning rather than skipping it", () => {
    for (let n = 1; n <= ROUNDS; n += 1) {
      expect(byId(`r${n}_call`).callWindow).toMatchObject({
        timezone: "America/Phoenix",
        start: "08:30",
        outside: "defer"
      });
    }
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

  /**
   * Amy's floor is "at least three tries". Round 1's call is additionally
   * gated on the auto-tag marker, so a lead arriving from an automated
   * first-contact ladder gets rounds 2 and 3 as calls plus round 1's wait,
   * which is still three touches counting the ladder's own.
   */
  it("gives every lead at least the three tries Amy asked for", () => {
    expect(ROUNDS).toBeGreaterThanOrEqual(3);
  });

  /**
   * The sign-off is selected by POSITION (last round), not by index, so
   * changing ROUNDS can never again end the cadence on a mid-sequence line
   * that promises more messages. Proven by checking the round before the last
   * is NOT the sign-off, which is what a plain `list[n - 1]` would have given.
   */
  it("keeps the sign-off on the final round only, whatever ROUNDS becomes", () => {
    // The last round signs off (asserted above) and the one before it must
    // not, which is what a plain `list[n - 1]` would have produced the moment
    // ROUNDS stopped matching the length of the copy list.
    expect(spoken[ROUNDS - 2].toLowerCase()).not.toContain("last call");
    expect(texted[ROUNDS - 2].toLowerCase()).not.toContain("last message");
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
    for (let n = 1; n <= ROUNDS; n += 1) {
      expect(byId(`r${n}_tell_owner`).when).toEqual({ var: "lead_reply", notEquals: "no_reply" });
    }
  });

  /**
   * The notice sits INSIDE each round, right after that round's wait, and the
   * placement IS the fix. One notice at the end gated the same way looks
   * equivalent and is not: a missing var reads as "", which is also not equal
   * to "no_reply", so the guard passes. A `claimed` jump during the very first
   * call would have sent "they came back to us" quoting nothing, for a lead
   * who never said a word.
   */
  it("puts each reply reaction where lead_reply is guaranteed to have been written", () => {
    for (let n = 1; n <= ROUNDS; n += 1) {
      const ids = roundStepIds(n);
      expect(ids.indexOf(`r${n}_classify`)).toBe(ids.indexOf(`r${n}_wait`) + 1);
      expect(ids.indexOf(`r${n}_react`)).toBe(ids.indexOf(`r${n}_wait`) + 2);
      // The notice lives in the react branch's ELSE: a ready reply gets the
      // claim offer INSTEAD of the alert (first-match branch), never both.
      const react = byId(`r${n}_react`) as {
        branches: Array<{ id: string; steps: Array<{ id: string }> }>;
        else: Array<{ id: string }>;
      };
      expect(react.else.map((s) => s.id)).toEqual([`r${n}_tell_owner`]);
      expect(react.branches[0].steps.map((s) => s.id)).toEqual([
        `r${n}_route_buyer`,
        `r${n}_route_seller`,
        `r${n}_route_both`
      ]);
    }
  });

  /**
   * Promotion (the under-$500K AI-owned rule): a reply that reads as ready
   * for a human earns a claim OFFER, quoting the lead's own words. Sellers
   * and both broadcast to the trio first-to-claim; buyers keep the rotation
   * (Amy: "Do not change buyer leads"). Classification only runs on a real
   * reply, so a timeout can never promote: reply_intent stays unset and the
   * react branch matches nothing.
   */
  it("promotes a ready reply with an offer: sellers broadcast, buyers rotate", () => {
    for (let n = 1; n <= ROUNDS; n += 1) {
      expect(byId(`r${n}_classify`)).toMatchObject({
        type: "classify",
        textVar: "lead_reply",
        saveAs: "reply_intent",
        when: { var: "lead_reply", notEquals: "no_reply" }
      });
      const ready = (byId(`r${n}_react`) as { branches: Array<{ condition: unknown }> })
        .branches[0];
      expect(ready.condition).toEqual({ var: "reply_intent", equals: "ready_to_talk" });
      const buyer = byId(`r${n}_route_buyer`);
      const seller = byId(`r${n}_route_seller`);
      const both = byId(`r${n}_route_both`);
      expect(buyer.agentNames).toBeUndefined();
      expect(String(buyer.offerTemplate)).toContain("next agent");
      for (const r of [seller, both]) {
        expect(r.agentNames).toEqual(["Gabrielle Mota", "Amy Laidlaw", "Dave Lane"]);
        expect(String(r.offerTemplate)).toContain("First to reply 1 gets it.");
      }
      for (const r of [buyer, seller, both]) {
        expect(r.type).toBe("route_to_team");
        expect(String(r.offerTemplate)).toContain("{{vars.lead_reply}}");
        // The second email Amy asked for: she hears when a promoted lead
        // gets claimed, through the same claimedNotifyEmail mechanism every
        // route on this account uses.
        expect(r.claimedNotifyEmail).toBe("amy@amylaidlaw.com");
      }
    }
  });

  /**
   * Booking is an EXTERNAL milestone nothing in this flow observes, so it
   * stays a goal: it jumps the run out of a parked wait and stops the AI
   * calling someone who already has a time in the diary.
   */
  it("stops the cadence when the lead books", () => {
    expect(byId("converted")).toMatchObject({
      type: "goal",
      events: [{ kind: "appointment_booked" }]
    });
  });

  /**
   * A CLAIM must not stop it (Amy, 2026-08-17): claiming is a teammate saying
   * they will work the lead, not evidence that anyone reached them, and the
   * cadence ending on that promise is what left leads with no follow-up at
   * all. What stops it is the lead replying, which every later round's guard
   * already covers.
   *
   * Asserted on the events LIST, not just the presence of appointment_booked:
   * the event is business-wide by lead phone, so re-adding it here would let
   * an unrelated flow's route_to_team end this cadence again.
   */
  it("does NOT stop the cadence when a teammate claims the lead", () => {
    const events = byId("converted").events as Array<{ kind: string }>;
    expect(events.map((e) => e.kind)).toEqual(["appointment_booked"]);
  });

  /**
   * Resolved at RUN TIME rather than from a var read at step 0: a lead claimed
   * halfway through the cadence is owned by someone the opening extraction
   * could not have known about.
   */
  it("routes to whoever owns the lead now, not who owned it at the start", () => {
    expect(byId("r1_tell_owner")).toMatchObject({
      type: "notify_lead_owner",
      phoneVar: "lead_phone",
      nameVar: "lead_name"
    });
  });

  it("puts the goal after every round", () => {
    expect(steps.findIndex((s) => s.id === "converted")).toBeGreaterThan(
      steps.findIndex((s) => s.id === `r${ROUNDS}`)
    );
  });

  it("quotes the lead's own words back to whoever hears about it", () => {
    expect(String(byId("r1_tell_owner").message)).toContain("{{vars.lead_reply}}");
  });
});

/**
 * The email arm: what the cadence does for a lead it cannot call or text.
 *
 * The risky part of adding this was never the emails, it was the flat index.
 * `ai_flow_runs.current_step` is an index into the FLATTENED definition and
 * this flow always has runs parked mid-cadence, so anything that renumbers a
 * step at or before a live run walks that run onto the wrong instruction.
 */
describe("the email arm for a lead with no phone", () => {
  const flat = flattenSteps(def.steps as never).map(
    (entry: { step: unknown }) => (entry.step as { id: string }).id
  );
  const stepIndex = (id: string) => flat.indexOf(id);

  it("leaves every pre-existing step at exactly the index it already had", () => {
    // Pinned literally, not derived: this is the regression guard for the
    // index migration, so it has to fail if the shape shifts by one.
    expect(flat.slice(0, 30)).toEqual([
      "read_lead",
      "r1_call", "r1_text", "r1_wait", "r1_classify", "r1_react",
      "r1_route_buyer", "r1_route_seller", "r1_route_both", "r1_tell_owner",
      "r2", "r2_call", "r2_text", "r2_wait", "r2_classify", "r2_react",
      "r2_route_buyer", "r2_route_seller", "r2_route_both", "r2_tell_owner",
      "r3", "r3_call", "r3_text", "r3_wait", "r3_classify", "r3_react",
      "r3_route_buyer", "r3_route_seller", "r3_route_both", "r3_tell_owner"
    ]);
  });

  it("sits BEFORE the converted goal, so a booking jumps over it", () => {
    // A goal step is a fast-forward TARGET: the run jumps straight to it and
    // skips everything between. After the goal, this arm would be the first
    // thing a lead who had just booked walked into, and it would email them.
    const converted = stepIndex("converted");
    expect(converted).toBeGreaterThan(0);
    for (const id of flat.filter((i) => i.startsWith("efu_"))) {
      expect(stepIndex(id)).toBeLessThan(converted);
    }
  });

  it("extracts the email address the arm needs", () => {
    const read = findDeep(def.steps as never, "read_lead") as { fields: Array<{ name: string }> };
    expect(read.fields.map((f) => f.name)).toContain("lead_email");
  });

  it("leaves the reply wait exactly as it was, because it already self-resolves", () => {
    // An earlier draft fed each wait a model-extracted timeout so a
    // phone-less lead would not park. That fixed nothing and risked a lot:
    // wait_for_reply's planner already resolves straight to the "no_reply"
    // sentinel when the phone var is not dialable, and a model answering "1"
    // for a lead who DOES have a phone would have collapsed the three-day
    // cadence into three minutes of calls and texts.
    for (const id of ["r1_wait", "r2_wait", "r3_wait"]) {
      const step = findDeep(def.steps as never, id) as unknown as Record<string, unknown>;
      expect(step.timeoutMinutes).toBe(ROUND_GAP_MINUTES);
      expect(step.timeoutMinutesTemplate).toBeUndefined();
      expect(step.when).toBeUndefined();
    }
  });

  it("resolves an email reply to the claiming teammate, not just the team", () => {
    // notify_lead_owner keys on a phone var first and a name var second. An
    // email-only lead has no phone to key on, so without nameVar every reply
    // would take the unowned fallback even when someone had claimed it.
    const replied = findDeep(def.steps as never, "efu_replied_1") as unknown as Record<string, unknown>;
    expect(replied.nameVar).toBe("lead_name");
    expect(replied.unownedFallback).toBe("team");
  });

  it("only runs for a lead the AI cannot phone", () => {
    const root = findDeep(def.steps as never, "efu_root") as unknown as {
      branches: Array<{ condition: unknown; steps: unknown[] }>;
    };
    expect(root.branches[0].condition).toEqual({ var: "lead_phone", contains: "+" });
    expect(root.branches[0].steps).toEqual([]);
  });

  it("still validates as a whole flow", () => {
    expect(() => parseAiFlowDefinition(def)).not.toThrow();
  });
});

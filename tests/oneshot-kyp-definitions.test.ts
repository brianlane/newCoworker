/**
 * Regression pins for KYP Ads' canonical lead-flow definition
 * (scripts/oneshot/kyp-lead-flow-definition.ts) and the live applier that
 * carries its bad-phone arm (scripts/oneshot/patch-kyp-bad-phone-intake.ts).
 *
 * Incidents pinned here:
 *  - Jul 19 2026: nudges fired at 2:12 AM Toronto because no send step
 *    carried quiet hours. Every nudge must keep the America/Toronto gate
 *    with the 11:00 morning resume; the evening edge is 21:00, the value
 *    the live flow has run with since the (unledgered) Jul 19-24 reshape.
 *    The greeting must stay ungated (60-second first touch, any hour).
 *  - Aug 1 2026: a lead typed +16133439985030 and the run died at the
 *    greeting with the owner-notify step behind it. The bad-phone arm must
 *    stay guarded on lead_phone equals "none", and s_notify / s_wait_1 on
 *    notEquals, so an unreachable lead is a designed path.
 *  - Builder drift: the live flow was once reshaped outside the ledger and
 *    the old builder went stale. The transform in
 *    patch-kyp-bad-phone-intake.ts and this builder must produce the SAME
 *    definition, so neither can drift from the other unnoticed.
 */
import { describe, expect, it } from "vitest";

import {
  BAD_PHONE_EMAIL_ID,
  BAD_PHONE_NOTIFY_ID,
  buildKypLeadFollowUpDefinition,
  KYP_QUIET_HOURS,
  KYP_TIME_WINDOW
} from "../scripts/oneshot/kyp-lead-flow-definition";
import {
  buildKypBookingConfirmationDefinition,
  buildKypPreCallReminderDefinition
} from "../scripts/oneshot/kyp-reminder-flow-definition";
import { addBadPhoneIntakeArm } from "../scripts/oneshot/patch-kyp-bad-phone-intake";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { smsQuietDecision, zonedClock } from "../supabase/functions/_shared/ai_flows/quiet_hours";

type StepJson = {
  id?: string;
  type?: string;
  to?: string;
  when?: { var?: string; equals?: string; notEquals?: string };
  quietHours?: { timezone?: string; noSendAfter?: string; resumeAt?: string };
};

const definition = buildKypLeadFollowUpDefinition() as { steps: StepJson[] };
const steps = definition.steps;
const byId = (id: string): StepJson | undefined => steps.find((s) => s.id === id);

/** Literal expected gate, independent of the exported constant so a typo'd
 * export can never make the nudge assertions pass vacuously. */
const EXPECTED_QUIET_HOURS = {
  timezone: "America/Toronto",
  noSendAfter: "21:00",
  resumeAt: "11:00"
};

describe("KYP lead-flow definition", () => {
  it("still validates as a well-formed AiFlow definition", () => {
    expect(() => parseAiFlowDefinition(definition)).not.toThrow();
  });

  it("keeps the canonical step order (live shape + bad-phone arm)", () => {
    expect(steps.map((s) => s.id)).toEqual([
      "s_extract",
      BAD_PHONE_NOTIFY_ID,
      BAD_PHONE_EMAIL_ID,
      "s_file",
      "s_greet",
      "s_notify",
      "s_wait_1",
      "s_nudge_1",
      "s_wait_2",
      "s_nudge_2",
      "s_wait_3",
      "s_nudge_3",
      "s_wait_final",
      "s_flag_owner",
      "s_mark_inactive",
      "s_goal"
    ]);
  });

  it("keeps offer selection on the webhook trigger (the in-flow branch is gone)", () => {
    const trigger = (definition as unknown as { trigger: Record<string, unknown> }).trigger;
    expect(trigger.channel).toBe("webhook");
    expect(trigger.conditions).toEqual([
      { type: "contains", value: "Simple form setup 5/7/26", caseInsensitive: true }
    ]);
  });
});

describe("KYP quiet hours (2 AM nudge regression, Jul 19 2026)", () => {
  const nudges = steps.filter((s) => /^s_nudge_\d+$/.test(s.id ?? ""));

  it("exports the live Toronto quiet-hours config", () => {
    expect(KYP_QUIET_HOURS).toEqual(EXPECTED_QUIET_HOURS);
  });

  it("every nudge carries the gate; the greeting stays ungated", () => {
    expect(nudges).toHaveLength(3);
    for (const nudge of nudges) {
      expect(nudge.quietHours, `nudge ${nudge.id} is missing quietHours`).toEqual(
        EXPECTED_QUIET_HOURS
      );
    }
    expect(byId("s_greet")?.quietHours).toBeUndefined();
  });

  it("the gate refuses a 2:12 AM Toronto send and resumes at 11:00", () => {
    // The incident instant: Jul 19 2026, 2:12 AM in Toronto (EDT, UTC-4).
    const nudgeInstantMs = Date.parse("2026-07-19T06:12:00Z");
    const decision = smsQuietDecision(nudgeInstantMs, EXPECTED_QUIET_HOURS);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      const resumeClock = zonedClock(decision.resumeAtMs, "America/Toronto");
      expect(resumeClock?.minutesOfDay).toBe(11 * 60);
      expect(decision.resumeAtMs).toBeGreaterThan(nudgeInstantMs);
      expect(decision.resumeAtMs - nudgeInstantMs).toBeLessThanOrEqual(9 * 60 * 60_000);
    }
  });

  it("allows sends inside business hours (2 PM Toronto)", () => {
    const businessHoursMs = Date.parse("2026-07-19T18:00:00Z"); // 2:00 PM EDT
    expect(smsQuietDecision(businessHoursMs, EXPECTED_QUIET_HOURS)).toEqual({ allowed: true });
  });

  it("keeps the OTHER flows' 11:00-18:00 window intact for patch-kyp-business-hours", () => {
    expect(KYP_TIME_WINDOW).toEqual({ timezone: "America/Toronto", start: "11:00", end: "18:00" });
  });
});

describe("KYP bad-phone arm (undialable lead, Aug 1 2026)", () => {
  it("bad-phone steps fire only when lead_phone extracted as none", () => {
    for (const id of [BAD_PHONE_NOTIFY_ID, BAD_PHONE_EMAIL_ID]) {
      expect(byId(id)?.when, id).toEqual({ var: "lead_phone", equals: "none" });
    }
    // Templated recipient: a lead with no email takes the planner's
    // no_recipient_email skip instead of failing the run.
    expect(byId(BAD_PHONE_EMAIL_ID)?.to).toBe("{{vars.lead_email}}");
  });

  it("s_notify and s_wait_1 are guarded so the ladder collapses without a phone", () => {
    for (const id of ["s_notify", "s_wait_1"]) {
      expect(byId(id)?.when, id).toEqual({ var: "lead_phone", notEquals: "none" });
    }
  });
});

describe("builder <-> patch transform equivalence", () => {
  /** The pre-patch live shape: canonical minus the arm and its guards. */
  function prePatchDefinition(): { steps: StepJson[] } {
    const clone = structuredClone(definition);
    clone.steps = clone.steps.filter(
      (s) => s.id !== BAD_PHONE_NOTIFY_ID && s.id !== BAD_PHONE_EMAIL_ID
    );
    for (const id of ["s_notify", "s_wait_1"]) {
      const step = clone.steps.find((s) => s.id === id);
      delete step?.when;
    }
    return clone;
  }

  it("applying the transform to the pre-patch live shape yields the builder exactly", () => {
    const live = prePatchDefinition();
    const result = addBadPhoneIntakeArm(live);
    expect(result.changed).toBe(true);
    expect(live).toEqual(definition);
  });

  it("is idempotent: a second application changes nothing", () => {
    const live = prePatchDefinition();
    addBadPhoneIntakeArm(live);
    const second = addBadPhoneIntakeArm(live);
    expect(second.changed).toBe(false);
    expect(live).toEqual(definition);
  });

  it("never clobbers an unexpected when on a guarded step", () => {
    const live = prePatchDefinition();
    const notify = live.steps.find((s) => s.id === "s_notify");
    notify!.when = { var: "reply_1", equals: "no_reply" };
    const result = addBadPhoneIntakeArm(live);
    expect(notify!.when).toEqual({ var: "reply_1", equals: "no_reply" });
    expect(result.notes.join("\n")).toContain("unexpected when");
  });

  it("reports a wrong flow shape instead of transforming it", () => {
    const result = addBadPhoneIntakeArm({ steps: [{ id: "other", type: "send_sms" }] });
    expect(result.changed).toBe(false);
    expect(result.notes.join("\n")).toContain("wrong flow shape");
  });
});

/**
 * Aug 5 2026, Reem (+19134399078, Europe/London): the pre-call reminder told
 * her a 13:00Z call was "2:00 PM Eastern time (your local time)". It was
 * 2:00 PM UK. She was later told no call was starting while hers was seven
 * minutes away, and she canceled.
 *
 * Cause: `invitee_tz_plain` asked the extractor for a zone from a five-item
 * NORTH AMERICAN list and told it to return 'Eastern' when unclear, so a
 * London invitee had no correct answer available. The trigger payload was
 * fine throughout: it states `invitee timezone: Europe/London` and
 * `starts (invitee local time): ... at 2:00 PM`.
 *
 * `tests/e2e/kyp-invitee-timezone-label.e2e.test.ts` proves the BEHAVIOR
 * against the live model, but that suite is a gated CI job that runs only
 * after everything else passes. These pins are hermetic and run on every
 * `npm test`, so the shape cannot come back cheaply.
 */
describe("KYP calendar flows: invitee timezone (Reem, Aug 5 2026)", () => {
  const reminder = buildKypPreCallReminderDefinition() as { steps: StepJson[] };
  const confirmation = buildKypBookingConfirmationDefinition() as { steps: StepJson[] };

  /** Zone words that only make sense in North America. */
  const NA_ZONE_WORDS = ["eastern", "central", "mountain", "pacific", "atlantic"];

  const extractFields = (def: { steps: StepJson[] }): Array<{ name: string; description: string }> => {
    const step = def.steps.find((s) => s.type === "extract_text") as
      | { fields?: Array<{ name?: string; description?: string }> }
      | undefined;
    return (step?.fields ?? []).map((f) => ({
      name: String(f.name ?? ""),
      description: String(f.description ?? "")
    }));
  };

  /** Everything the flow could put in front of a customer or the owner. */
  const renderedStrings = (def: { steps: StepJson[] }): string[] =>
    def.steps.flatMap((s) =>
      [(s as { body?: string }).body, (s as { message?: string }).message, (s as { subject?: string }).subject].filter(
        (v): v is string => typeof v === "string"
      )
    );

  const cases: Array<[string, { steps: StepJson[] }]> = [
    ["pre-call reminder", reminder],
    ["booking confirmation", confirmation]
  ];

  for (const [label, def] of cases) {
    it(`${label} still validates as a well-formed AiFlow definition`, () => {
      expect(() => parseAiFlowDefinition(def)).not.toThrow();
    });

    it(`${label} has no extract field offering a closed North American zone list`, () => {
      for (const field of extractFields(def)) {
        const hits = NA_ZONE_WORDS.filter((w) => field.description.toLowerCase().includes(w));
        expect(
          hits,
          `field "${field.name}" enumerates ${hits.join("/")} in its description. A closed ` +
            "North American list has no correct answer for a Europe/London invitee, which is " +
            "how Reem was told her 2:00 PM UK call was 2:00 PM Eastern."
        ).toEqual([]);
      }
    });

    it(`${label} has no extract field that guesses a zone when unclear`, () => {
      for (const field of extractFields(def)) {
        expect(
          /if\s+unclear[^.]*return/i.test(field.description),
          `field "${field.name}" instructs the model to fall back to a fixed value when ` +
            "unclear. For a timezone that turns 'I do not know' into a confident wrong answer."
        ).toBe(false);
      }
    });

    it(`${label} never renders a bare timezone variable next to the time`, () => {
      for (const text of renderedStrings(def)) {
        expect(
          /\{\{vars\.[a-z_]*tz[a-z_]*\}\}/i.test(text),
          `this copy templates a timezone variable: ${JSON.stringify(text.slice(0, 120))}. ` +
            "invitee_local_time is ALREADY the invitee's own wall clock, so naming a zone " +
            "beside it adds a claim the flow cannot verify."
        ).toBe(false);
      }
    });

    it(`${label} tells the extractor to copy the local time, not convert it`, () => {
      const field = extractFields(def).find((f) => f.name === "invitee_local_time");
      expect(field, "invitee_local_time is the value every reminder quotes").toBeDefined();
      expect(
        /convert/i.test(field!.description),
        "the payload already states the answer verbatim on the 'starts (invitee local time):' " +
          "line, so asking the model to convert re-derives it for no gain."
      ).toBe(false);
    });
  }
});

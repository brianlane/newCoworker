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
import { stripGuessedTimezone } from "../scripts/oneshot/patch-kyp-timezone-labels";
import { customerFacingCancelSurfaces } from "../scripts/oneshot/patch-kyp-cancel-tool-policy";
import {
  CURRENT_PREMIUM_TITLE,
  retargetPremiumArm,
  STALE_PREMIUM_TITLE
} from "../scripts/oneshot/patch-kyp-noshow-event-title";
import { OWNER_OPERATED_AGENT_KEYS } from "@/lib/agent-tools/channel-divergence";
import {
  KYP_BOOKING_CONFIRMATION_PRE_FIX,
  KYP_PRE_CALL_REMINDER_PRE_FIX
} from "./kyp-calendar-flows-pre-fix.fixture";
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

  /** Minimal stand-in for the local-time field in hand-built fixtures. */
  const INVITEE_LOCAL_TIME_FIELD_SHAPE = {
    name: "invitee_local_time",
    description: "The clock time, copied verbatim, like '10:00 AM'."
  };

  const extractFields = (def: { steps: StepJson[] }): Array<{ name: string; description: string }> => {
    const step = def.steps.find((s) => s.type === "extract_text") as
      | { fields?: Array<{ name?: string; description?: string }> }
      | undefined;
    return (step?.fields ?? []).map((f) => ({
      name: String(f.name ?? ""),
      description: String(f.description ?? "")
    }));
  };

  /** Only what a CUSTOMER receives: send_sms and send_email copy. */
  const customerFacingStrings = (def: { steps: StepJson[] }): string[] =>
    def.steps
      .filter((s) => s.type === "send_sms" || s.type === "send_email")
      .flatMap((s) =>
        [(s as { body?: string }).body, (s as { subject?: string }).subject].filter(
          (v): v is string => typeof v === "string"
        )
      );

  /** Any variable whose name suggests a timezone, however spelled. */
  const ZONE_VAR_RE = /\{\{vars\.[a-z_]*(tz|time_?zone)[a-z_]*\}\}/i;

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

    it(`${label} names no timezone in anything the customer receives`, () => {
      for (const text of customerFacingStrings(def)) {
        expect(
          ZONE_VAR_RE.test(text),
          `customer copy templates a timezone variable: ${JSON.stringify(text.slice(0, 120))}. ` +
            "invitee_local_time is ALREADY the invitee's own wall clock, so 'your time' is " +
            "true for every invitee and naming a zone can only introduce a wrong claim."
        ).toBe(false);
      }
    });

    it(`${label} tells the extractor to copy the local time, not convert it`, () => {
      const field = extractFields(def).find((f) => f.name === "invitee_local_time");
      expect(field, "invitee_local_time is the value every reminder quotes").toBeDefined();
      expect(
        field!.description,
        "the payload states the answer outright on the 'starts (invitee local time):' line"
      ).toMatch(/verbatim/i);
      // Strip the NEGATED forms first, so "never convert or shift it" reads as
      // the instruction it is rather than tripping a bare /convert/ match.
      const affirmative = field!.description
        .replace(/\b(never|do not|don't|do NOT)\s+convert\b/gi, "")
        .replace(/\bwithout\s+converting\b/gi, "");
      expect(
        /\bconvert/i.test(affirmative),
        "asking the model to convert re-derives an answer the payload already contains, " +
          "which is how a Europe/London booking became '2:00 PM Eastern'."
      ).toBe(false);
    });
  }

  /**
   * The owner notify is the one place a zone MUST survive. It goes to James,
   * the time in it is the invitee's wall clock, and a bare "2:00 PM" is
   * exactly the ambiguity that started this incident. Removing the zone from
   * customer copy without keeping it here would trade one bug for another.
   */
  /**
   * The equivalence that makes the one-shot trustworthy: running the patch
   * on the REAL pre-fix live shape must produce exactly the canonical
   * builder. Without this, the builder and the applier could disagree and
   * the tenant would end up in a third shape neither file describes. Same
   * guarantee the bad-phone patch carries above.
   */
  it("the one-shot turns the real pre-fix live shape into the builder", () => {
    const cases: Array<[string, unknown, Record<string, unknown>]> = [
      ["pre-call reminder", KYP_PRE_CALL_REMINDER_PRE_FIX, buildKypPreCallReminderDefinition()],
      [
        "booking confirmation",
        KYP_BOOKING_CONFIRMATION_PRE_FIX,
        buildKypBookingConfirmationDefinition()
      ]
    ];
    for (const [label, live, expected] of cases) {
      const result = stripGuessedTimezone(live);
      expect(result.changed, `${label}: the pre-fix shape must need patching`).toBe(true);
      expect(result.definition, `${label}: patch output must equal the canonical builder`).toEqual(
        expected
      );
    }
  });

  /**
   * If a body references the zone variable in wording the patch does not
   * recognize, dropping the field anyway would leave a dangling
   * {{vars.invitee_tz_plain}} that renders as EMPTY text to a customer. That
   * is strictly worse than the wrong zone this patch removes, so the field
   * has to survive and the operator has to be told.
   */
  it("keeps the field when copy it does not recognize still references it", () => {
    const odd = {
      steps: [
        {
          id: "extract_invitee",
          type: "extract_text",
          fields: [
            { ...INVITEE_LOCAL_TIME_FIELD_SHAPE },
            { name: "invitee_tz_plain", description: "Invitee's timezone: 'Eastern' or 'Pacific'." }
          ]
        },
        {
          id: "odd_sms",
          type: "send_sms",
          body: "See you at {{vars.invitee_local_time}} ({{vars.invitee_tz_plain}}), talk soon!"
        }
      ]
    };
    const result = stripGuessedTimezone(odd);
    const fields = result.definition.steps![0].fields!;
    expect(
      fields.some((f) => f.name === "invitee_tz_plain"),
      "the field must survive while copy still references it"
    ).toBe(true);
    expect(result.notes.join("\n")).toContain("KEEPING invitee_tz_plain");
    expect(result.notes.join("\n")).toContain("odd_sms");
    // And the unrecognized copy is left exactly as it was, not half-rewritten.
    expect(result.definition.steps![1].body).toBe(odd.steps[1].body);
  });

  it("the one-shot is idempotent on an already-patched flow", () => {
    const already = stripGuessedTimezone(buildKypPreCallReminderDefinition());
    expect(already.changed).toBe(false);
    expect(already.notes.join("\n")).toContain("already patched");
    expect(already.definition).toEqual(buildKypPreCallReminderDefinition());
  });

  /**
   * The $200 arm tested for "free strategy call | 2", but that event type was
   * renamed to "| Client" in Calendly, so the arm could never fire and every
   * $200 no-show was texted the $100 link.
   */
  it("retargets the no-show $200 arm at the renamed event type", () => {
    const live = {
      steps: [
        {
          id: "route_recovery",
          type: "branch",
          branches: [
            {
              id: "arm_200",
              label: "$200/week",
              condition: { var: "event_title", contains: STALE_PREMIUM_TITLE, caseInsensitive: true }
            },
            {
              id: "arm_100",
              label: "$100/week",
              condition: { var: "event_title", contains: "free strategy call", caseInsensitive: true }
            }
          ]
        }
      ]
    };
    const result = retargetPremiumArm(live);
    expect(result.changed).toBe(true);
    const arms = result.definition.steps![0].branches!;
    expect(arms[0].condition!.contains).toBe(CURRENT_PREMIUM_TITLE);
    // The $100 arm must keep its broader match, which still catches the
    // cheaper event type once arm_200 has been evaluated first.
    expect(arms[1].condition!.contains).toBe("free strategy call");

    const again = retargetPremiumArm(result.definition);
    expect(again.changed, "re-running must be a no-op").toBe(false);
  });

  it("the cancel-tool policy targets customer surfaces and spares the owner's", () => {
    const surfaces = customerFacingCancelSurfaces();
    // Derived from the registry, not hard-coded, so a surface that gains the
    // tool later cannot be silently missed the way voice was on Amy's account.
    expect(surfaces).toContain("sms");
    expect(surfaces).toContain("email");
    expect(
      surfaces,
      "dashboard is James asking his own assistant to cancel, not the AI canceling at a customer"
    ).not.toContain("dashboard");
    for (const key of OWNER_OPERATED_AGENT_KEYS) expect(surfaces).not.toContain(key);
  });

  it("keeps the invitee's zone in the owner notify, copied verbatim", () => {
    const notify = confirmation.steps.find((s) => s.type === "notify_owner") as
      | { message?: string }
      | undefined;
    expect(notify?.message, "the booking confirmation notifies James").toBeTruthy();
    expect(
      notify!.message,
      "James needs to know whose 2:00 PM this is; the invitee's local time alone is ambiguous"
    ).toContain("{{vars.invitee_timezone_iana}}");

    const field = extractFields(confirmation).find((f) => f.name === "invitee_timezone_iana");
    expect(field, "the zone the owner notify renders must actually be extracted").toBeDefined();
    expect(
      /verbatim/i.test(field!.description),
      "an IANA zone is stated outright on the payload's 'invitee timezone:' line, so it must " +
        "be copied. The moment it is named or translated instead, it can be guessed wrong again."
    ).toBe(true);
  });
});

/**
 * Pins the pure transforms in
 * scripts/oneshot/patch-kyp-vfm-booking-liz-emails.ts, the 2026-08-19
 * owner-directed KYP/VFM fixes: repoint Liz's flow emails onto one address,
 * make the saved booking draft's trigger actually able to fire (the saved
 * condition matched the scheduling LINK, which calendar event text never
 * contains), and retire the old outbound address from tenant memory without
 * touching the owner's "do not use" instruction line.
 */
import { describe, expect, it } from "vitest";
import {
  BOOKING_CONDITION_TITLE,
  INERT_BOOKING_CONDITION,
  repointLizEmails,
  repointMemoryEmailLines,
  retargetBookingTrigger
} from "../scripts/oneshot/patch-kyp-vfm-booking-liz-emails";

const OLD = "liz@old-calendly-login.example";
const NEW = "liz@brand.example";

/** Mirrors the live VFM lead flow's Liz-facing shape (3 old + 1 new). */
function leadFlowFixture() {
  return {
    steps: [
      { id: "s_extract", type: "extract_text" },
      { id: "s_bad_phone_alert", type: "send_email", to: OLD, subject: "bad phone" },
      { id: "s_fyi", type: "send_email", to: OLD, subject: "new lead" },
      { id: "s_greet", type: "send_sms", to: "{{vars.lead_phone}}" },
      { id: "s_final_flag", type: "send_email", to: NEW, subject: "went quiet" },
      { id: "s_outcome", type: "send_email", to: OLD, subject: "pre-call outcome" }
    ]
  };
}

describe("repointLizEmails", () => {
  it("repoints every send_email step addressed to the old address, and only those", () => {
    const def = leadFlowFixture();
    const result = repointLizEmails(def, OLD, NEW);
    expect(result.changed).toBe(true);
    expect(result.notes).toHaveLength(3);
    const tos = def.steps.filter((s) => s.type === "send_email").map((s) => s.to);
    expect(tos).toEqual([NEW, NEW, NEW, NEW]);
    // The SMS step's template recipient is untouched.
    expect(def.steps.find((s) => s.id === "s_greet")?.to).toBe("{{vars.lead_phone}}");
  });

  it("is idempotent: a second pass reports nothing to do", () => {
    const def = leadFlowFixture();
    repointLizEmails(def, OLD, NEW);
    const second = repointLizEmails(def, OLD, NEW);
    expect(second.changed).toBe(false);
    expect(second.notes).toEqual([`no send_email steps addressed to ${OLD} (already repointed)`]);
  });

  it("never rewrites template recipients or non-email steps", () => {
    const def = {
      steps: [
        { id: "s_email_lead", type: "send_email", to: "{{vars.lead_email}}" },
        { id: "s_sms", type: "send_sms", to: OLD }
      ]
    };
    const result = repointLizEmails(def, OLD, NEW);
    expect(result.changed).toBe(false);
    expect(def.steps[0].to).toBe("{{vars.lead_email}}");
    // A send_sms step addressed at an email is broken data, not this
    // patch's business: leave it alone rather than "fixing" it blind.
    expect(def.steps[1].to).toBe(OLD);
  });
});

describe("retargetBookingTrigger", () => {
  /** Mirrors the saved draft: calendar event_created on the scheduling link. */
  function bookingFixture() {
    return {
      trigger: {
        on: "event_created",
        channel: "calendar",
        calendar: "both",
        conditions: [
          { type: "contains", value: INERT_BOOKING_CONDITION, caseInsensitive: true }
        ]
      },
      steps: [{ id: "s1_extract", type: "extract_text" }]
    };
  }

  it("swaps the inert scheduling-link condition for the event-type title", () => {
    const def = bookingFixture();
    const result = retargetBookingTrigger(def);
    expect(result.changed).toBe(true);
    expect(def.trigger.conditions[0].value).toBe(BOOKING_CONDITION_TITLE);
    // Everything else about the trigger survives untouched.
    expect(def.trigger).toMatchObject({ on: "event_created", channel: "calendar" });
  });

  it("is idempotent and says so", () => {
    const def = bookingFixture();
    retargetBookingTrigger(def);
    const second = retargetBookingTrigger(def);
    expect(second.changed).toBe(false);
    expect(second.notes).toContain("trigger condition already targets the event title");
  });

  it("also reaches conditions in the extra triggers list", () => {
    const def = {
      trigger: { channel: "webhook", conditions: [{ type: "contains", value: "unrelated" }] },
      triggers: [
        {
          on: "event_created",
          channel: "calendar",
          conditions: [{ type: "contains", value: INERT_BOOKING_CONDITION }]
        }
      ]
    };
    const result = retargetBookingTrigger(def);
    expect(result.changed).toBe(true);
    expect(def.triggers[0].conditions[0].value).toBe(BOOKING_CONDITION_TITLE);
    expect(def.trigger.conditions[0].value).toBe("unrelated");
  });

  it("reports when no matching condition exists rather than inventing one", () => {
    const def = { trigger: { channel: "webhook", conditions: [{ value: "x" }] } };
    const result = retargetBookingTrigger(def);
    expect(result.changed).toBe(false);
    expect(result.notes).toEqual(["no matching trigger condition found"]);
  });
});

describe("repointMemoryEmailLines", () => {
  const RETIRED = "old-name@tenant-domain.example";
  const PLATFORM = "name@newcoworker.com";
  const MEMORY = [
    "# Memory",
    `- Email address: ${RETIRED}`,
    "- Something unrelated",
    `- Email address for emailing clients and leads: ${RETIRED}`,
    `- Do not use ${RETIRED} anymore`
  ].join("\n");

  it("repoints identity lines but preserves the owner's prohibition line verbatim", () => {
    const { next, replaced } = repointMemoryEmailLines(MEMORY, RETIRED, PLATFORM);
    expect(replaced).toHaveLength(2);
    expect(next).toContain(`- Email address: ${PLATFORM}`);
    expect(next).toContain(`- Email address for emailing clients and leads: ${PLATFORM}`);
    // The instruction survives, still naming the retired address.
    expect(next).toContain(`- Do not use ${RETIRED} anymore`);
    expect(next).toContain("- Something unrelated");
  });

  it("is idempotent: the repointed text has nothing left to replace", () => {
    const first = repointMemoryEmailLines(MEMORY, RETIRED, PLATFORM);
    const second = repointMemoryEmailLines(first.next, RETIRED, PLATFORM);
    expect(second.replaced).toHaveLength(0);
    expect(second.next).toBe(first.next);
  });
});

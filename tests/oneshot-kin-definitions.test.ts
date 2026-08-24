/**
 * Regression pins for KIN Integrated Child Health's canonical lead flow
 * (scripts/oneshot/kin-lead-definition.ts), the builder that
 * patch-kin-lead-flow.ts re-applies to the live tenant.
 *
 * What these guard, all live defects of the as-installed template before the
 * patch: the greeting carried the intake's typos verbatim and never named
 * the business, no step carried a booking link, and no send step had quiet
 * hours, so a 2 AM Meta lead got a 2 AM text.
 *
 * The placeholder pin matters most: the JaneApp link starts as a sentinel,
 * and the applier refuses to write while it is one. If the sentinel ever
 * stops matching bookingLinkIsPending, that refusal silently dies and a
 * literal "<JANEAPP_BOOKING_LINK_PENDING>" could reach a parent's phone.
 */
import { describe, expect, it } from "vitest";

import {
  buildKinLeadDefinition,
  bookingLinkIsPending,
  KIN_FIRST_FOLLOW_UP_MINUTES,
  KIN_FLOW_NAME,
  KIN_JANEAPP_BOOKING_LINK,
  KIN_JANEAPP_LINK_PENDING,
  KIN_QUIET_HOURS,
  KIN_SECOND_FOLLOW_UP_MINUTES
} from "../scripts/oneshot/kin-lead-definition";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";

type StepJson = {
  id?: string;
  type?: string;
  body?: string;
  message?: string;
  timeoutMinutes?: number;
  quietHours?: { timezone?: string; noSendAfter?: string; resumeAt?: string };
  events?: Array<{ kind?: string }>;
};

const LINK = "https://example.janeapp.example/consult";

function steps(def = buildKinLeadDefinition(LINK)): StepJson[] {
  return def.steps as StepJson[];
}

describe("kin lead definition", () => {
  it("passes the engine's schema validation", () => {
    expect(() => parseAiFlowDefinition(buildKinLeadDefinition(LINK))).not.toThrow();
  });

  it("keeps the flow name the white-glove apply created, so the patch targets the same row", () => {
    expect(KIN_FLOW_NAME).toBe("Lead follow-up (white-glove build)");
  });

  it("ships the booking link in the greeting AND the first nudge", () => {
    const byId = new Map(steps().map((s) => [s.id, s]));
    expect(byId.get("s_greet")?.body).toContain(LINK);
    expect(byId.get("s_nudge_1")?.body).toContain(LINK);
  });

  it("names the clinic in the first text a lead receives", () => {
    const greet = steps().find((s) => s.id === "s_greet");
    expect(greet?.body).toContain("KIN Integrated Child Health");
  });

  it("carries none of the intake's typos", () => {
    const text = JSON.stringify(buildKinLeadDefinition(LINK));
    expect(text).not.toContain("on you healing");
    expect(text).not.toContain("wanna");
    // The intake greeting's lowercase-L "l'll".
    expect(text).not.toContain("l’ll");
    expect(text).not.toContain("l'll");
  });

  it("holds every lead-facing text to the Edmonton quiet-hours window", () => {
    for (const s of steps().filter((x) => x.type === "send_sms")) {
      expect(s.quietHours, `step ${s.id} has no quietHours`).toEqual({ ...KIN_QUIET_HOURS });
    }
    expect(KIN_QUIET_HOURS.timezone).toBe("America/Edmonton");
  });

  it("keeps owner alerts instant (no quiet hours on notify_owner)", () => {
    for (const s of steps().filter((x) => x.type === "notify_owner")) {
      expect(s.quietHours).toBeUndefined();
    }
  });

  it("keeps the cadence Kingsley chose at intake: 2 hours, then next day", () => {
    const waits = steps().filter((s) => s.type === "wait_for_reply");
    expect(waits.map((w) => w.timeoutMinutes)).toEqual([
      KIN_FIRST_FOLLOW_UP_MINUTES,
      KIN_SECOND_FOLLOW_UP_MINUTES,
      KIN_SECOND_FOLLOW_UP_MINUTES
    ]);
    expect(KIN_FIRST_FOLLOW_UP_MINUTES).toBe(120);
    expect(KIN_SECOND_FOLLOW_UP_MINUTES).toBe(1440);
  });

  it("tells an already-booked lead they can ignore the last nudge (JaneApp bookings are invisible to us)", () => {
    const nudge2 = steps().find((s) => s.id === "s_nudge_2");
    expect(nudge2?.body).toContain("If you already booked");
  });

  it("keeps s_goal last, watching replied and appointment_booked", () => {
    const all = steps();
    const last = all[all.length - 1];
    expect(last.id).toBe("s_goal");
    expect(last.events?.map((e) => e.kind).sort()).toEqual(["appointment_booked", "replied"]);
  });

  it("contains no em dashes anywhere in the definition", () => {
    expect(JSON.stringify(buildKinLeadDefinition(LINK))).not.toContain("—");
  });

  it("starts with the placeholder, and the pending check recognizes it", () => {
    // The applier's refusal rests on this exact pair. If someone lands the
    // real link, bookingLinkIsPending() flips false and the applier unlocks.
    expect(bookingLinkIsPending(KIN_JANEAPP_LINK_PENDING)).toBe(true);
    expect(bookingLinkIsPending(LINK)).toBe(false);
    // Deliberately NOT asserting KIN_JANEAPP_BOOKING_LINK is still pending:
    // landing the real link must not fail this suite. Assert only that the
    // default build uses whatever the constant currently is.
    expect(JSON.stringify(buildKinLeadDefinition())).toContain(KIN_JANEAPP_BOOKING_LINK);
  });
});

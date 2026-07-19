/**
 * Regression pins for KYP Ads' canonical flow definition
 * (scripts/oneshot/kyp-offer-definition.ts) — the builder
 * patch-kyp-offer-branch.ts re-applies to the live tenant.
 *
 * Incident (Jul 19 2026): nudges fired at 2:12 AM Toronto because no send
 * step carried quiet hours; James's build notes say "Business hours: 11am to
 * 6pm". These tests fail if the builder ever ships a nudge without the
 * 11:00–18:00 America/Toronto quiet-hours gate — and if the greeting (which
 * must go out within 60 seconds of a new lead, any hour) ever gains one.
 */
import { describe, expect, it } from "vitest";

import {
  buildKypOfferDefinition,
  KYP_QUIET_HOURS
} from "../scripts/oneshot/kyp-offer-definition";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { smsQuietDecision, zonedClock } from "../supabase/functions/_shared/ai_flows/quiet_hours";

type StepJson = {
  id?: string;
  type?: string;
  quietHours?: { timezone?: string; noSendAfter?: string; resumeAt?: string };
  steps?: StepJson[];
  branches?: Array<{ steps?: StepJson[] }>;
  else?: StepJson[];
};

/** Every step in the definition, branch arms and else included. */
function allSteps(definition: Record<string, unknown>): StepJson[] {
  const out: StepJson[] = [];
  const walk = (steps: StepJson[] | undefined) => {
    for (const s of steps ?? []) {
      out.push(s);
      for (const arm of s.branches ?? []) walk(arm.steps);
      walk(s.else);
    }
  };
  walk((definition as { steps?: StepJson[] }).steps);
  return out;
}

/** The literal expected gate — kept independent of the exported constant so
 * a missing/typo'd export can never make the nudge assertions pass vacuously. */
const EXPECTED_QUIET_HOURS = {
  timezone: "America/Toronto",
  noSendAfter: "18:00",
  resumeAt: "11:00"
};

describe("KYP offer definition quiet hours (2 AM nudge regression)", () => {
  const definition = buildKypOfferDefinition();
  const steps = allSteps(definition);
  const smsSteps = steps.filter((s) => s.type === "send_sms");
  const nudges = smsSteps.filter((s) => /_nudge_\d+$/.test(s.id ?? ""));
  const greetings = smsSteps.filter((s) => /_greet$/.test(s.id ?? ""));

  it("still validates as a well-formed AiFlow definition", () => {
    expect(() => parseAiFlowDefinition(definition)).not.toThrow();
  });

  it("has the expected shape (3 arms × greeting + 3 nudges)", () => {
    expect(greetings).toHaveLength(3);
    expect(nudges).toHaveLength(9);
  });

  it("exports the canonical 11am–6pm Toronto quiet-hours config", () => {
    expect(KYP_QUIET_HOURS).toEqual(EXPECTED_QUIET_HOURS);
  });

  it("every nudge carries the 11:00–18:00 America/Toronto quiet-hours gate", () => {
    for (const nudge of nudges) {
      expect(nudge.quietHours, `nudge ${nudge.id} is missing quietHours`).toEqual(
        EXPECTED_QUIET_HOURS
      );
    }
  });

  it("greetings stay ungated (60-second first touch, any hour)", () => {
    for (const greet of greetings) {
      expect(greet.quietHours, `greeting ${greet.id} must NOT have quietHours`).toBeUndefined();
    }
  });

  it("the gate refuses a 2:12 AM Toronto send and resumes at 11:00", () => {
    // Reconstruct the incident instant: Jul 19 2026, 2:12 AM in Toronto
    // (EDT, UTC-4) = 06:12 UTC.
    const nudgeInstantMs = Date.parse("2026-07-19T06:12:00Z");
    const nudge = nudges[0];
    expect(nudge.quietHours).toBeDefined();
    const decision = smsQuietDecision(nudgeInstantMs, {
      timezone: nudge.quietHours!.timezone!,
      noSendAfter: nudge.quietHours!.noSendAfter!,
      resumeAt: nudge.quietHours!.resumeAt!
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      const resumeClock = zonedClock(decision.resumeAtMs, "America/Toronto");
      expect(resumeClock?.minutesOfDay).toBe(11 * 60);
      // Same local day — the deferred nudge goes out that morning.
      expect(decision.resumeAtMs).toBeGreaterThan(nudgeInstantMs);
      expect(decision.resumeAtMs - nudgeInstantMs).toBeLessThanOrEqual(9 * 60 * 60_000);
    }
  });

  it("allows sends inside business hours (2 PM Toronto)", () => {
    const businessHoursMs = Date.parse("2026-07-19T18:00:00Z"); // 2:00 PM EDT
    const decision = smsQuietDecision(businessHoursMs, EXPECTED_QUIET_HOURS);
    expect(decision).toEqual({ allowed: true });
  });
});

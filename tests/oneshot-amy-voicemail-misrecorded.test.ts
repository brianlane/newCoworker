import { describe, expect, it } from "vitest";
import {
  AFFECTED_CALLS,
  ownerAlertBody
} from "../scripts/oneshot/amy-voicemail-misrecorded-calls";

/**
 * amy-voicemail-misrecorded-calls.ts.
 *
 * Three outbound AI calls reached a voicemail and were recorded as
 * conversations, because nothing detected the machine: carrier AMD returned
 * `human_business` (Aug 14) and `human_residence` (Jim Inderberg, Aug 17), and
 * on Jennifer Kline's call AMD was RIGHT while the greeting-end handler
 * cancelled the correct verdict. The cost is not cosmetic: the Needs Follow Up
 * cadence gates its follow-up text on `call_outcome equals no_answer`, so a
 * lead who was never spoken to gets no text and no further calls.
 */
describe("amy-voicemail-misrecorded-calls", () => {
  it("names exactly the three affected calls, with real E.164 numbers", () => {
    expect(AFFECTED_CALLS).toHaveLength(3);
    for (const c of AFFECTED_CALLS) {
      expect(c.e164, c.who).toMatch(/^\+1\d{10}$/);
      expect(c.transcriptId, c.who).toMatch(/^[0-9a-f-]{36}$/);
      expect(c.cause.length, c.who).toBeGreaterThan(0);
    }
    // Distinct rows: a duplicated id would double-count in the alert.
    expect(new Set(AFFECTED_CALLS.map((c) => c.transcriptId)).size).toBe(3);
  });

  it("writes ONE owner text naming every lead and what to do", () => {
    const body = ownerAlertBody(AFFECTED_CALLS);
    for (const c of AFFECTED_CALLS) {
      expect(body).toContain(c.who);
      expect(body).toContain(c.e164);
    }
    expect(body).toContain("reached voicemail but were recorded as answered");
    expect(body).toContain("Worth a call back");
  });

  it("keeps the alert to a sane SMS length", () => {
    // Roughly four segments; this is an operational nudge, not a report.
    expect(ownerAlertBody(AFFECTED_CALLS).length).toBeLessThan(640);
  });

  it("carries no em dash and never says receptionist", () => {
    const body = ownerAlertBody(AFFECTED_CALLS);
    expect(body).not.toMatch(/—/);
    expect(body.toLowerCase()).not.toContain("receptionist");
  });
});

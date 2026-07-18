/**
 * Inbound Calendly webhook verification + handling
 * (src/lib/calendly/webhook-inbound.ts): Stripe-shape signature parsing,
 * replay bound, timing-safe digest compare, event gating, the stale-
 * subscription connection guard, and goal firing through the shared helper.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "crypto";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));
vi.mock("@/lib/voice-tools/connections", () => ({
  resolveCalendarConnection: vi.fn()
}));
vi.mock("@/lib/ai-flows/calendly-booking-goals", () => ({
  fireBookingGoalsForInvitees: vi.fn()
}));
vi.mock("@/lib/db/system-logs", () => ({ recordSystemLog: vi.fn() }));

import {
  CALENDLY_WEBHOOK_TIMESTAMP_TOLERANCE_SEC,
  handleCalendlyWebhookEvent,
  verifyCalendlyWebhookSignature
} from "@/lib/calendly/webhook-inbound";
import { fireBookingGoalsForInvitees } from "@/lib/ai-flows/calendly-booking-goals";
import { resolveCalendarConnection } from "@/lib/voice-tools/connections";
import { recordSystemLog } from "@/lib/db/system-logs";

const BIZ = "11111111-1111-4111-8111-111111111111";
const KEY = "sk-secret";
const NOW = Date.parse("2026-07-18T12:00:00Z");

function sign(rawBody: string, tSec: number, key = KEY): string {
  const v1 = createHmac("sha256", key).update(`${tSec}.${rawBody}`).digest("hex");
  return `t=${tSec},v1=${v1}`;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("verifyCalendlyWebhookSignature", () => {
  const body = '{"event":"invitee.created"}';
  const tSec = Math.floor(NOW / 1000);

  it("accepts a fresh, correctly signed delivery (case-insensitive hex)", () => {
    expect(verifyCalendlyWebhookSignature(body, sign(body, tSec), KEY, NOW)).toBe(true);
    const upper = sign(body, tSec).replace(/v1=(.*)$/, (_, v) => `v1=${v.toUpperCase()}`);
    expect(verifyCalendlyWebhookSignature(body, upper, KEY, NOW)).toBe(true);
  });

  it("rejects missing/malformed headers", () => {
    expect(verifyCalendlyWebhookSignature(body, null, KEY, NOW)).toBe(false);
    expect(verifyCalendlyWebhookSignature(body, "", KEY, NOW)).toBe(false);
    expect(verifyCalendlyWebhookSignature(body, "nonsense", KEY, NOW)).toBe(false);
    expect(verifyCalendlyWebhookSignature(body, "t=abc,v1=00ff", KEY, NOW)).toBe(false);
    expect(verifyCalendlyWebhookSignature(body, `t=${tSec},v1=not-hex`, KEY, NOW)).toBe(false);
    expect(verifyCalendlyWebhookSignature(body, `=orphan,t=${tSec}`, KEY, NOW)).toBe(false);
  });

  it("rejects stale and future timestamps (replay bound)", () => {
    const stale = tSec - CALENDLY_WEBHOOK_TIMESTAMP_TOLERANCE_SEC - 1;
    const future = tSec + CALENDLY_WEBHOOK_TIMESTAMP_TOLERANCE_SEC + 1;
    expect(verifyCalendlyWebhookSignature(body, sign(body, stale), KEY, NOW)).toBe(false);
    expect(verifyCalendlyWebhookSignature(body, sign(body, future), KEY, NOW)).toBe(false);
  });

  it("rejects a digest from the wrong key, a tampered body, and length mismatches", () => {
    expect(
      verifyCalendlyWebhookSignature(body, sign(body, tSec, "other-key"), KEY, NOW)
    ).toBe(false);
    expect(verifyCalendlyWebhookSignature('{"x":1}', sign(body, tSec), KEY, NOW)).toBe(false);
    expect(verifyCalendlyWebhookSignature(body, `t=${tSec},v1=00ff`, KEY, NOW)).toBe(false);
  });
});

describe("handleCalendlyWebhookEvent", () => {
  const db = {} as never;
  const CONN = {
    provider: "calendly" as const,
    providerConfigKey: "calendly-direct",
    connectionId: "cx-1"
  };
  // The row whose signing key verified the delivery, created by CONN.
  const SUB = { connection_key: "calendly-direct:cx-1" };

  it("ignores non-invitee.created events (and non-object bodies)", async () => {
    expect(await handleCalendlyWebhookEvent(db, BIZ, { event: "invitee.canceled" }, SUB)).toEqual({
      handled: false,
      reason: "ignored_event"
    });
    expect(await handleCalendlyWebhookEvent(db, BIZ, null, SUB)).toEqual({
      handled: false,
      reason: "ignored_event"
    });
    expect(fireBookingGoalsForInvitees).not.toHaveBeenCalled();
  });

  it("ignores deliveries for businesses that no longer resolve to Calendly", async () => {
    const resolveConnection = vi
      .fn()
      .mockResolvedValue({ provider: "google", providerConfigKey: "google-calendar", connectionId: "g" });
    expect(
      await handleCalendlyWebhookEvent(
        db,
        BIZ,
        { event: "invitee.created", payload: {} },
        SUB,
        { resolveConnection }
      )
    ).toEqual({ handled: false, reason: "not_connected" });
    expect(fireBookingGoalsForInvitees).not.toHaveBeenCalled();
  });

  it("ignores deliveries from a subscription created by a DIFFERENT connection", async () => {
    const resolveConnection = vi.fn().mockResolvedValue(CONN);
    for (const staleSub of [
      { connection_key: "calendly:old-nango-conn" },
      { connection_key: null }
    ]) {
      expect(
        await handleCalendlyWebhookEvent(
          db,
          BIZ,
          { event: "invitee.created", payload: {} },
          staleSub,
          { resolveConnection }
        )
      ).toEqual({ handled: false, reason: "stale_subscription" });
    }
    expect(fireBookingGoalsForInvitees).not.toHaveBeenCalled();
  });

  it("fires the shared booking-goal helper with the payload invitee", async () => {
    const resolveConnection = vi.fn().mockResolvedValue(CONN);
    vi.mocked(fireBookingGoalsForInvitees).mockResolvedValue({ goalsFired: 2, jumpedRuns: 1 });
    const payload = {
      status: "active",
      email: "tim@example.com",
      text_reminder_number: "+17808039935"
    };
    const out = await handleCalendlyWebhookEvent(
      db,
      BIZ,
      { event: "invitee.created", payload },
      SUB,
      { resolveConnection }
    );
    expect(fireBookingGoalsForInvitees).toHaveBeenCalledWith(db, BIZ, [payload], {
      resolveConnection
    });
    expect(out).toEqual({ handled: true, goalsFired: 2, jumpedRuns: 1 });
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BIZ,
        level: "info",
        event: "ai_flow_goal_jumped_booking",
        payload: { source: "webhook", jumped_runs: 1 }
      })
    );
  });

  it("tolerates a payload-less body and skips the info log when nothing jumped", async () => {
    const resolveConnection = vi.fn().mockResolvedValue(CONN);
    vi.mocked(fireBookingGoalsForInvitees).mockResolvedValue({ goalsFired: 0, jumpedRuns: 0 });
    const out = await handleCalendlyWebhookEvent(
      db,
      BIZ,
      { event: "invitee.created" },
      SUB,
      { resolveConnection }
    );
    expect(fireBookingGoalsForInvitees).toHaveBeenCalledWith(db, BIZ, [{}], {
      resolveConnection
    });
    expect(out).toEqual({ handled: true, goalsFired: 0, jumpedRuns: 0 });
    expect(recordSystemLog).not.toHaveBeenCalled();
  });

  it("uses the module connection resolver by default", async () => {
    vi.mocked(resolveCalendarConnection).mockResolvedValue(null);
    expect(
      await handleCalendlyWebhookEvent(db, BIZ, { event: "invitee.created" }, SUB)
    ).toEqual({
      handled: false,
      reason: "not_connected"
    });
    expect(resolveCalendarConnection).toHaveBeenCalledWith(BIZ);
  });
});

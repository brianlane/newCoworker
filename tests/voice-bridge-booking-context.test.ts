/**
 * Voice-bridge booking-status fetch (vps/voice-bridge/src/booking-context.ts):
 * the bridge asks the platform for the caller's Calendly state
 * (POST /api/internal/contact-booking-context, per-tenant gateway bearer —
 * the same auth pattern as meter-gemini-spend) and appends the answered
 * line to the call's system instruction. Everything fails OPEN to null: a
 * platform hiccup must never delay or degrade call setup beyond a missing
 * context line.
 */
import { describe, expect, it, vi } from "vitest";
import {
  loadVoiceBookingLine,
  VOICE_BOOKING_CONTEXT_TIMEOUT_MS
} from "../vps/voice-bridge/src/booking-context";

const BIZ = "11111111-1111-4111-8111-111111111111";
const PHONE = "+17808039935";
const LINE =
  'This contact has an upcoming booking: "Free Strategy Call" starting 2026-07-23T18:00:00Z.';

function okResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload)
  } as unknown as Response;
}

describe("loadVoiceBookingLine", () => {
  it("POSTs the internal route with the gateway bearer and returns the line", async () => {
    const fetchImpl = vi.fn(async () => okResponse({ ok: true, data: { line: LINE } }));
    const line = await loadVoiceBookingLine({
      appBaseUrl: "https://app.example/",
      gatewayToken: "gw-token",
      businessId: BIZ,
      phone: PHONE,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(line).toBe(LINE);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://app.example/api/internal/contact-booking-context");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer gw-token");
    expect(JSON.parse(init.body as string)).toEqual({ businessId: BIZ, phone: PHONE });
    expect(init.signal).toBeDefined();
  });

  it("null when the app base URL or gateway token is missing", async () => {
    const fetchImpl = vi.fn();
    expect(
      await loadVoiceBookingLine({
        appBaseUrl: "",
        gatewayToken: "gw",
        businessId: BIZ,
        phone: PHONE,
        fetchImpl: fetchImpl as unknown as typeof fetch
      })
    ).toBeNull();
    expect(
      await loadVoiceBookingLine({
        appBaseUrl: "https://app.example",
        gatewayToken: undefined,
        businessId: BIZ,
        phone: PHONE,
        fetchImpl: fetchImpl as unknown as typeof fetch
      })
    ).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("null on a non-2xx answer, an empty/absent line, and unparseable JSON", async () => {
    const rejected = vi.fn(async () => ({ ok: false, status: 403, text: async () => "no" }));
    expect(
      await loadVoiceBookingLine({
        appBaseUrl: "https://app.example",
        gatewayToken: "gw",
        businessId: BIZ,
        phone: PHONE,
        fetchImpl: rejected as unknown as typeof fetch
      })
    ).toBeNull();
    const empty = vi.fn(async () => okResponse({ ok: true, data: { line: "  " } }));
    expect(
      await loadVoiceBookingLine({
        appBaseUrl: "https://app.example",
        gatewayToken: "gw",
        businessId: BIZ,
        phone: PHONE,
        fetchImpl: empty as unknown as typeof fetch
      })
    ).toBeNull();
    const badJson = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("bad json");
      }
    }));
    expect(
      await loadVoiceBookingLine({
        appBaseUrl: "https://app.example",
        gatewayToken: "gw",
        businessId: BIZ,
        phone: PHONE,
        fetchImpl: badJson as unknown as typeof fetch
      })
    ).toBeNull();
  });

  it("fails OPEN (null) when the transport throws or aborts", async () => {
    const thrown = vi.fn(async () => {
      throw new Error("aborted");
    });
    expect(
      await loadVoiceBookingLine({
        appBaseUrl: "https://app.example",
        gatewayToken: "gw",
        businessId: BIZ,
        phone: PHONE,
        fetchImpl: thrown as unknown as typeof fetch
      })
    ).toBeNull();
  });

  it("keeps the timeout budget small enough for call setup", () => {
    expect(VOICE_BOOKING_CONTEXT_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });
});

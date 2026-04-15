import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { TIER_LIMITS } from "@/lib/plans/limits";
import { signStreamUrlPayload } from "@/lib/telnyx/stream-url";
import { signStreamUrlMac } from "../supabase/functions/_shared/stream_url";
import { normalizeE164 } from "../supabase/functions/_shared/normalize_e164";
import { resolveEnterpriseVoiceReservation } from "../supabase/functions/_shared/enterprise_limits";
import {
  VOICE_MSG_BRIDGE_DEGRADED,
  VOICE_MSG_QUOTA_EXHAUSTED,
  VOICE_MSG_SYSTEM_ERROR,
  VOICE_MSG_UNCONFIGURED_NUMBER
} from "../supabase/functions/_shared/voice_messages";
import { verifyTelnyxWebhook, header } from "../supabase/functions/_shared/telnyx_webhook";
import { VOICE_RES_LIMITS } from "../supabase/functions/_shared/voice_reservation_limits";
import {
  SMS_MONTHLY_CAP_STARTER,
  SMS_MONTHLY_CAP_STANDARD
} from "../supabase/functions/_shared/sms_monthly_limits";

describe("_shared/sms_monthly_limits matches TIER_LIMITS SMS caps", () => {
  it("starter and standard monthly SMS", () => {
    expect(TIER_LIMITS.starter.smsPerMonth).toBe(SMS_MONTHLY_CAP_STARTER);
    expect(TIER_LIMITS.standard.smsPerMonth).toBe(SMS_MONTHLY_CAP_STANDARD);
  });
});

describe("_shared/voice_reservation_limits matches TIER_LIMITS voice pool fields", () => {
  (["starter", "standard", "enterprise"] as const).forEach((tier) => {
    it(`${tier} voice cap and concurrency`, () => {
      expect(TIER_LIMITS[tier].voiceIncludedSecondsPerStripePeriod).toBe(
        VOICE_RES_LIMITS[tier].voiceIncludedSecondsPerStripePeriod
      );
      expect(TIER_LIMITS[tier].maxConcurrentCalls).toBe(VOICE_RES_LIMITS[tier].maxConcurrentCalls);
    });
  });
});

describe("_shared/normalize_e164", () => {
  it("returns null for missing or empty", () => {
    expect(normalizeE164(undefined)).toBeNull();
    expect(normalizeE164("")).toBeNull();
  });

  it("passes through + prefix", () => {
    expect(normalizeE164("+44 20 7946 0958")).toBe("+442079460958");
  });

  it("adds +1 for 10-digit US", () => {
    expect(normalizeE164("(555) 123-4567")).toBe("+15551234567");
  });

  it("normalizes 11-digit starting with 1", () => {
    expect(normalizeE164("15551234567")).toBe("+15551234567");
  });

  it("prefixes other digit runs with +", () => {
    expect(normalizeE164("442079460958")).toBe("+442079460958");
  });
});

describe("_shared/enterprise_limits", () => {
  it("uses defaults for null and non-object", () => {
    const d = { tierCapSeconds: 150_000, maxConcurrent: 10 };
    expect(resolveEnterpriseVoiceReservation(null)).toEqual(d);
    expect(resolveEnterpriseVoiceReservation(undefined)).toEqual(d);
    expect(resolveEnterpriseVoiceReservation("x")).toEqual(d);
  });

  it("applies valid overrides", () => {
    expect(
      resolveEnterpriseVoiceReservation({
        voiceIncludedSecondsPerStripePeriod: 500_000,
        maxConcurrentCalls: 25
      })
    ).toEqual({ tierCapSeconds: 500_000, maxConcurrent: 25 });
  });

  it("falls back on invalid numbers", () => {
    expect(
      resolveEnterpriseVoiceReservation({
        voiceIncludedSecondsPerStripePeriod: NaN,
        maxConcurrentCalls: Number.POSITIVE_INFINITY
      })
    ).toEqual({ tierCapSeconds: 150_000, maxConcurrent: 10 });
    expect(
      resolveEnterpriseVoiceReservation({
        voiceIncludedSecondsPerStripePeriod: 30,
        maxConcurrentCalls: 0
      })
    ).toEqual({ tierCapSeconds: 150_000, maxConcurrent: 10 });
  });
});

describe("_shared/voice_messages", () => {
  it("exports non-empty IVR strings", () => {
    expect(VOICE_MSG_UNCONFIGURED_NUMBER.length).toBeGreaterThan(5);
    expect(VOICE_MSG_QUOTA_EXHAUSTED.length).toBeGreaterThan(10);
    expect(VOICE_MSG_BRIDGE_DEGRADED.length).toBeGreaterThan(10);
    expect(VOICE_MSG_SYSTEM_ERROR.length).toBeGreaterThan(5);
  });
});

describe("_shared/stream_url", () => {
  it("matches Node HMAC canonical JSON from src/lib/telnyx/stream-url", async () => {
    const payload = {
      v: 1 as const,
      call_control_id: "cc1",
      business_id: "b1",
      to_e164: "+15550001111",
      exp: 2000000000,
      nonce: "n1"
    };
    const secret = "test-secret";
    expect(await signStreamUrlMac(payload, secret)).toBe(signStreamUrlPayload(payload, secret));
  });
});

describe("_shared/telnyx_webhook", () => {
  it("header is case-insensitive", () => {
    const req = new Request("http://localhost/", {
      headers: { "Telnyx-Timestamp": "123", "X-Other": "a" }
    });
    expect(header(req, "telnyx-timestamp")).toBe("123");
    expect(header(req, "TELNYX-TIMESTAMP")).toBe("123");
    expect(header(req, "missing")).toBeNull();
  });

  it("verifyTelnyxWebhook rejects malformed input", async () => {
    expect(await verifyTelnyxWebhook("{}", null, "1", "dGVzdA==")).toEqual({
      ok: false,
      reason: "malformed"
    });
    expect(await verifyTelnyxWebhook("{}", "e30=", "not-num", "dGVzdA==")).toEqual({
      ok: false,
      reason: "malformed"
    });
  });

  it("verifyTelnyxWebhook rejects stale timestamp", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    const raw32 = spki.subarray(spki.length - 32);
    const pubB64 = raw32.toString("base64");
    const ts = String(Math.floor(Date.now() / 1000) - 99999);
    const body = "{}";
    const sig = sign(null, Buffer.from(`${ts}|${body}`, "utf8"), privateKey).toString("base64");
    expect(await verifyTelnyxWebhook(body, sig, ts, pubB64)).toEqual({
      ok: false,
      reason: "crypto_mismatch"
    });
  });

  it("verifyTelnyxWebhook accepts valid signature", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    const pubB64 = spki.toString("base64");
    const ts = String(Math.floor(Date.now() / 1000));
    const body = '{"x":1}';
    const sig = sign(null, Buffer.from(`${ts}|${body}`, "utf8"), privateKey).toString("base64");
    expect(await verifyTelnyxWebhook(body, sig, ts, pubB64)).toEqual({ ok: true });
  });

  it("verifyTelnyxWebhook rejects wrong message and bad key material", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    const raw32 = spki.subarray(spki.length - 32);
    const pubB64 = raw32.toString("base64");
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = sign(null, Buffer.from(`${ts}|other`, "utf8"), privateKey).toString("base64");
    expect(await verifyTelnyxWebhook("{}", sig, ts, pubB64)).toEqual({
      ok: false,
      reason: "crypto_mismatch"
    });

    const junk = Buffer.alloc(31, 7).toString("base64");
    expect(await verifyTelnyxWebhook("{}", "e30=", ts, junk)).toEqual({
      ok: false,
      reason: "malformed"
    });
  });

  it("verifyTelnyxWebhook handles verify throw and invalid signature base64", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    const pubB64 = spki.toString("base64");
    const ts = String(Math.floor(Date.now() / 1000));
    expect(await verifyTelnyxWebhook("{}", "not!!!valid!!!b64!!!", ts, pubB64)).toEqual({
      ok: false,
      reason: "malformed"
    });

    const verifySpy = vi.spyOn(crypto.subtle, "verify").mockRejectedValueOnce(new Error("x"));
    try {
      const body = "{}";
      const sig = sign(null, Buffer.from(`${ts}|${body}`, "utf8"), privateKey).toString("base64");
      expect(await verifyTelnyxWebhook(body, sig, ts, pubB64)).toEqual({
        ok: false,
        reason: "malformed"
      });
    } finally {
      verifySpy.mockRestore();
    }
  });
});

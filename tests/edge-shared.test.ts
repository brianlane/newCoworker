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
import {
  inboundSmsBody,
  isHelpKeyword,
  isStartKeyword,
  isStopKeyword,
  telnyxSendSms
} from "../supabase/functions/_shared/telnyx_sms_compliance";
import {
  readTelnyxWebhookRateLimits,
  telnyxWebhookClientIp,
  telnyxWebhookRateAllow
} from "../supabase/functions/_shared/telnyx_edge_guard";

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
    expect(normalizeE164("   ")).toBeNull();
  });

  it("passes through + prefix with formatting", () => {
    expect(normalizeE164("+44 20 7946 0958")).toBe("+442079460958");
  });

  it("adds +1 for 10-digit US", () => {
    expect(normalizeE164("(555) 123-4567")).toBe("+15551234567");
  });

  it("normalizes 11-digit starting with 1", () => {
    expect(normalizeE164("15551234567")).toBe("+15551234567");
  });

  it("refuses to invent a country code for bare non-NANP digit runs", () => {
    // Previous behavior was to blindly return `+${digits}` which mis-routed webhook
    // inputs. Strict E.164: if there's no '+' and it's not a 10/11-digit NANP pattern,
    // we don't guess.
    expect(normalizeE164("442079460958")).toBeNull();
    expect(normalizeE164("123456")).toBeNull();
  });

  it("enforces E.164 length bounds", () => {
    expect(normalizeE164("+0555")).toBeNull();
    expect(normalizeE164("+1234567890123456")).toBeNull();
    expect(normalizeE164("+")).toBeNull();
  });

  it("enforces leading non-zero country code digit", () => {
    expect(normalizeE164("+01234567890")).toBeNull();
  });

  it("returns null when input has no digits after formatting is stripped", () => {
    // `cleaned` collapses to "" after stripping non-digit/plus chars — we must not fall
    // through into the NANP guesser with an empty candidate.
    expect(normalizeE164("abc")).toBeNull();
    expect(normalizeE164("(-)")).toBeNull();
  });

  it("rejects structurally valid but too-short E.164 subscriber numbers", () => {
    // `+123456` passes the /^\+[1-9]\d{0,14}$/ regex (6 digits after +, first digit is 1)
    // but fails the minimum-length gate (< 7 digits total) — a common typo, not a real DID.
    expect(normalizeE164("+123456")).toBeNull();
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

describe("_shared/telnyx_sms_compliance", () => {
  it("reads text or body from payload", () => {
    expect(inboundSmsBody({ text: "hi" })).toBe("hi");
    expect(inboundSmsBody({ body: "there" })).toBe("there");
    expect(inboundSmsBody({})).toBe("");
  });

  it("detects STOP variants (uppercase input)", () => {
    expect(isStopKeyword("STOP")).toBe(true);
    expect(isStopKeyword("UNSUBSCRIBE")).toBe(true);
    expect(isStopKeyword("HELP")).toBe(false);
    expect(isStopKeyword("STOPP")).toBe(false);
  });

  it("detects HELP", () => {
    expect(isHelpKeyword("HELP")).toBe(true);
    expect(isHelpKeyword("help")).toBe(false);
  });

  it("detects START / YES / UNSTOP", () => {
    expect(isStartKeyword("START")).toBe(true);
    expect(isStartKeyword("YES")).toBe(true);
    expect(isStartKeyword("UNSTOP")).toBe(true);
    expect(isStartKeyword("STOP")).toBe(false);
  });

  it("telnyxSendSms posts Messages API and returns status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{"data":{}}'
    });
    const r = await telnyxSendSms({
      apiKey: "KEY",
      messagingProfileId: "mp",
      fromE164: "+15550001111",
      toE164: "+15550002222",
      text: "hi",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.telnyx.com/v2/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer KEY" })
      })
    );
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      to: "+15550002222",
      from: "+15550001111",
      text: "hi",
      messaging_profile_id: "mp"
    });
  });

  it("telnyxSendSms uses global fetch when fetchImpl omitted", async () => {
    const g = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => "err"
    });
    vi.stubGlobal("fetch", g);
    try {
      const r = await telnyxSendSms({
        apiKey: "K",
        messagingProfileId: "m",
        fromE164: "+1",
        toE164: "+2",
        text: "x"
      });
      expect(r.ok).toBe(false);
      expect(r.status).toBe(422);
      expect(r.body).toBe("err");
      expect(g).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("_shared/telnyx_edge_guard", () => {
  it("telnyxWebhookClientIp prefers cf-connecting-ip then x-forwarded-for", () => {
    const a = new Request("http://x/", { headers: { "cf-connecting-ip": "203.0.113.1" } });
    expect(telnyxWebhookClientIp(a)).toBe("203.0.113.1");
    const b = new Request("http://x/", { headers: { "x-forwarded-for": "198.51.100.2, 10.0.0.1" } });
    expect(telnyxWebhookClientIp(b)).toBe("198.51.100.2");
    const c = new Request("http://x/");
    expect(telnyxWebhookClientIp(c)).toBe("unknown");
  });

  it("telnyxWebhookClientIp falls back to x-real-ip when XFF first hop empty", () => {
    const req = new Request("http://x/", {
      headers: { "x-forwarded-for": "   , ", "x-real-ip": "192.0.2.1" }
    });
    expect(telnyxWebhookClientIp(req)).toBe("192.0.2.1");
  });

  it("readTelnyxWebhookRateLimits parses env", () => {
    const lim = readTelnyxWebhookRateLimits((k) =>
      k === "TELNYX_WEBHOOK_RATE_MAX_PER_MINUTE" ? "100" : k === "TELNYX_WEBHOOK_RATE_WINDOW_SEC" ? "30" : undefined
    );
    expect(lim).toEqual({ maxPerWindow: 100, windowSeconds: 30, failOpen: false });
    expect(readTelnyxWebhookRateLimits(() => undefined)).toEqual({
      maxPerWindow: 240,
      windowSeconds: 60,
      failOpen: false
    });
    expect(
      readTelnyxWebhookRateLimits((k) =>
        k === "TELNYX_WEBHOOK_RATE_MAX_PER_MINUTE"
          ? "0"
          : k === "TELNYX_WEBHOOK_RATE_WINDOW_SEC"
            ? "nope"
            : undefined
      )
    ).toEqual({ maxPerWindow: 240, windowSeconds: 60, failOpen: false });
    expect(
      readTelnyxWebhookRateLimits((k) =>
        k === "TELNYX_WEBHOOK_RATE_FAIL_OPEN" ? "true" : undefined
      )
    ).toEqual({ maxPerWindow: 240, windowSeconds: 60, failOpen: true });
  });

  it("telnyxWebhookRateAllow passes when RPC ok", async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: { ok: true, hits: 3 }, error: null })
    };
    const r = await telnyxWebhookRateAllow(supabase as never, "1.2.3.4", "r1", {
      maxPerWindow: 100,
      windowSeconds: 60
    });
    expect(r.ok).toBe(true);
    expect(supabase.rpc).toHaveBeenCalledWith("telnyx_webhook_rate_check", {
      p_ip: "1.2.3.4",
      p_route: "r1",
      p_max_per_window: 100,
      p_window_seconds: 60
    });
  });

  it("telnyxWebhookRateAllow fails closed by default when RPC errors", async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: null, error: { message: "x" } })
    };
    const r = await telnyxWebhookRateAllow(supabase as never, "1.1.1.1", "r2", {
      maxPerWindow: 10,
      windowSeconds: 30
    });
    expect(r.ok).toBe(false);
    expect(r.failClosed).toBe(true);
  });

  it("telnyxWebhookRateAllow allows traffic when RPC errors if failOpen=true", async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: null, error: { message: "x" } })
    };
    const r = await telnyxWebhookRateAllow(supabase as never, "1.1.1.1", "r2", {
      maxPerWindow: 10,
      windowSeconds: 30,
      failOpen: true
    });
    expect(r.ok).toBe(true);
  });

  it("telnyxWebhookRateAllow blocks when RPC returns ok false", async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: { ok: false, hits: 999 }, error: null })
    };
    const r = await telnyxWebhookRateAllow(supabase as never, "9.9.9.9", "r3", {
      maxPerWindow: 5,
      windowSeconds: 60
    });
    expect(r.ok).toBe(false);
    expect(r.raw).toEqual({ ok: false, hits: 999 });
  });

  it("telnyxWebhookRateAllow allows when data null but no error", async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: null, error: null })
    };
    const r = await telnyxWebhookRateAllow(supabase as never, "8.8.8.8", "r4", {
      maxPerWindow: 1,
      windowSeconds: 60
    });
    expect(r.ok).toBe(true);
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

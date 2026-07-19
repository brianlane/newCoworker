/**
 * RCS channel on the Node-side Telnyx helper (src/lib/telnyx/messaging.ts):
 *   - rcsTierAllowed / resolveRcsAgentIdForBusiness (tier gate + enable flag
 *     + approved agent id, fail-safe to null on any lookup error)
 *   - getTelnyxMessagingForBusiness({ resolveRcs: true }) threading the agent
 *     id into the config
 *   - sendTelnyxSms RCS-first send with plain-SMS fallback on RCS rejection
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const createSupabaseServiceClient = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient
}));

import {
  getTelnyxMessagingForBusiness,
  rcsChannelActiveForBusiness,
  resolveRcsAgentIdForBusiness,
  rcsTierAllowed,
  sendTelnyxSms
} from "@/lib/telnyx/messaging";

type Row = { data: unknown; error: { message: string } | null };

function makeDb(rows: Record<string, Row>) {
  return {
    from(table: string) {
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: () => Promise.resolve(rows[table] ?? { data: null, error: null })
              };
            }
          };
        }
      };
    }
  } as never;
}

describe("rcsTierAllowed", () => {
  it("allows enterprise only (single-tenant shared agent + per-agent fees, Jul 2026)", () => {
    expect(rcsTierAllowed("enterprise")).toBe(true);
    expect(rcsTierAllowed("standard")).toBe(false);
    expect(rcsTierAllowed("starter")).toBe(false);
    expect(rcsTierAllowed(undefined)).toBe(false);
  });
});

describe("resolveRcsAgentIdForBusiness", () => {
  it("returns the agent id for an enabled enterprise tenant", async () => {
    const db = makeDb({
      businesses: { data: { tier: "enterprise" }, error: null },
      business_channel_settings: {
        data: { rcs_agent_id: "agent_1", rcs_enabled: true },
        error: null
      }
    });
    expect(await resolveRcsAgentIdForBusiness(db, "biz-1")).toBe("agent_1");
  });

  it("fails safe to null on tier error / disallowed tier / missing business", async () => {
    expect(
      await resolveRcsAgentIdForBusiness(
        makeDb({ businesses: { data: null, error: { message: "down" } } }),
        "biz-1"
      )
    ).toBeNull();
    expect(
      await resolveRcsAgentIdForBusiness(
        makeDb({ businesses: { data: { tier: "standard" }, error: null } }),
        "biz-1"
      )
    ).toBeNull();
    expect(await resolveRcsAgentIdForBusiness(makeDb({}), "biz-1")).toBeNull();
  });

  it("returns null on settings error / missing row / disabled / blank agent", async () => {
    const biz: Row = { data: { tier: "enterprise" }, error: null };
    expect(
      await resolveRcsAgentIdForBusiness(
        makeDb({ businesses: biz, business_channel_settings: { data: null, error: { message: "x" } } }),
        "biz-1"
      )
    ).toBeNull();
    expect(
      await resolveRcsAgentIdForBusiness(makeDb({ businesses: biz }), "biz-1")
    ).toBeNull();
    expect(
      await resolveRcsAgentIdForBusiness(
        makeDb({
          businesses: biz,
          business_channel_settings: {
            data: { rcs_agent_id: "agent_1", rcs_enabled: false },
            error: null
          }
        }),
        "biz-1"
      )
    ).toBeNull();
    expect(
      await resolveRcsAgentIdForBusiness(
        makeDb({
          businesses: biz,
          business_channel_settings: { data: { rcs_agent_id: "  ", rcs_enabled: true }, error: null }
        }),
        "biz-1"
      )
    ).toBeNull();
    expect(
      await resolveRcsAgentIdForBusiness(
        makeDb({
          businesses: biz,
          business_channel_settings: { data: { rcs_agent_id: null, rcs_enabled: true }, error: null }
        }),
        "biz-1"
      )
    ).toBeNull();
  });
});

describe("getTelnyxMessagingForBusiness resolveRcs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("TELNYX_API_KEY", "platform_key");
    vi.stubEnv("TELNYX_MESSAGING_PROFILE_ID", "platform_prof");
    vi.stubEnv("TELNYX_SMS_FROM_E164", "+10000000001");
  });

  it("sets rcsAgentId when requested and the tenant is eligible", async () => {
    const db = makeDb({
      business_telnyx_settings: {
        data: { telnyx_messaging_profile_id: "biz_prof", telnyx_sms_from_e164: "+10000000002" },
        error: null
      },
      businesses: { data: { tier: "enterprise" }, error: null },
      business_channel_settings: {
        data: { rcs_agent_id: "agent_7", rcs_enabled: true },
        error: null
      }
    });
    createSupabaseServiceClient.mockResolvedValue(db);
    const cfg = await getTelnyxMessagingForBusiness("biz-1", undefined, { resolveRcs: true });
    expect(cfg.rcsAgentId).toBe("agent_7");
    expect(cfg.messagingProfileId).toBe("biz_prof");
    expect(cfg.fromE164).toBe("+10000000002");
  });

  it("leaves rcsAgentId unset without the flag, null for ineligible tenants", async () => {
    const db = makeDb({
      businesses: { data: { tier: "starter" }, error: null }
    });
    createSupabaseServiceClient.mockResolvedValue(db);
    const plain = await getTelnyxMessagingForBusiness("biz-1");
    expect(plain.rcsAgentId).toBeUndefined();
    const resolved = await getTelnyxMessagingForBusiness("biz-1", undefined, { resolveRcs: true });
    expect(resolved.rcsAgentId).toBeNull();
    // Missing settings row still falls back to platform env.
    expect(resolved.messagingProfileId).toBe("platform_prof");
    expect(resolved.fromE164).toBe("+10000000001");
  });
});

describe("rcsChannelActiveForBusiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("TELNYX_API_KEY", "platform_key");
    vi.stubEnv("TELNYX_MESSAGING_PROFILE_ID", "platform_prof");
    // No platform-level from-number unless a test opts in.
    vi.stubEnv("TELNYX_SMS_FROM_E164", "");
  });

  const eligibleRows = {
    businesses: { data: { tier: "enterprise" }, error: null } as Row,
    business_channel_settings: {
      data: { rcs_agent_id: "agent_9", rcs_enabled: true },
      error: null
    } as Row
  };

  it("is true only when BOTH the agent id and a from-number exist (the send precondition)", async () => {
    const withFrom = makeDb({
      ...eligibleRows,
      business_telnyx_settings: {
        data: { telnyx_messaging_profile_id: null, telnyx_sms_from_e164: "+10000000003" },
        error: null
      }
    });
    expect(await rcsChannelActiveForBusiness(withFrom, "biz-1")).toBe(true);

    // Agent approved but no tenant from-number and no platform fallback:
    // sendTelnyxSms would go plain SMS, so the hint must not claim RCS.
    expect(await rcsChannelActiveForBusiness(makeDb(eligibleRows), "biz-1")).toBe(false);
  });

  it("is false for a tenant without an RCS agent even when a from-number exists", async () => {
    vi.stubEnv("TELNYX_SMS_FROM_E164", "+10000000001");
    const db = makeDb({ businesses: { data: { tier: "starter" }, error: null } });
    expect(await rcsChannelActiveForBusiness(db, "biz-1")).toBe(false);
  });

  it("fails safe to false when the messaging config itself is unavailable", async () => {
    vi.stubEnv("TELNYX_API_KEY", "");
    expect(await rcsChannelActiveForBusiness(makeDb(eligibleRows), "biz-1")).toBe(false);
  });
});

describe("sendTelnyxSms RCS-first", () => {
  const cfg = {
    apiKey: "k",
    messagingProfileId: "p",
    fromE164: "+15550009999",
    rcsAgentId: "agent_1"
  };

  it("sends via /v2/messages/rcs and returns channel rcs", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { id: "rcs_msg_1" } })
    });
    const r = await sendTelnyxSms(cfg, "+15550001111", "Hello!", {
      fetchImpl: fetchMock as typeof fetch,
      idempotencyKey: "idem-9"
    });
    expect(r).toEqual({ id: "rcs_msg_1", channel: "rcs" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.telnyx.com/v2/messages/rcs");
    expect(init.headers).toMatchObject({ "Idempotency-Key": "idem-9" });
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      agent_id: "agent_1",
      to: "+15550001111",
      type: "RCS",
      agent_message: { content_message: { text: "Hello!" } },
      sms_fallback: { from: "+15550009999", text: "Hello!" }
    });
  });

  it("caps sms_fallback text at 3072 chars", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { id: "rcs_msg_2" } })
    });
    await sendTelnyxSms(cfg, "+15550001111", "y".repeat(4000), {
      fetchImpl: fetchMock as typeof fetch
    });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.agent_message.content_message.text).toHaveLength(4000);
    expect(body.sms_fallback.text).toHaveLength(3072);
  });

  it("falls back to plain SMS when the RCS 2xx response has no message id", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: {} })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { id: "sms_msg_noid" } })
      });
    const r = await sendTelnyxSms(cfg, "+15550001111", "Hi", {
      fetchImpl: fetchMock as typeof fetch
    });
    expect(r).toEqual({ id: "sms_msg_noid", channel: "sms" });
    expect(fetchMock.mock.calls[1][0]).toBe("https://api.telnyx.com/v2/messages");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("RCS 2xx with no message id")
    );
    warnSpy.mockRestore();
  });

  it("falls back to plain SMS (warns) when the RCS endpoint rejects", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 400, text: () => Promise.resolve("bad agent") })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { id: "sms_msg_1" } })
      });
    const r = await sendTelnyxSms(cfg, "+15550001111", "Hi", {
      fetchImpl: fetchMock as typeof fetch
    });
    expect(r).toEqual({ id: "sms_msg_1", channel: "sms" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1] as [string, RequestInit])[0]).toBe(
      "https://api.telnyx.com/v2/messages"
    );
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("honors forceChannel: 'sms' (per-message override skips RCS-first)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { id: "sms_forced_1" } })
    });
    const r = await sendTelnyxSms(cfg, "+15550001111", "Plain please", {
      fetchImpl: fetchMock as typeof fetch,
      forceChannel: "sms"
    });
    expect(r).toEqual({ id: "sms_forced_1", channel: "sms" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[0]).toBe(
      "https://api.telnyx.com/v2/messages"
    );
  });

  it("stays plain SMS when the agent id is blank or the from-number is missing", async () => {
    for (const c of [
      { ...cfg, rcsAgentId: "   " },
      { ...cfg, rcsAgentId: null },
      { apiKey: "k", messagingProfileId: "p", rcsAgentId: "agent_1" }
    ]) {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: { id: "sms_msg_2" } })
      });
      const r = await sendTelnyxSms(c, "+15550001111", "Hi", {
        fetchImpl: fetchMock as typeof fetch
      });
      expect(r.channel).toBe("sms");
      expect((fetchMock.mock.calls[0] as [string, RequestInit])[0]).toBe(
        "https://api.telnyx.com/v2/messages"
      );
    }
  });
});

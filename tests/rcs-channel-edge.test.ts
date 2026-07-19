/**
 * RCS channel plumbing (Edge shared modules):
 *   - telnyx_sms_compliance: RCS-aware inbound body parsing, RCS payload
 *     detection, agent-id routing key extraction, and the RCS-first send path
 *     in telnyxSendSms (with plain-SMS fallback on RCS API rejection).
 *   - channel_settings: per-tenant RCS agent resolution (tier gate + enable
 *     flag + approved agent id, fail-safe to null).
 */
import { describe, it, expect, vi } from "vitest";
import {
  inboundSmsBody,
  isRcsInboundPayload,
  rcsInboundAgentId,
  telnyxSendSms
} from "../supabase/functions/_shared/telnyx_sms_compliance";
import {
  resolveRcsAgentId,
  rcsTierAllowed
} from "../supabase/functions/_shared/channel_settings";

describe("inboundSmsBody (RCS shapes)", () => {
  it("reads nested body.text on RCS payloads", () => {
    expect(inboundSmsBody({ type: "RCS", body: { text: "hello rcs" } })).toBe("hello rcs");
  });

  it("reads a tapped suggestion label as the message text", () => {
    expect(
      inboundSmsBody({
        type: "RCS",
        body: { suggestion_response: { text: "Yes, confirm", postback_data: "confirm_1" } }
      })
    ).toBe("Yes, confirm");
  });

  it("returns empty for RCS bodies without text (file/location) and odd shapes", () => {
    expect(inboundSmsBody({ type: "RCS", body: { user_file: { payload: {} } } })).toBe("");
    expect(inboundSmsBody({ type: "RCS", body: { suggestion_response: { postback_data: "x" } } })).toBe("");
    expect(inboundSmsBody({ type: "RCS", body: [] })).toBe("");
    expect(inboundSmsBody({ type: "RCS", body: { suggestion_response: "not-an-object" } })).toBe("");
  });
});

describe("isRcsInboundPayload / rcsInboundAgentId", () => {
  it("detects RCS payloads by type", () => {
    expect(isRcsInboundPayload({ type: "RCS" })).toBe(true);
    expect(isRcsInboundPayload({ type: "SMS" })).toBe(false);
    expect(isRcsInboundPayload({})).toBe(false);
  });

  it("extracts the agent id from to[] entries", () => {
    expect(
      rcsInboundAgentId({ to: [{ agent_id: "agent_1", agent_name: "My Agent" }] })
    ).toBe("agent_1");
  });

  it("accepts a single object `to` and skips non-agent entries", () => {
    expect(rcsInboundAgentId({ to: { agent_id: "agent_2" } })).toBe("agent_2");
    expect(rcsInboundAgentId({ to: [{ phone_number: "+15550001111" }, { agent_id: "agent_3" }] })).toBe(
      "agent_3"
    );
  });

  it("returns null when no agent id is present", () => {
    expect(rcsInboundAgentId({ to: [{ phone_number: "+15550001111" }] })).toBeNull();
    expect(rcsInboundAgentId({ to: "+15550001111" })).toBeNull();
    expect(rcsInboundAgentId({})).toBeNull();
    expect(rcsInboundAgentId({ to: [null, "str", { agent_id: "" }] })).toBeNull();
  });
});

describe("telnyxSendSms RCS-first path", () => {
  const baseParams = {
    apiKey: "KEY",
    messagingProfileId: "mp",
    fromE164: "+15550001111",
    toE164: "+15550002222",
    text: "Hello!"
  };

  it("sends via /v2/messages/rcs with sms_fallback when rcsAgentId is set", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{"data":{"id":"rcs_1"}}'
    });
    const r = await telnyxSendSms({
      ...baseParams,
      rcsAgentId: "agent_1",
      idempotencyKey: "idem-1",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(r.ok).toBe(true);
    expect(r.channel).toBe("rcs");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.telnyx.com/v2/messages/rcs");
    expect(init.headers).toMatchObject({ "Idempotency-Key": "idem-1" });
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      agent_id: "agent_1",
      to: "+15550002222",
      messaging_profile_id: "mp",
      type: "RCS",
      agent_message: { content_message: { text: "Hello!" } },
      sms_fallback: { from: "+15550001111", text: "Hello!" }
    });
  });

  it("caps the sms_fallback text at 3072 chars (RCS body stays full)", async () => {
    const long = "x".repeat(4000);
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "{}"
    });
    await telnyxSendSms({
      ...baseParams,
      text: long,
      rcsAgentId: "agent_1",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.agent_message.content_message.text).toHaveLength(4000);
    expect(body.sms_fallback.text).toHaveLength(3072);
  });

  it("falls back to plain SMS (warns) when the RCS endpoint rejects", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => "agent revoked" })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '{"data":{"id":"sms_1"}}' });
    const r = await telnyxSendSms({
      ...baseParams,
      rcsAgentId: "agent_1",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(r.ok).toBe(true);
    expect(r.channel).toBe("sms");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((fetchImpl.mock.calls[1] as [string, RequestInit])[0]).toBe(
      "https://api.telnyx.com/v2/messages"
    );
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("stays plain SMS for group sends, MMS, missing from, or blank agent id", async () => {
    const cases = [
      { rcsAgentId: "agent_1", toE164: ["+15550002222", "+15550003333"] as string | string[] },
      { rcsAgentId: "agent_1", mediaUrls: ["https://example.com/a.jpg"] },
      { rcsAgentId: "agent_1", fromE164: "" },
      { rcsAgentId: "   " },
      { rcsAgentId: null },
      {}
    ];
    for (const overrides of cases) {
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => "{}"
      });
      const r = await telnyxSendSms({
        ...baseParams,
        ...overrides,
        fetchImpl: fetchImpl as unknown as typeof fetch
      });
      expect(r.channel).toBe("sms");
      expect((fetchImpl.mock.calls[0] as [string, RequestInit])[0]).toBe(
        "https://api.telnyx.com/v2/messages"
      );
    }
  });
});

describe("channel_settings.rcsTierAllowed", () => {
  it("allows enterprise only (single-tenant shared agent + per-agent fees, Jul 2026)", () => {
    expect(rcsTierAllowed("enterprise")).toBe(true);
    expect(rcsTierAllowed("standard")).toBe(false);
    expect(rcsTierAllowed("starter")).toBe(false);
    expect(rcsTierAllowed(null)).toBe(false);
    expect(rcsTierAllowed(undefined)).toBe(false);
  });
});

type Row = { data: unknown; error: { message: string } | null };

function makeSupabase(rows: Record<string, Row>) {
  return {
    from(table: string) {
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: () =>
                  Promise.resolve(rows[table] ?? { data: null, error: null })
              };
            }
          };
        }
      };
    }
  };
}

describe("channel_settings.resolveRcsAgentId", () => {
  const settings = (data: unknown, error: { message: string } | null = null): Row => ({
    data,
    error
  });

  it("returns the agent id for an enabled enterprise tenant (tier passed)", async () => {
    const db = makeSupabase({
      business_channel_settings: settings({ rcs_agent_id: "agent_9", rcs_enabled: true })
    });
    expect(await resolveRcsAgentId(db, "biz-1", "enterprise")).toBe("agent_9");
  });

  it("returns null when tier disallows (no settings query needed)", async () => {
    const db = makeSupabase({});
    expect(await resolveRcsAgentId(db, "biz-1", "starter")).toBeNull();
    expect(await resolveRcsAgentId(db, "biz-1", "standard")).toBeNull();
    expect(await resolveRcsAgentId(db, "biz-1", null)).toBeNull();
  });

  it("looks up the tier when not passed", async () => {
    const db = makeSupabase({
      businesses: settings({ tier: "enterprise" }),
      business_channel_settings: settings({ rcs_agent_id: "agent_2", rcs_enabled: true })
    });
    expect(await resolveRcsAgentId(db, "biz-2")).toBe("agent_2");
  });

  it("fails safe to null on tier lookup error, missing business, or disallowed tier", async () => {
    expect(
      await resolveRcsAgentId(
        makeSupabase({ businesses: settings(null, { message: "boom" }) }),
        "biz-3"
      )
    ).toBeNull();
    expect(await resolveRcsAgentId(makeSupabase({ businesses: settings(null) }), "biz-3")).toBeNull();
    expect(
      await resolveRcsAgentId(makeSupabase({ businesses: settings({ tier: "starter" }) }), "biz-3")
    ).toBeNull();
  });

  it("returns null on settings error, missing row, disabled flag, or blank agent id", async () => {
    expect(
      await resolveRcsAgentId(
        makeSupabase({ business_channel_settings: settings(null, { message: "down" }) }),
        "biz-4",
        "enterprise"
      )
    ).toBeNull();
    expect(
      await resolveRcsAgentId(makeSupabase({}), "biz-4", "enterprise")
    ).toBeNull();
    expect(
      await resolveRcsAgentId(
        makeSupabase({
          business_channel_settings: settings({ rcs_agent_id: "agent_x", rcs_enabled: false })
        }),
        "biz-4",
        "enterprise"
      )
    ).toBeNull();
    expect(
      await resolveRcsAgentId(
        makeSupabase({
          business_channel_settings: settings({ rcs_agent_id: "   ", rcs_enabled: true })
        }),
        "biz-4",
        "enterprise"
      )
    ).toBeNull();
    expect(
      await resolveRcsAgentId(
        makeSupabase({
          business_channel_settings: settings({ rcs_agent_id: null, rcs_enabled: true })
        }),
        "biz-4",
        "enterprise"
      )
    ).toBeNull();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mcp/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp/auth")>();
  return {
    ...actual,
    resolveMcpBusinessId: vi.fn(async (_auth, explicit?: string) => explicit ?? "biz-1"),
    requireMcpBusinessRole: vi.fn(async () => "owner")
  };
});
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn() }));
vi.mock("@/lib/plans/outbound-ai-calls", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/plans/outbound-ai-calls")>();
  return { ...actual, outboundAiCallsAllowedForBusiness: vi.fn(async () => true) };
});
vi.mock("@/lib/db/notification-preferences", () => ({
  getNotificationPreferences: vi.fn(async () => ({ phone_number: "+16025550000" }))
}));
vi.mock("@/lib/ai-flows/db", () => ({
  createAiFlow: vi.fn(async () => ({ id: "flow-new" }))
}));
vi.mock("@/lib/residency/row-delete", () => ({
  restoreContentRows: vi.fn(async () => ({ updated: 1 }))
}));

const limit = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            order: () => ({ limit })
          })
        })
      })
    })
  }))
}));

import { requireMcpBusinessRole } from "@/lib/mcp/auth";
import {
  placeCallTool,
  personaForBrief,
  ASSISTANT_CALL_FLOW_NAME,
  chooseAssistantCallFlow
} from "@/lib/mcp/tools/place-call";
import { restoreContentRows } from "@/lib/residency/row-delete";
import { rateLimit } from "@/lib/rate-limit";
import { outboundAiCallsAllowedForBusiness } from "@/lib/plans/outbound-ai-calls";
import { getNotificationPreferences } from "@/lib/db/notification-preferences";
import { createAiFlow } from "@/lib/ai-flows/db";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { runTool } from "./helpers/run-mcp-tool";

const AUTH = { userId: "user-1", email: "owner@biz.com" };
const BRIEF = "Confirm Thursday at 2 PM Arizona time for the roof inspection.";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(rateLimit).mockReturnValue({ success: true, limit: 10, remaining: 9, reset: 0 });
  vi.mocked(outboundAiCallsAllowedForBusiness).mockResolvedValue(true);
  vi.mocked(getNotificationPreferences).mockResolvedValue({
    phone_number: "+16025550000"
  } as Awaited<ReturnType<typeof getNotificationPreferences>>);
  limit.mockResolvedValue({
    data: [{ id: "flow-1", enabled: true, deleted_at: null }],
    error: null
  });
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.INTERNAL_CRON_SECRET = "cron-secret";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, callControlId: "cc-1", to: "+16025551212" })
    }))
  );
});

describe("place_call", () => {
  it("dials through the existing Assistant calls flow and puts the brief in the persona", async () => {
    const result = await runTool(placeCallTool, { to: "+1 602 555 1212", brief: BRIEF }, AUTH);

    expect(requireMcpBusinessRole).toHaveBeenCalledWith(AUTH, "biz-1", "manage_aiflows");
    expect(createAiFlow).not.toHaveBeenCalled();
    expect(result).toEqual({ dialed: true, to: "+16025551212", call_control_id: "cc-1" });

    const fetchMock = vi.mocked(fetch);
    const init = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(String(init && "body" in init ? init.body : "{}")) as {
      flowId: string;
      call: { persona: string; notifyE164: string; toE164: string };
    };
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://example.supabase.co/functions/v1/telnyx-voice-originate"
    );
    expect(body.flowId).toBe("flow-1");
    expect(body.call.toE164).toBe("+16025551212");
    expect(body.call.notifyE164).toBe("+16025550000");
    expect(body.call.persona).toBe(personaForBrief(BRIEF));
    expect(body.call.persona.length).toBeLessThanOrEqual(500);
  });

  it("creates the Assistant calls flow the first time", async () => {
    limit.mockResolvedValue({ data: null, error: null });

    await runTool(placeCallTool, { to: "+16025551212", brief: BRIEF }, AUTH);

    expect(createAiFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz-1",
        name: ASSISTANT_CALL_FLOW_NAME,
        enabled: true,
        createdBy: "user-1"
      }),
      expect.anything()
    );
    const init = vi.mocked(fetch).mock.calls[0]?.[1];
    const body = JSON.parse(String(init && "body" in init ? init.body : "{}")) as { flowId: string };
    expect(body.flowId).toBe("flow-new");
    const created = vi.mocked(createAiFlow).mock.calls[0]?.[0];
    expect(parseAiFlowDefinition(created?.definition)).toMatchObject({
      trigger: { channel: "voice", direction: "outbound" }
    });
  });

  it("refuses a turned-off flow, a missing alert phone, a blocked tier, and a failed dial", async () => {
    limit.mockResolvedValue({
      data: [{ id: "flow-1", enabled: false, deleted_at: null }],
      error: null
    });
    await expect(runTool(placeCallTool, { to: "+16025551212", brief: BRIEF }, AUTH)).rejects.toThrow(
      /turned off/i
    );

    limit.mockResolvedValue({ data: null, error: null });
    vi.mocked(getNotificationPreferences).mockResolvedValue(null);
    await expect(runTool(placeCallTool, { to: "+16025551212", brief: BRIEF }, AUTH)).rejects.toThrow(
      /alert phone/i
    );
    vi.mocked(getNotificationPreferences).mockResolvedValue({ phone_number: "  " } as Awaited<
      ReturnType<typeof getNotificationPreferences>
    >);
    await expect(runTool(placeCallTool, { to: "+16025551212", brief: BRIEF }, AUTH)).rejects.toThrow(
      /alert phone/i
    );

    vi.mocked(getNotificationPreferences).mockResolvedValue({
      phone_number: "+16025550000"
    } as Awaited<ReturnType<typeof getNotificationPreferences>>);
    vi.mocked(outboundAiCallsAllowedForBusiness).mockResolvedValue(false);
    await expect(runTool(placeCallTool, { to: "+16025551212", brief: BRIEF }, AUTH)).rejects.toThrow(
      /standard/i
    );

    vi.mocked(outboundAiCallsAllowedForBusiness).mockResolvedValue(true);
    limit.mockResolvedValue({
      data: [{ id: "flow-1", enabled: true, deleted_at: null }],
      error: null
    });
    const refusals: Array<[Record<string, unknown>, RegExp]> = [
      [{ ok: false, reason: "tier_blocked" }, /standard/i],
      [{ ok: false, reason: "quota_exhausted" }, /voice minutes/i],
      [{ ok: false, reason: "concurrent_limit" }, /too many calls/i],
      [{ ok: false, reason: "carrier_channel_limit" }, /too many calls/i],
      [{ ok: false, reason: "platform_capacity" }, /too many calls/i],
      [{ ok: false, reason: "invalid_callee" }, /cannot be dialed/i],
      [{ ok: false, reason: "no_caller_id" }, /no voice number/i],
      [{ ok: false, error: "no_telnyx_connection" }, /no voice number/i],
      [{ ok: false, error: "mystery" }, /could not place/i],
      [{ ok: true }, /could not place/i]
    ];
    for (const [payload, pattern] of refusals) {
      vi.mocked(fetch).mockResolvedValue({
        ok: payload.ok === true,
        json: async () => payload
      } as unknown as Response);
      await expect(runTool(placeCallTool, { to: "+16025551212", brief: BRIEF }, AUTH)).rejects.toThrow(
        pattern
      );
    }

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => {
        throw new Error("not json");
      }
    } as unknown as Response);
    await expect(runTool(placeCallTool, { to: "+16025551212", brief: BRIEF }, AUTH)).rejects.toThrow(
      /could not place/i
    );

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, callControlId: "cc-2" })
    } as unknown as Response);
    await expect(runTool(placeCallTool, { to: "+16025551212", brief: BRIEF }, AUTH)).resolves.toMatchObject({
      to: "+16025551212",
      call_control_id: "cc-2"
    });
  });

  it("refuses when origination is not configured or the lookup fails", async () => {
    delete process.env.INTERNAL_CRON_SECRET;
    await expect(runTool(placeCallTool, { to: "+16025551212", brief: BRIEF }, AUTH)).rejects.toThrow(
      /not configured/i
    );
    process.env.INTERNAL_CRON_SECRET = "cron-secret";
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    await expect(runTool(placeCallTool, { to: "+16025551212", brief: BRIEF }, AUTH)).rejects.toThrow(
      /not configured/i
    );
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";

    process.env.INTERNAL_CRON_SECRET = "cron-secret";
    limit.mockResolvedValue({ data: null, error: { message: "db down" } });
    await expect(runTool(placeCallTool, { to: "+16025551212", brief: BRIEF }, AUTH)).rejects.toThrow(
      /look up/i
    );

    vi.mocked(rateLimit).mockReturnValue({ success: false, limit: 10, remaining: 0, reset: 1 });
    await expect(runTool(placeCallTool, { to: "+16025551212", brief: BRIEF }, AUTH)).rejects.toThrow(
      /rate limit/i
    );
  });

  it("restores a soft-deleted Assistant calls flow instead of refusing it", async () => {
    limit.mockResolvedValue({
      data: [{ id: "flow-deleted", enabled: false, deleted_at: "2026-09-01T00:00:00Z" }],
      error: null
    });

    const result = await runTool(placeCallTool, { to: "+16025551212", brief: BRIEF }, AUTH);

    expect(createAiFlow).not.toHaveBeenCalled();
    expect(restoreContentRows).toHaveBeenCalledWith(
      "biz-1",
      "ai_flows",
      [{ column: "id", op: "eq", value: "flow-deleted" }],
      expect.anything(),
      { enabled: true }
    );
    expect(result).toMatchObject({ dialed: true, call_control_id: "cc-1" });
    const init = vi.mocked(fetch).mock.calls[0]?.[1];
    const body = JSON.parse(String(init && "body" in init ? init.body : "{}")) as { flowId: string };
    expect(body.flowId).toBe("flow-deleted");
  });

  it("uses the oldest enabled flow when the name is duplicated", async () => {
    limit.mockResolvedValue({
      data: [
        { id: "flow-off", enabled: false, deleted_at: null },
        { id: "flow-old", enabled: true, deleted_at: null },
        { id: "flow-new-dup", enabled: true, deleted_at: null }
      ],
      error: null
    });

    await runTool(placeCallTool, { to: "+16025551212", brief: BRIEF }, AUTH);

    const init = vi.mocked(fetch).mock.calls[0]?.[1];
    const body = JSON.parse(String(init && "body" in init ? init.body : "{}")) as { flowId: string };
    expect(body.flowId).toBe("flow-old");
    expect(createAiFlow).not.toHaveBeenCalled();
    expect(restoreContentRows).not.toHaveBeenCalled();
  });
});

describe("chooseAssistantCallFlow", () => {
  it("creates when nothing is left, including an empty list", () => {
    expect(chooseAssistantCallFlow([])).toBe("create");
  });
});

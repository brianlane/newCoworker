import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildFleetActivityFeed,
  getFleetRecentActivity,
  type FleetActivityInput
} from "@/lib/db/fleet-activity";
import type { ContactName } from "@/lib/db/contact-names";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));
vi.mock("@/lib/db/contact-names", () => ({
  resolveContactNames: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { resolveContactNames } from "@/lib/db/contact-names";

/** businessId → e164 → name map in the input's nested shape. */
function namesFor(
  businessId: string,
  entries: Record<string, string>
): Map<string, Map<string, ContactName>> {
  const inner = new Map<string, ContactName>(
    Object.entries(entries).map(([e164, name]) => [e164, { name, kind: "customer" as const }])
  );
  return new Map([[businessId, inner]]);
}

const smsPayload = (phone: string) => ({ data: { payload: { from: { phone_number: phone } } } });

function emptyInput(limit = 10): FleetActivityInput {
  return {
    calls: [],
    smsInbound: [],
    smsReplies: [],
    smsOutbound: [],
    emails: [],
    flows: [],
    customers: [],
    logs: [],
    limit
  };
}

describe("buildFleetActivityFeed", () => {
  it("labels calls, using 'unknown caller' when there is no caller id", () => {
    const items = buildFleetActivityFeed({
      ...emptyInput(),
      calls: [
        { business_id: "b1", caller_e164: "+16025550100", status: "completed", started_at: "2026-07-23T10:00:00Z" },
        { business_id: "b1", caller_e164: null, status: "missed", started_at: "2026-07-23T09:00:00Z" }
      ]
    });
    expect(items.map((i) => i.label)).toEqual([
      "Call: +16025550100 (completed)",
      "Call: unknown caller (missed)"
    ]);
    expect(items[0]).toMatchObject({ badge: "Call", variant: "online", businessId: "b1" });
  });

  it("labels inbound texts and skips rows without a parseable phone", () => {
    const items = buildFleetActivityFeed({
      ...emptyInput(),
      smsInbound: [
        { business_id: "b1", payload: smsPayload("+14805550111"), created_at: "2026-07-23T10:00:00Z" },
        { business_id: "b1", payload: null, created_at: "2026-07-23T09:00:00Z" }
      ]
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      badge: "Text in",
      variant: "pending",
      label: "Text from +14805550111"
    });
  });

  it("labels coworker replies and skips rows without a parseable phone", () => {
    const items = buildFleetActivityFeed({
      ...emptyInput(),
      smsReplies: [
        { business_id: "b2", payload: smsPayload("+14805550111"), updated_at: "2026-07-23T10:00:00Z" },
        { business_id: "b2", payload: {}, updated_at: "2026-07-23T09:00:00Z" }
      ]
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      badge: "Text out",
      variant: "neutral",
      label: "Text to +14805550111",
      businessId: "b2"
    });
  });

  it("labels outbound texts and skips rows without a recipient", () => {
    const items = buildFleetActivityFeed({
      ...emptyInput(),
      smsOutbound: [
        { business_id: "b1", to_e164: "+16025550122", created_at: "2026-07-23T10:00:00Z" },
        { business_id: "b1", to_e164: null, created_at: "2026-07-23T09:00:00Z" }
      ]
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.label).toBe("Text to +16025550122");
  });

  it("labels emails by direction with subject and address fallbacks", () => {
    const items = buildFleetActivityFeed({
      ...emptyInput(),
      emails: [
        {
          business_id: "b1",
          direction: "inbound",
          to_email: null,
          from_email: "lead@example.com",
          subject: " Quote request ",
          created_at: "2026-07-23T10:00:00Z"
        },
        {
          business_id: "b1",
          direction: "outbound",
          to_email: "owner@example.com",
          from_email: null,
          subject: "   ",
          created_at: "2026-07-23T09:00:00Z"
        },
        {
          business_id: "b1",
          direction: "outbound",
          to_email: null,
          from_email: null,
          subject: null,
          created_at: "2026-07-23T08:00:00Z"
        }
      ]
    });
    expect(items.map((i) => i.label)).toEqual([
      "Email from lead@example.com: “Quote request”",
      "Email to owner@example.com",
      "Email to unknown address"
    ]);
    expect(items[0]).toMatchObject({ badge: "Email in", variant: "pending" });
    expect(items[1]).toMatchObject({ badge: "Email out", variant: "neutral" });
  });

  it("labels AiFlow runs across the join's object/array/null shapes", () => {
    const items = buildFleetActivityFeed({
      ...emptyInput(),
      flows: [
        { business_id: "b1", status: "completed", created_at: "2026-07-23T10:00:00Z", ai_flows: { name: "Lead intake" } },
        { business_id: "b1", status: "running", created_at: "2026-07-23T09:00:00Z", ai_flows: [{ name: "Nurture" }] },
        { business_id: "b1", status: "failed", created_at: "2026-07-23T08:00:00Z", ai_flows: null }
      ]
    });
    expect(items.map((i) => i.label)).toEqual([
      "AiFlow: Lead intake (completed)",
      "AiFlow: Nurture (running)",
      "AiFlow: AiFlow (failed)"
    ]);
    expect(items[0]).toMatchObject({ badge: "AiFlow", variant: "success" });
  });

  it("labels new customers with the display name when present", () => {
    const items = buildFleetActivityFeed({
      ...emptyInput(),
      customers: [
        { business_id: "b1", display_name: "Jane Doe", customer_e164: "+16025550133", created_at: "2026-07-23T10:00:00Z" },
        { business_id: "b1", display_name: "  ", customer_e164: "+16025550144", created_at: "2026-07-23T09:00:00Z" }
      ]
    });
    expect(items.map((i) => i.label)).toEqual([
      "New customer: Jane Doe (+16025550133)",
      "New customer: +16025550144"
    ]);
    expect(items[0]).toMatchObject({ badge: "New contact", variant: "pending" });
  });

  it("summarizes completed coworker_logs rows with the admin alert summary", () => {
    const items = buildFleetActivityFeed({
      ...emptyInput(),
      logs: [
        {
          id: "log-1",
          business_id: "b3",
          task_type: "provisioning",
          status: "success",
          log_payload: { phase: "finalize", message: "Deploy complete" },
          created_at: "2026-07-23T10:00:00Z"
        },
        {
          id: "log-2",
          business_id: "b3",
          task_type: "data_flow",
          status: "success",
          log_payload: null,
          created_at: "2026-07-23T09:00:00Z"
        }
      ]
    });
    expect(items.map((i) => i.label)).toEqual([
      "Provisioning completed at finalize: Deploy complete",
      "data flow success"
    ]);
    expect(items[0]).toMatchObject({ id: "log:log-1", badge: "provisioning", variant: "success" });
    expect(items[1]!.badge).toBe("data flow");
  });

  it("merges sources newest-first and caps at the limit", () => {
    const items = buildFleetActivityFeed({
      ...emptyInput(2),
      calls: [
        { business_id: "b1", caller_e164: "+1", status: "completed", started_at: "2026-07-23T08:00:00Z" }
      ],
      smsOutbound: [
        { business_id: "b1", to_e164: "+2", created_at: "2026-07-23T10:00:00Z" },
        { business_id: "b1", to_e164: "+3", created_at: "2026-07-23T09:00:00Z" }
      ]
    });
    expect(items.map((i) => i.at)).toEqual(["2026-07-23T10:00:00Z", "2026-07-23T09:00:00Z"]);
  });

  it("shows resolved contact names instead of raw numbers", () => {
    const contactNames = namesFor("b1", {
      "+16025550100": "Jane Doe",
      "+14805550111": "Tim Tsai",
      "+16025550122": "Mike Haas"
    });
    const items = buildFleetActivityFeed({
      ...emptyInput(),
      contactNames,
      calls: [
        { business_id: "b1", caller_e164: "+16025550100", status: "completed", started_at: "2026-07-23T10:00:00Z" }
      ],
      smsInbound: [
        { business_id: "b1", payload: smsPayload("+14805550111"), created_at: "2026-07-23T09:00:00Z" }
      ],
      smsReplies: [
        { business_id: "b1", payload: smsPayload("+14805550111"), updated_at: "2026-07-23T08:00:00Z" }
      ],
      smsOutbound: [
        { business_id: "b1", to_e164: "+16025550122", created_at: "2026-07-23T07:00:00Z" },
        // Unknown number falls back to the raw E.164.
        { business_id: "b1", to_e164: "+19995550000", created_at: "2026-07-23T06:00:00Z" }
      ]
    });
    expect(items.map((i) => i.label)).toEqual([
      "Call: Jane Doe (completed)",
      "Text from Tim Tsai",
      "Text to Tim Tsai",
      "Text to Mike Haas",
      "Text to +19995550000"
    ]);
  });

  it("scopes names to the owning business", () => {
    // The same number resolves for b1 only — b2's row keeps the raw E.164.
    const items = buildFleetActivityFeed({
      ...emptyInput(),
      contactNames: namesFor("b1", { "+16025550122": "Jane Doe" }),
      smsOutbound: [
        { business_id: "b1", to_e164: "+16025550122", created_at: "2026-07-23T10:00:00Z" },
        { business_id: "b2", to_e164: "+16025550122", created_at: "2026-07-23T09:00:00Z" }
      ]
    });
    expect(items.map((i) => i.label)).toEqual(["Text to Jane Doe", "Text to +16025550122"]);
  });

  it("prefers a resolver name over the customer row's own display_name", () => {
    const items = buildFleetActivityFeed({
      ...emptyInput(),
      contactNames: namesFor("b1", { "+16025550133": "Jane D. (VIP)" }),
      customers: [
        { business_id: "b1", display_name: "jane", customer_e164: "+16025550133", created_at: "2026-07-23T10:00:00Z" }
      ]
    });
    expect(items[0]!.label).toBe("New customer: Jane D. (VIP) (+16025550133)");
  });

  it("keeps equal timestamps stable", () => {
    const at = "2026-07-23T10:00:00Z";
    const items = buildFleetActivityFeed({
      ...emptyInput(),
      smsOutbound: [
        { business_id: "b1", to_e164: "+2", created_at: at },
        { business_id: "b1", to_e164: "+3", created_at: at }
      ]
    });
    expect(items.map((i) => i.label)).toEqual(["Text to +2", "Text to +3"]);
  });
});

describe("getFleetRecentActivity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: resolver finds no names (labels fall back to raw numbers).
    vi.mocked(resolveContactNames).mockResolvedValue(new Map());
  });

  // Every source row carries every field any source reads, so one shared
  // mock response exercises the full fetch → shape pipeline.
  const SHARED_ROW = {
    id: "log-1",
    business_id: "b1",
    caller_e164: "+16025550100",
    status: "success",
    started_at: "2026-07-23T10:00:00Z",
    created_at: "2026-07-23T10:00:00Z",
    updated_at: "2026-07-23T10:00:00Z",
    payload: smsPayload("+14805550111"),
    to_e164: "+16025550122",
    direction: "outbound",
    to_email: "owner@example.com",
    from_email: null,
    subject: null,
    ai_flows: { name: "Lead intake" },
    display_name: "Jane",
    customer_e164: "+16025550133",
    task_type: "data_flow",
    log_payload: { summary: "did a thing" }
  };

  function mockDb(limitResult: { data: unknown; error: unknown }) {
    const not = vi.fn().mockReturnThis();
    const db = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
      not,
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(limitResult)
    };
    return { db, not };
  }

  it("merges rows from every source", async () => {
    const { db } = mockDb({ data: [SHARED_ROW], error: null });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const items = await getFleetRecentActivity(20);
    // 8 sources × 1 row each; every one parses (shared row satisfies all).
    expect(items).toHaveLength(8);
    expect(items.every((i) => i.businessId === "b1")).toBe(true);
    expect(db.from).toHaveBeenCalledWith("voice_call_transcripts");
    expect(db.from).toHaveBeenCalledWith("coworker_logs");
  });

  it("applies the mute exclusion to every source", async () => {
    const { db, not } = mockDb({ data: [], error: null });

    await getFleetRecentActivity(10, { excludeBusinessIds: ["biz-a", "biz-b"] }, db as never);
    const muteCalls = not.mock.calls.filter((c) => c[0] === "business_id");
    expect(muteCalls).toHaveLength(8);
    expect(muteCalls[0]).toEqual(["business_id", "in", "(biz-a,biz-b)"]);
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  it("skips the mute clause without exclusions", async () => {
    const { db, not } = mockDb({ data: null, error: null });

    const items = await getFleetRecentActivity(10, {}, db as never);
    expect(items).toEqual([]);
    expect(not.mock.calls.filter((c) => c[0] === "business_id")).toHaveLength(0);
  });

  it("degrades failed sources to empty instead of throwing", async () => {
    const { db } = mockDb({ data: null, error: { message: "boom" } });

    await expect(getFleetRecentActivity(10, undefined, db as never)).resolves.toEqual([]);
  });

  it("defaults the limit", async () => {
    const { db } = mockDb({ data: [], error: null });

    await expect(getFleetRecentActivity(undefined, undefined, db as never)).resolves.toEqual([]);
    expect(db.limit).toHaveBeenCalledWith(10);
  });

  it("resolves contact names once per business and applies them", async () => {
    const { db } = mockDb({ data: [SHARED_ROW], error: null });
    vi.mocked(resolveContactNames).mockResolvedValue(
      new Map([["+16025550122", { name: "Mike Haas", kind: "customer" as const }]])
    );

    const items = await getFleetRecentActivity(20, undefined, db as never);
    // One resolver call for b1, with the union of every phone the feed shows.
    expect(resolveContactNames).toHaveBeenCalledTimes(1);
    const [businessId, nums] = vi.mocked(resolveContactNames).mock.calls[0]!;
    expect(businessId).toBe("b1");
    expect([...nums].sort()).toEqual([
      "+14805550111",
      "+16025550100",
      "+16025550122",
      "+16025550133"
    ]);
    expect(items.map((i) => i.label)).toContain("Text to Mike Haas");
  });

  it("degrades to raw numbers when the resolver fails", async () => {
    const { db } = mockDb({ data: [SHARED_ROW], error: null });
    vi.mocked(resolveContactNames).mockRejectedValue(new Error("boom"));

    const items = await getFleetRecentActivity(20, undefined, db as never);
    expect(items.map((i) => i.label)).toContain("Text to +16025550122");
  });
});

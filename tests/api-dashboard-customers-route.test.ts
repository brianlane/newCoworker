import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(),
  requireBusinessRole: vi.fn()
}));

vi.mock("@/lib/customer-memory/db", () => ({
  listCustomerMemories: vi.fn(),
  getCustomerMemory: vi.fn(),
  listSmsHistoryForCustomer: vi.fn(),
  updateCustomerOwnerFields: vi.fn(),
  setContactSmsReplyMode: vi.fn(),
  deleteCustomerMemory: vi.fn(),
  DEFAULT_LIST_LIMIT: 50,
  MAX_LIST_LIMIT: 200
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(() => ({ success: true, limit: 60, remaining: 59, reset: 0 }))
}));

vi.mock("@/lib/db/employees", () => ({
  getTeamMember: vi.fn()
}));

vi.mock("@/lib/ai-flows/goal-hooks", () => ({ fireGoalEvent: vi.fn() }));

import { GET as LIST_GET } from "@/app/api/dashboard/customers/route";
import {
  GET as DETAIL_GET,
  PATCH as DETAIL_PATCH,
  DELETE as DETAIL_DELETE
} from "@/app/api/dashboard/customers/[customerE164]/route";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import {
  deleteCustomerMemory,
  getCustomerMemory,
  listCustomerMemories,
  listSmsHistoryForCustomer,
  setContactSmsReplyMode,
  updateCustomerOwnerFields
} from "@/lib/customer-memory/db";
import { rateLimit } from "@/lib/rate-limit";
import { getTeamMember } from "@/lib/db/employees";
import { fireGoalEvent } from "@/lib/ai-flows/goal-hooks";

const BIZ = "11111111-1111-4111-8111-111111111111";
const CUSTOMER = "+15551234567";

function listUrl(qs = `?businessId=${BIZ}`): Request {
  return new Request(`http://localhost/api/dashboard/customers${qs}`);
}

function detailUrl(e164 = CUSTOMER, qs = `?businessId=${BIZ}`): Request {
  return new Request(
    `http://localhost/api/dashboard/customers/${encodeURIComponent(e164)}${qs}`
  );
}

function params(rawSegment: string) {
  return { params: Promise.resolve({ customerE164: rawSegment }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(rateLimit).mockReturnValue({
    success: true,
    limit: 60,
    remaining: 59,
    reset: 0
  });
});

describe("GET /api/dashboard/customers (list)", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    const res = await LIST_GET(listUrl());
    expect(res.status).toBe(401);
  });

  it("requires businessId query (400 on missing)", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "u",
      email: "o@o.com",
      isAdmin: false
    });
    const res = await LIST_GET(listUrl(""));
    expect(res.status).toBe(400);
  });

  it("calls requireBusinessRole for non-admin owners — IDOR guard", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "u",
      email: "o@o.com",
      isAdmin: false
    });
    vi.mocked(listCustomerMemories).mockResolvedValueOnce([]);
    await LIST_GET(listUrl());
    expect(requireBusinessRole).toHaveBeenCalledWith(BIZ, "operate_messages");
  });

  it("returns a summary projection — no summary_md/pinned_md leakage in the list view", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "u",
      email: "o@o.com",
      isAdmin: true
    });
    vi.mocked(listCustomerMemories).mockResolvedValueOnce([
      {
        id: "00000000-0000-0000-0000-0000000000aa",
        business_id: BIZ,
        customer_e164: CUSTOMER,
        display_name: "Joe",
        summary_md: "secret summary",
        pinned_md: "secret pinned",
        interaction_count: 0,
        total_interaction_count: 4,
        last_interaction_at: "2026-05-06T10:00:00Z",
        last_summarized_at: "2026-05-06T10:01:00Z",
        last_channel: "voice",
        created_at: "2026-04-01T00:00:00Z",
        updated_at: "2026-05-06T10:01:00Z"
      }
    ] as never);
    const res = await LIST_GET(listUrl());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.customers).toHaveLength(1);
    const item = body.data.customers[0];
    expect(item.customerE164).toBe(CUSTOMER);
    expect(item.displayName).toBe("Joe");
    expect(item.lastChannel).toBe("voice");
    expect(item.totalInteractionCount).toBe(4);
    expect(item.hasPinnedNotes).toBe(true);
    expect(item.hasSummary).toBe(true);
    // Sensitive content NEVER returned in the list — detail route only.
    expect(JSON.stringify(item)).not.toContain("secret summary");
    expect(JSON.stringify(item)).not.toContain("secret pinned");
  });
});

describe("GET /api/dashboard/customers/:e164 (detail)", () => {
  it("returns 404 for missing memory rows", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "u",
      email: "o@o.com",
      isAdmin: true
    });
    vi.mocked(getCustomerMemory).mockResolvedValueOnce(null);
    const res = await DETAIL_GET(detailUrl(), params(encodeURIComponent(CUSTOMER)));
    expect(res.status).toBe(404);
  });

  it("rejects malformed E.164 path segments with 400", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "u",
      email: "o@o.com",
      isAdmin: true
    });
    const res = await DETAIL_GET(detailUrl("not-a-phone"), params("not-a-phone"));
    expect(res.status).toBe(400);
  });

  it("returns the full memory payload + recent SMS history when found", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "u",
      email: "o@o.com",
      isAdmin: true
    });
    vi.mocked(getCustomerMemory).mockResolvedValueOnce({
      id: "00000000-0000-0000-0000-0000000000aa",
      business_id: BIZ,
      customer_e164: CUSTOMER,
      display_name: "Joe",
      summary_md: "Asking about pricing",
      pinned_md: "VIP",
      interaction_count: 0,
      total_interaction_count: 4,
      last_interaction_at: "2026-05-06T10:00:00Z",
      last_summarized_at: "2026-05-06T10:01:00Z",
      last_channel: "voice",
      created_at: "2026-04-01T00:00:00Z",
      updated_at: "2026-05-06T10:01:00Z"
    } as never);
    vi.mocked(listSmsHistoryForCustomer).mockResolvedValueOnce([
      {
        jobId: "j1",
        inboundText: "hi",
        assistantReply: "hi back",
        receivedAt: "2026-05-05T00:00:00Z"
      }
    ]);

    const res = await DETAIL_GET(detailUrl(), params(encodeURIComponent(CUSTOMER)));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.memory.summaryMd).toBe("Asking about pricing");
    expect(body.data.memory.pinnedMd).toBe("VIP");
    expect(body.data.smsHistory).toHaveLength(1);
  });
});

describe("PATCH /api/dashboard/customers/:e164", () => {
  function patchReq(body: object): Request {
    return new Request(detailUrl().url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  }

  it("returns 400 when the body provides neither displayName nor pinnedMd — protects against accidental empty saves clobbering nothing but still bumping updated_at", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "u",
      email: "o@o.com",
      isAdmin: true
    });
    const res = await DETAIL_PATCH(patchReq({}), params(encodeURIComponent(CUSTOMER)));
    expect(res.status).toBe(400);
  });

  it("returns 404 when the memory row is gone (e.g. another tab deleted it) — UI must not show 'Saved' for a no-op write", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "u",
      email: "o@o.com",
      isAdmin: true
    });
    vi.mocked(getCustomerMemory).mockResolvedValueOnce(null);
    const res = await DETAIL_PATCH(
      patchReq({ pinnedMd: "VIP" }),
      params(encodeURIComponent(CUSTOMER))
    );
    expect(res.status).toBe(404);
    expect(updateCustomerOwnerFields).not.toHaveBeenCalled();
  });

  it("forwards partial updates — only the fields the owner edited", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "u",
      email: "o@o.com",
      isAdmin: true
    });
    vi.mocked(getCustomerMemory).mockResolvedValueOnce({
      id: "x",
      business_id: BIZ,
      customer_e164: CUSTOMER
    } as never);
    const res = await DETAIL_PATCH(
      patchReq({ pinnedMd: "VIP — escalate to owner" }),
      params(encodeURIComponent(CUSTOMER))
    );
    expect(res.status).toBe(200);
    expect(updateCustomerOwnerFields).toHaveBeenCalledWith(BIZ, CUSTOMER, {
      displayName: undefined,
      pinnedMd: "VIP — escalate to owner"
    });
  });

  it("stamps name_source='manual' when the owner sets a non-empty name (wins over the derived overlay)", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ userId: "u", email: "o@o.com", isAdmin: true });
    vi.mocked(getCustomerMemory).mockResolvedValueOnce({
      id: "x",
      business_id: BIZ,
      customer_e164: CUSTOMER
    } as never);
    const res = await DETAIL_PATCH(
      patchReq({ displayName: "Amy (cell)" }),
      params(encodeURIComponent(CUSTOMER))
    );
    expect(res.status).toBe(200);
    expect(updateCustomerOwnerFields).toHaveBeenCalledWith(BIZ, CUSTOMER, {
      displayName: "Amy (cell)",
      nameSource: "manual"
    });
  });

  it("resets name_source to 'auto' when the owner CLEARS the name (null), so a later auto-capture isn't treated as a manual override", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ userId: "u", email: "o@o.com", isAdmin: true });
    vi.mocked(getCustomerMemory).mockResolvedValueOnce({
      id: "x",
      business_id: BIZ,
      customer_e164: CUSTOMER
    } as never);
    const res = await DETAIL_PATCH(
      patchReq({ displayName: null }),
      params(encodeURIComponent(CUSTOMER))
    );
    expect(res.status).toBe(200);
    expect(updateCustomerOwnerFields).toHaveBeenCalledWith(BIZ, CUSTOMER, {
      displayName: null,
      nameSource: "auto"
    });
  });

  it("forwards smsReplyMode edits for an existing contact", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ userId: "u", email: "o@o.com", isAdmin: true });
    vi.mocked(getCustomerMemory).mockResolvedValueOnce({
      id: "x",
      business_id: BIZ,
      customer_e164: CUSTOMER
    } as never);
    const res = await DETAIL_PATCH(
      patchReq({ smsReplyMode: "suppress" }),
      params(encodeURIComponent(CUSTOMER))
    );
    expect(res.status).toBe(200);
    expect(updateCustomerOwnerFields).toHaveBeenCalledWith(BIZ, CUSTOMER, {
      smsReplyMode: "suppress"
    });
    expect(setContactSmsReplyMode).not.toHaveBeenCalled();
  });

  it("rejects an unknown smsReplyMode value (400)", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ userId: "u", email: "o@o.com", isAdmin: true });
    const res = await DETAIL_PATCH(
      patchReq({ smsReplyMode: "off" }),
      params(encodeURIComponent(CUSTOMER))
    );
    expect(res.status).toBe(400);
    expect(updateCustomerOwnerFields).not.toHaveBeenCalled();
    expect(setContactSmsReplyMode).not.toHaveBeenCalled();
  });

  it("creates a minimal contact row on a reply-mode-ONLY patch when none exists (thread page toggle for history-only numbers)", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ userId: "u", email: "o@o.com", isAdmin: true });
    vi.mocked(getCustomerMemory).mockResolvedValueOnce(null);
    const res = await DETAIL_PATCH(
      patchReq({ smsReplyMode: "forward_owner" }),
      params(encodeURIComponent(CUSTOMER))
    );
    expect(res.status).toBe(200);
    expect(setContactSmsReplyMode).toHaveBeenCalledWith(BIZ, CUSTOMER, "forward_owner");
    expect(updateCustomerOwnerFields).not.toHaveBeenCalled();
  });

  it("forwards tag edits (replace-the-set) for an existing contact", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ userId: "u", email: "o@o.com", isAdmin: true });
    vi.mocked(getCustomerMemory).mockResolvedValueOnce({
      id: "x",
      business_id: BIZ,
      customer_e164: CUSTOMER
    } as never);
    const res = await DETAIL_PATCH(
      patchReq({ tags: ["VIP", "spanish"] }),
      params(encodeURIComponent(CUSTOMER))
    );
    expect(res.status).toBe(200);
    expect(updateCustomerOwnerFields).toHaveBeenCalledWith(BIZ, CUSTOMER, {
      tags: ["VIP", "spanish"]
    });
    // Both tags are new (the pre-edit row had none) → two tag_added goals.
    expect(fireGoalEvent).toHaveBeenCalledWith(BIZ, CUSTOMER, { kind: "tag_added", tag: "VIP" });
    expect(fireGoalEvent).toHaveBeenCalledWith(BIZ, CUSTOMER, {
      kind: "tag_added",
      tag: "spanish"
    });
  });

  it("fires tag_added goals only for tags the edit actually ADDED", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ userId: "u", email: "o@o.com", isAdmin: true });
    vi.mocked(getCustomerMemory).mockResolvedValueOnce({
      id: "x",
      business_id: BIZ,
      customer_e164: CUSTOMER,
      // The stored spelling carries legacy whitespace: the diff must
      // normalize BOTH sides, or " VIP " would look like a new tag.
      tags: [" VIP ", "New Lead"]
    } as never);
    const res = await DETAIL_PATCH(
      // Keeps VIP (case changed), drops New Lead, adds Engaged.
      patchReq({ tags: ["vip", "Engaged"] }),
      params(encodeURIComponent(CUSTOMER))
    );
    expect(res.status).toBe(200);
    expect(fireGoalEvent).toHaveBeenCalledTimes(1);
    expect(fireGoalEvent).toHaveBeenCalledWith(BIZ, CUSTOMER, {
      kind: "tag_added",
      tag: "Engaged"
    });
  });

  it("non-tag edits fire no goal events", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ userId: "u", email: "o@o.com", isAdmin: true });
    vi.mocked(getCustomerMemory).mockResolvedValueOnce({
      id: "x",
      business_id: BIZ,
      customer_e164: CUSTOMER
    } as never);
    const res = await DETAIL_PATCH(
      patchReq({ pinnedMd: "note" }),
      params(encodeURIComponent(CUSTOMER))
    );
    expect(res.status).toBe(200);
    expect(fireGoalEvent).not.toHaveBeenCalled();
  });

  it("assigns an owner only after validating them against the business roster", async () => {
    const MEMBER = "22222222-2222-4222-8222-222222222222";
    vi.mocked(getAuthUser).mockResolvedValue({ userId: "u", email: "o@o.com", isAdmin: true });
    vi.mocked(getCustomerMemory).mockResolvedValue({
      id: "x",
      business_id: BIZ,
      customer_e164: CUSTOMER
    } as never);
    // Not on the roster → 400, nothing written.
    vi.mocked(getTeamMember).mockResolvedValueOnce(null);
    const rejected = await DETAIL_PATCH(
      patchReq({ ownerEmployeeId: MEMBER }),
      params(encodeURIComponent(CUSTOMER))
    );
    expect(rejected.status).toBe(400);
    expect(updateCustomerOwnerFields).not.toHaveBeenCalled();
    // On the roster → forwarded.
    vi.mocked(getTeamMember).mockResolvedValueOnce({ id: MEMBER, name: "Dave" } as never);
    const ok = await DETAIL_PATCH(
      patchReq({ ownerEmployeeId: MEMBER }),
      params(encodeURIComponent(CUSTOMER))
    );
    expect(ok.status).toBe(200);
    expect(updateCustomerOwnerFields).toHaveBeenCalledWith(BIZ, CUSTOMER, {
      ownerEmployeeId: MEMBER
    });
  });

  it("clears the owner (null) without a roster lookup", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ userId: "u", email: "o@o.com", isAdmin: true });
    vi.mocked(getCustomerMemory).mockResolvedValueOnce({
      id: "x",
      business_id: BIZ,
      customer_e164: CUSTOMER
    } as never);
    const res = await DETAIL_PATCH(
      patchReq({ ownerEmployeeId: null }),
      params(encodeURIComponent(CUSTOMER))
    );
    expect(res.status).toBe(200);
    expect(getTeamMember).not.toHaveBeenCalled();
    expect(updateCustomerOwnerFields).toHaveBeenCalledWith(BIZ, CUSTOMER, {
      ownerEmployeeId: null
    });
  });

  it("still 404s when the row is missing and the patch includes OTHER fields alongside smsReplyMode", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ userId: "u", email: "o@o.com", isAdmin: true });
    vi.mocked(getCustomerMemory).mockResolvedValueOnce(null);
    const res = await DETAIL_PATCH(
      patchReq({ smsReplyMode: "suppress", displayName: "Bot" }),
      params(encodeURIComponent(CUSTOMER))
    );
    expect(res.status).toBe(404);
    expect(setContactSmsReplyMode).not.toHaveBeenCalled();
    expect(updateCustomerOwnerFields).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/dashboard/customers/:e164", () => {
  it("calls deleteCustomerMemory and returns 200 (idempotent — no 404 if already gone)", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "u",
      email: "o@o.com",
      isAdmin: true
    });
    const res = await DETAIL_DELETE(detailUrl(), params(encodeURIComponent(CUSTOMER)));
    expect(res.status).toBe(200);
    expect(deleteCustomerMemory).toHaveBeenCalledWith(BIZ, CUSTOMER);
  });

  it("calls requireBusinessRole for non-admin owners before deleting", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: "u",
      email: "o@o.com",
      isAdmin: false
    });
    await DETAIL_DELETE(detailUrl(), params(encodeURIComponent(CUSTOMER)));
    expect(requireBusinessRole).toHaveBeenCalledWith(BIZ, "operate_messages");
  });
});

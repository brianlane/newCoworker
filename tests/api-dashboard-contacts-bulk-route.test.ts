import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(),
  requireBusinessRole: vi.fn()
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(() => ({ success: true, limit: 10, remaining: 9, reset: 0 }))
}));

// Same mocking altitude as tests/api-dashboard-customers-route.test.ts: the
// LEAF dependencies (db reads/writes, roster, event hooks) are mocked and
// the real src/lib/contacts/bulk logic runs, so the route test exercises the
// route + lib contract end to end. Mocking the sibling lib module itself
// would also double-instrument it and skew its branch coverage.
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => ({ mockDb: true }))
}));
vi.mock("@/lib/customer-memory/db", () => ({
  getCustomerMemory: vi.fn(),
  updateCustomerOwnerFields: vi.fn()
}));
vi.mock("@/lib/db/employees", () => ({ getTeamMember: vi.fn() }));
vi.mock("@/lib/contacts/edit-events", () => ({
  fireTagChangeEvents: vi.fn(),
  fireOwnerAssignedEvent: vi.fn()
}));

import { POST } from "@/app/api/dashboard/contacts/bulk/route";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import {
  getCustomerMemory,
  updateCustomerOwnerFields
} from "@/lib/customer-memory/db";
import { getTeamMember } from "@/lib/db/employees";
import { fireTagChangeEvents } from "@/lib/contacts/edit-events";

const BIZ = "11111111-1111-4111-8111-111111111111";
const EMPLOYEE = "22222222-2222-4222-8222-222222222222";
const KEY = "+15551234567";

function req(body: unknown, qs = `?businessId=${BIZ}`): Request {
  return new Request(`http://localhost/api/dashboard/contacts/bulk${qs}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

function contactRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    business_id: BIZ,
    customer_e164: KEY,
    tags: [] as string[],
    alias_e164s: [] as string[],
    owner_employee_id: null as string | null,
    ...overrides
  } as never;
}

const owner = { userId: "u", email: "o@o.com", isAdmin: false } as never;
const admin = { userId: "a", email: "a@a.com", isAdmin: true } as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(rateLimit).mockReturnValue({ success: true, limit: 10, remaining: 9, reset: 0 });
  vi.mocked(getCustomerMemory).mockResolvedValue(contactRow());
});

describe("POST /api/dashboard/contacts/bulk", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    const res = await POST(req({ action: "add_tag", contactKeys: [KEY], tag: "VIP" }));
    expect(res.status).toBe(401);
  });

  it("requires businessId (400 on missing)", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(owner);
    const res = await POST(req({ action: "add_tag", contactKeys: [KEY], tag: "VIP" }, ""));
    expect(res.status).toBe(400);
  });

  it("gates non-admins on the SAME role the single-contact editor uses", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(owner);
    await POST(req({ action: "add_tag", contactKeys: [KEY], tag: "VIP" }));
    expect(requireBusinessRole).toHaveBeenCalledWith(BIZ, "operate_messages");
  });

  it("lets admins bypass the role gate, matching the rest of the dashboard API", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(admin);
    const res = await POST(req({ action: "add_tag", contactKeys: [KEY], tag: "VIP" }));
    expect(res.status).toBe(200);
    expect(requireBusinessRole).not.toHaveBeenCalled();
  });

  it("returns 429 when the per-business bulk budget is spent", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(owner);
    vi.mocked(rateLimit).mockReturnValue({ success: false, limit: 10, remaining: 0, reset: 0 });
    const res = await POST(req({ action: "add_tag", contactKeys: [KEY], tag: "VIP" }));
    expect(res.status).toBe(429);
    expect(updateCustomerOwnerFields).not.toHaveBeenCalled();
  });

  it("rejects an unknown action", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(owner);
    const res = await POST(req({ action: "delete_all", contactKeys: [KEY] }));
    expect(res.status).toBe(400);
  });

  it("rejects an empty selection", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(owner);
    const res = await POST(req({ action: "add_tag", contactKeys: [], tag: "VIP" }));
    expect(res.status).toBe(400);
  });

  it("rejects more than 200 contacts per request", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(owner);
    const keys = Array.from({ length: 201 }, (_, i) => `+1555${String(i).padStart(7, "0")}`);
    const res = await POST(req({ action: "add_tag", contactKeys: keys, tag: "VIP" }));
    expect(res.status).toBe(400);
    expect(getCustomerMemory).not.toHaveBeenCalled();
  });

  it("rejects a value that is not a contact key", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(owner);
    const res = await POST(
      req({ action: "add_tag", contactKeys: ["not-a-key"], tag: "VIP" })
    );
    expect(res.status).toBe(400);
  });

  it("rejects a tag action without a tag, and assign without a uuid employee", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(owner);
    const noTag = await POST(req({ action: "remove_tag", contactKeys: [KEY] }));
    expect(noTag.status).toBe(400);
    const badEmployee = await POST(
      req({ action: "assign_owner", contactKeys: [KEY], employeeId: "nope" })
    );
    expect(badEmployee.status).toBe(400);
  });

  it("applies a tag action through the shared write path and mirrors the summary", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(owner);
    vi.mocked(getCustomerMemory)
      .mockResolvedValueOnce(contactRow())
      .mockResolvedValueOnce(null);
    const res = await POST(
      req({ action: "add_tag", contactKeys: [KEY, "+15550009999"], tag: "VIP" })
    );
    expect(res.status).toBe(200);
    expect(updateCustomerOwnerFields).toHaveBeenCalledTimes(1);
    expect(updateCustomerOwnerFields).toHaveBeenCalledWith(
      BIZ,
      KEY,
      { tags: ["VIP"] },
      { mockDb: true }
    );
    expect(fireTagChangeEvents).toHaveBeenCalledTimes(1);
    const json = (await res.json()) as { ok: boolean; data: unknown };
    expect(json.ok).toBe(true);
    expect(json.data).toEqual({
      results: [
        { key: KEY, ok: true },
        { key: "+15550009999", ok: false, error: "Contact not found" }
      ],
      updated: 1,
      failed: 1
    });
  });

  it("accepts email-keyed and short-code contacts, same contract as the single route", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(owner);
    vi.mocked(getTeamMember).mockResolvedValue({ id: EMPLOYEE, name: "Dana" } as never);
    const res = await POST(
      req({
        action: "assign_owner",
        contactKeys: ["email:sam@example.com", "30303"],
        employeeId: EMPLOYEE
      })
    );
    expect(res.status).toBe(200);
    expect(getCustomerMemory).toHaveBeenCalledWith(BIZ, "email:sam@example.com", {
      mockDb: true
    });
    expect(getCustomerMemory).toHaveBeenCalledWith(BIZ, "30303", { mockDb: true });
  });

  it("maps a BulkContactError (owner not on the roster) onto a 400 the owner can read", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(owner);
    vi.mocked(getTeamMember).mockResolvedValue(null);
    const res = await POST(
      req({ action: "assign_owner", contactKeys: [KEY], employeeId: EMPLOYEE })
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toBe("That employee is not on this business's roster");
  });

  it("collapses unexpected failures into a 500", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(owner);
    vi.mocked(getTeamMember).mockRejectedValue(new Error("db exploded"));
    const res = await POST(
      req({ action: "assign_owner", contactKeys: [KEY], employeeId: EMPLOYEE })
    );
    expect(res.status).toBe(500);
  });
});

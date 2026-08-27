/**
 * The admin clawback route must be loud about a miss: the RPCs report
 * grant_not_found in-band (jsonb ok:false, no PostgREST error), and the
 * route used to map that to HTTP 200, so a typo'd sourceId or a voice id
 * sent with kind:"sms" read as a completed clawback to every operator and
 * script gating on status (the repo's "ok:true is not a commit" class).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/admin/audit", () => ({ logAdminAction: vi.fn() }));
vi.mock("@/lib/billing/usage-pack-clawback", () => ({
  clawbackUsagePackGrantBySourceId: vi.fn()
}));

import { POST } from "@/app/api/admin/usage-pack-clawback/route";
import { requireAdmin } from "@/lib/auth";
import { logAdminAction } from "@/lib/admin/audit";
import { clawbackUsagePackGrantBySourceId } from "@/lib/billing/usage-pack-clawback";

function post(body: unknown) {
  return new Request("http://localhost/api/admin/usage-pack-clawback", {
    method: "POST",
    body: JSON.stringify(body)
  });
}

const BODY = { sourceId: "cs_test_123", kind: "voice" };

describe("api/admin/usage-pack-clawback route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({
      userId: "admin-1",
      email: "admin@example.com",
      isAdmin: true
    } as never);
    vi.mocked(logAdminAction).mockResolvedValue(undefined as never);
  });

  it("404s when the RPC reports grant_not_found, and audits nothing", async () => {
    vi.mocked(clawbackUsagePackGrantBySourceId).mockResolvedValue({
      ok: true,
      result: { ok: false, reason: "grant_not_found" }
    } as never);
    const res = await POST(post(BODY));
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error.message).toContain("No voice grant matches");
    expect(json.error.message).toContain("Nothing was clawed back");
    expect(logAdminAction).not.toHaveBeenCalled();
  });

  it("200s and audits when the RPC actually voided something", async () => {
    vi.mocked(clawbackUsagePackGrantBySourceId).mockResolvedValue({
      ok: true,
      result: { ok: true, already_voided: false }
    } as never);
    const res = await POST(post(BODY));
    expect(res.status).toBe(200);
    expect(logAdminAction).toHaveBeenCalled();
  });

  it("500s on a transport-level failure", async () => {
    vi.mocked(clawbackUsagePackGrantBySourceId).mockResolvedValue({
      ok: false,
      error: "rpc down"
    } as never);
    const res = await POST(post(BODY));
    expect(res.status).toBe(500);
  });
});

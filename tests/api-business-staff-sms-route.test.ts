import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getAuthUser: vi.fn(), requireBusinessRole: vi.fn() }));
vi.mock("@/lib/db/telnyx-routes", () => ({ setStaffSmsSettings: vi.fn() }));
vi.mock("@/lib/owner-surfaces/staff-mode", () => ({ setStaffMode: vi.fn() }));

import { POST } from "@/app/api/business/staff-sms/route";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { setStaffSmsSettings } from "@/lib/db/telnyx-routes";
import { setStaffMode } from "@/lib/owner-surfaces/staff-mode";

/**
 * The dashboard's Staff texting card.
 *
 * Its two switches now live in two places: "Reply as assistant" is
 * per-surface staff mode (public.coworker_staff_mode), shared with every
 * other surface, and forwarding stays SMS-specific.
 *
 * The load-bearing rule here, and the one Bugbot caught: a field the request
 * did NOT write comes back null, never a re-read. staffModeEnabled resolves
 * a failed lookup to the default (true), and the client applies whatever the
 * response carries to its sibling switch, so echoing a defaulted read would
 * show staff replies as ON while they are still off, and the next save would
 * persist that.
 */

const BIZ = "11111111-1111-4111-8111-111111111111";

function postRequest(body: unknown): Request {
  return new Request("http://localhost/api/business/staff-sms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuthUser).mockResolvedValue({ email: "owner@x.co", isAdmin: false } as never);
  vi.mocked(requireBusinessRole).mockResolvedValue(undefined as never);
  vi.mocked(setStaffSmsSettings).mockResolvedValue({
    staff_sms_forward_to_owner_enabled: false
  } as never);
  vi.mocked(setStaffMode).mockImplementation(async (_b, _s, enabled) => enabled);
});

describe("POST /api/business/staff-sms", () => {
  it("requires authentication", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null as never);
    const res = await POST(postRequest({ businessId: BIZ, assistantReplyEnabled: true }));
    expect(res.status).toBe(401);
  });

  it("rejects a request that changes nothing", async () => {
    const res = await POST(postRequest({ businessId: BIZ }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(setStaffMode).not.toHaveBeenCalled();
  });

  it("writes the reply flag to the shared per-surface store, not the Telnyx row", async () => {
    const res = await POST(postRequest({ businessId: BIZ, assistantReplyEnabled: false }));
    expect(res.status).toBe(200);
    expect(setStaffMode).toHaveBeenCalledWith(BIZ, "sms", false);
    await expect(res.json()).resolves.toMatchObject({
      data: { assistantReplyEnabled: false }
    });
  });

  it("returns null for the reply flag when the request did not write it", async () => {
    // Not false, and above all not a re-read that could default to true.
    const res = await POST(postRequest({ businessId: BIZ, forwardToOwnerEnabled: true }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      data: { assistantReplyEnabled: null }
    });
    expect(setStaffMode).not.toHaveBeenCalled();
  });

  it("keeps forwarding on the Telnyx settings row", async () => {
    vi.mocked(setStaffSmsSettings).mockResolvedValue({
      staff_sms_forward_to_owner_enabled: true
    } as never);
    const res = await POST(postRequest({ businessId: BIZ, forwardToOwnerEnabled: true }));
    expect(setStaffSmsSettings).toHaveBeenCalledWith(BIZ, { forwardToOwnerEnabled: true });
    await expect(res.json()).resolves.toMatchObject({
      data: { forwardToOwnerEnabled: true }
    });
  });

  it("can write both in one request", async () => {
    const res = await POST(
      postRequest({ businessId: BIZ, assistantReplyEnabled: true, forwardToOwnerEnabled: false })
    );
    expect(res.status).toBe(200);
    expect(setStaffMode).toHaveBeenCalledWith(BIZ, "sms", true);
    expect(setStaffSmsSettings).toHaveBeenCalledWith(BIZ, { forwardToOwnerEnabled: false });
  });
});

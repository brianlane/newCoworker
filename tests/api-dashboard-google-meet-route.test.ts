import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ requireBusinessRole: vi.fn() }));
vi.mock("@/lib/db/businesses", () => ({ updateGoogleMeetEnabled: vi.fn() }));

import { PUT } from "@/app/api/dashboard/google-meet/route";
import { requireBusinessRole } from "@/lib/auth";
import { updateGoogleMeetEnabled } from "@/lib/db/businesses";

const BIZ = "11111111-1111-4111-8111-111111111111";

function put(body: unknown) {
  return new Request("http://localhost/api/dashboard/google-meet", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("api/dashboard/google-meet route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireBusinessRole).mockResolvedValue({} as never);
  });

  it("flips the flag for the business in the body", async () => {
    // The businessId is explicit rather than session-derived, so an admin in
    // view-as writes the tenant they are viewing, not their own.
    const res = await PUT(put({ businessId: BIZ, enabled: true }));
    expect(res.status).toBe(200);
    expect(requireBusinessRole).toHaveBeenCalledWith(BIZ, "manage_settings");
    expect(updateGoogleMeetEnabled).toHaveBeenCalledWith(BIZ, true);
  });

  it("turns the flag off too", async () => {
    await PUT(put({ businessId: BIZ, enabled: false }));
    expect(updateGoogleMeetEnabled).toHaveBeenCalledWith(BIZ, false);
  });

  it("refuses a non-uuid business and a non-boolean value without writing", async () => {
    expect((await PUT(put({ businessId: "nope", enabled: true }))).status).toBe(400);
    expect((await PUT(put({ businessId: BIZ, enabled: "yes" }))).status).toBe(400);
    expect(updateGoogleMeetEnabled).not.toHaveBeenCalled();
  });

  it("does not write when the caller lacks manage_settings", async () => {
    vi.mocked(requireBusinessRole).mockRejectedValue(new Error("forbidden"));
    const res = await PUT(put({ businessId: BIZ, enabled: true }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(updateGoogleMeetEnabled).not.toHaveBeenCalled();
  });
});

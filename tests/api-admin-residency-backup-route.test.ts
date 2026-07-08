import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn()
}));

vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn(),
  updateResidencyBackupDestination: vi.fn()
}));

vi.mock("@/lib/residency/backup-keys", () => ({
  setResidencyBackupCustody: vi.fn()
}));

import { POST } from "@/app/api/admin/residency-backup/route";
import { requireAdmin } from "@/lib/auth";
import { getBusiness, updateResidencyBackupDestination } from "@/lib/db/businesses";
import { setResidencyBackupCustody } from "@/lib/residency/backup-keys";
import { ResidencyValidationError } from "@/lib/residency/tier-gate";

const BIZ_ID = "11111111-1111-4111-8111-111111111111";

function makeRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/admin/residency-backup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("api/admin/residency-backup route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({ isAdmin: true } as never);
    vi.mocked(getBusiness).mockResolvedValue({ id: BIZ_ID, tier: "enterprise" } as never);
    vi.mocked(updateResidencyBackupDestination).mockResolvedValue(undefined);
    vi.mocked(setResidencyBackupCustody).mockResolvedValue(undefined);
  });

  it("flips the dump destination to onbox", async () => {
    const res = await POST(makeRequest({ businessId: BIZ_ID, destination: "onbox" }));
    expect(res.status).toBe(200);
    expect(updateResidencyBackupDestination).toHaveBeenCalledWith(BIZ_ID, "onbox");
    expect(setResidencyBackupCustody).not.toHaveBeenCalled();
  });

  it("customer_held custody requires the irreversibility acknowledgment", async () => {
    const refused = await POST(
      makeRequest({ businessId: BIZ_ID, custody: "customer_held" })
    );
    expect(refused.status).toBe(400);
    const json = await refused.json();
    expect(json.error.message).toContain("acknowledgeIrreversible");
    expect(setResidencyBackupCustody).not.toHaveBeenCalled();

    const accepted = await POST(
      makeRequest({
        businessId: BIZ_ID,
        custody: "customer_held",
        acknowledgeIrreversible: true
      })
    );
    expect(accepted.status).toBe(200);
    expect(setResidencyBackupCustody).toHaveBeenCalledWith(BIZ_ID, "customer_held");
  });

  it("escrowed custody needs no acknowledgment, and both knobs can flip together", async () => {
    const res = await POST(
      makeRequest({ businessId: BIZ_ID, destination: "central", custody: "escrowed" })
    );
    expect(res.status).toBe(200);
    expect(updateResidencyBackupDestination).toHaveBeenCalledWith(BIZ_ID, "central");
    expect(setResidencyBackupCustody).toHaveBeenCalledWith(BIZ_ID, "escrowed");
  });

  it("rejects a body with neither knob, unknown values, and missing businesses", async () => {
    const neither = await POST(makeRequest({ businessId: BIZ_ID }));
    expect(neither.status).toBe(400);

    const badDest = await POST(makeRequest({ businessId: BIZ_ID, destination: "s3" }));
    expect(badDest.status).toBe(400);

    vi.mocked(getBusiness).mockResolvedValue(null);
    const missing = await POST(makeRequest({ businessId: BIZ_ID, destination: "onbox" }));
    expect(missing.status).toBe(404);
  });

  it("surfaces the enterprise tier gate as a 400 and unexpected failures as 500", async () => {
    vi.mocked(updateResidencyBackupDestination).mockRejectedValue(
      new ResidencyValidationError("Data residency is an Enterprise plan feature.")
    );
    const gated = await POST(makeRequest({ businessId: BIZ_ID, destination: "onbox" }));
    expect(gated.status).toBe(400);

    vi.mocked(updateResidencyBackupDestination).mockRejectedValue(new Error("db down"));
    const boom = await POST(makeRequest({ businessId: BIZ_ID, destination: "onbox" }));
    expect(boom.status).toBe(500);
  });
});

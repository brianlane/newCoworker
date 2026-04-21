import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn()
}));

vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn()
}));

vi.mock("@/lib/db/vps-ssh-keys", () => ({
  getActiveVpsSshKey: vi.fn(),
  getActiveVpsSshKeyForBusiness: vi.fn()
}));

import { GET } from "@/app/api/admin/vps/[businessId]/ssh-key/route";
import { requireAdmin } from "@/lib/auth";
import { getBusiness } from "@/lib/db/businesses";
import { getActiveVpsSshKey, getActiveVpsSshKeyForBusiness } from "@/lib/db/vps-ssh-keys";

const BIZ_ID = "11111111-1111-4111-8111-111111111111";

function makeBusiness(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: BIZ_ID,
    name: "Corp",
    owner_email: "o@o.com",
    tier: "starter" as const,
    status: "online" as const,
    hostinger_vps_id: "42",
    created_at: "2026-01-01T00:00:00Z",
    ...overrides
  };
}

function makeRow() {
  return {
    id: "row-uuid",
    business_id: BIZ_ID,
    hostinger_vps_id: "42",
    hostinger_public_key_id: 9,
    public_key: "ssh-ed25519 AAA test",
    private_key_pem: "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
    fingerprint_sha256: "SHA256:abc",
    ssh_username: "root",
    created_at: "2026-02-01T00:00:00Z",
    rotated_at: null
  };
}

describe("GET /api/admin/vps/:businessId/ssh-key", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({
      userId: "admin-1",
      email: "admin@example.com",
      isAdmin: true
    } as never);
  });

  it("returns the active key for a business (via hostinger_vps_id lookup)", async () => {
    vi.mocked(getBusiness).mockResolvedValue(makeBusiness());
    vi.mocked(getActiveVpsSshKey).mockResolvedValue(makeRow());

    const response = await GET(new Request("http://x"), {
      params: Promise.resolve({ businessId: BIZ_ID })
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toMatch(/no-store/);
    expect(getActiveVpsSshKey).toHaveBeenCalledWith("42");
    expect(getActiveVpsSshKeyForBusiness).not.toHaveBeenCalled();
    expect(body.data.privateKeyPem).toContain("BEGIN PRIVATE KEY");
    expect(body.data.fingerprint).toBe("SHA256:abc");
    expect(body.data.sshUsername).toBe("root");
  });

  it("falls back to business_id lookup when business has no hostinger_vps_id", async () => {
    vi.mocked(getBusiness).mockResolvedValue(makeBusiness({ hostinger_vps_id: null }));
    vi.mocked(getActiveVpsSshKeyForBusiness).mockResolvedValue(makeRow());

    const response = await GET(new Request("http://x"), {
      params: Promise.resolve({ businessId: BIZ_ID })
    });

    expect(response.status).toBe(200);
    expect(getActiveVpsSshKey).not.toHaveBeenCalled();
    expect(getActiveVpsSshKeyForBusiness).toHaveBeenCalledWith(BIZ_ID);
  });

  it("returns NOT_FOUND when the business does not exist", async () => {
    vi.mocked(getBusiness).mockResolvedValue(null);
    const response = await GET(new Request("http://x"), {
      params: Promise.resolve({ businessId: BIZ_ID })
    });
    const body = await response.json();
    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("returns NOT_FOUND when no key is on file", async () => {
    vi.mocked(getBusiness).mockResolvedValue(makeBusiness());
    vi.mocked(getActiveVpsSshKey).mockResolvedValue(null);

    const response = await GET(new Request("http://x"), {
      params: Promise.resolve({ businessId: BIZ_ID })
    });
    const body = await response.json();
    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("validates the businessId param", async () => {
    const response = await GET(new Request("http://x"), {
      params: Promise.resolve({ businessId: "not-a-uuid" })
    });
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("propagates admin auth failures (403)", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(
      Object.assign(new Error("Admin access required"), { status: 403 })
    );
    const response = await GET(new Request("http://x"), {
      params: Promise.resolve({ businessId: BIZ_ID })
    });
    expect(response.status).toBe(403);
  });
});

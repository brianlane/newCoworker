import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/provisioning/progress", () => ({
  recordProvisioningProgress: vi.fn().mockResolvedValue({
    id: "x",
    business_id: "00000000-0000-4000-8000-000000000001",
    task_type: "provisioning",
    status: "thinking",
    log_payload: {},
    created_at: "2026-01-01T00:00:00Z"
  })
}));

import { POST } from "@/app/api/provisioning/progress/route";
import { recordProvisioningProgress } from "@/lib/provisioning/progress";

describe("POST /api/provisioning/progress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PROVISIONING_PROGRESS_TOKEN = "secret-token";
    process.env.ROWBOAT_GATEWAY_TOKEN = "secret-token";
  });

  it("returns 401 without valid bearer token", async () => {
    const res = await POST(
      new Request("http://localhost/api/provisioning/progress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      })
    );
    expect(res.status).toBe(401);
  });

  it("records progress from VPS payload", async () => {
    const res = await POST(
      new Request("http://localhost/api/provisioning/progress", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          businessId: "00000000-0000-4000-8000-000000000001",
          percent: 55,
          phase: "vault_seeded",
          message: "Vault written"
        })
      })
    );
    expect(res.status).toBe(200);
    expect(recordProvisioningProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "00000000-0000-4000-8000-000000000001",
        percent: 55,
        phase: "vault_seeded",
        source: "vps",
        status: "thinking"
      })
    );
  });

  it("clamps percent in POST body", async () => {
    await POST(
      new Request("http://localhost/api/provisioning/progress", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          businessId: "00000000-0000-4000-8000-000000000001",
          percent: 200,
          phase: "x",
          message: ""
        })
      })
    );
    expect(recordProvisioningProgress).toHaveBeenCalledWith(
      expect.objectContaining({ percent: 100, status: "success" })
    );
  });
});

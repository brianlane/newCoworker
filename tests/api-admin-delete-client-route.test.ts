import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn()
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { DELETE } from "@/app/api/admin/delete-client/route";
import { requireAdmin } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

describe("api/admin/delete-client route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({
      userId: "admin-1",
      email: "admin@example.com",
      isAdmin: true
    } as never);
  });

  it("returns ok when the business is deleted", async () => {
    const db = {
      from: vi.fn().mockReturnThis(),
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const response = await DELETE(new Request("http://localhost/api/admin/delete-client", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        businessId: "11111111-1111-4111-8111-111111111111"
      })
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: { deleted: true }
    });
  });

  it("maps database failures to DB_ERROR", async () => {
    const db = {
      from: vi.fn().mockReturnThis(),
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: { message: "delete failed" } })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const response = await DELETE(new Request("http://localhost/api/admin/delete-client", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        businessId: "11111111-1111-4111-8111-111111111111"
      })
    }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("DB_ERROR");
    expect(body.error.message).toBe("delete failed");
  });
});

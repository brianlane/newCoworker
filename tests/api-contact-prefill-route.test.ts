import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/marketing/contact-prefill", () => ({
  resolveContactPrefill: vi.fn()
}));

import { GET } from "@/app/api/contact/prefill/route";
import { resolveContactPrefill } from "@/lib/marketing/contact-prefill";

describe("GET /api/contact/prefill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty object for anonymous visitors", async () => {
    vi.mocked(resolveContactPrefill).mockResolvedValue({});
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("returns signed-in prefill fields", async () => {
    vi.mocked(resolveContactPrefill).mockResolvedValue({
      name: "Ada",
      email: "ada@example.com",
      businessName: "Analytical Engines"
    });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: "Ada",
      email: "ada@example.com",
      businessName: "Analytical Engines"
    });
  });
});

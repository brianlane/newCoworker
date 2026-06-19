import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cron-auth", () => ({ assertCronAuth: vi.fn() }));
vi.mock("@/lib/ai-flows/library-refresh", () => ({ refreshAiFlowLibrary: vi.fn() }));

import { POST } from "@/app/api/internal/aiflow-library-refresh/route";
import { assertCronAuth } from "@/lib/cron-auth";
import { refreshAiFlowLibrary } from "@/lib/ai-flows/library-refresh";

function req() {
  return new Request("http://localhost/api/internal/aiflow-library-refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
}

describe("api/internal/aiflow-library-refresh route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(assertCronAuth).mockReturnValue(true);
  });

  it("403 without the cron bearer", async () => {
    vi.mocked(assertCronAuth).mockReturnValue(false);
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(refreshAiFlowLibrary).not.toHaveBeenCalled();
  });

  it("runs one refresh and returns its counts", async () => {
    vi.mocked(refreshAiFlowLibrary).mockResolvedValue({
      candidates: 5,
      groups: 2,
      published: 2,
      skipped: 0
    });
    const res = await POST(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data).toEqual({ candidates: 5, groups: 2, published: 2, skipped: 0 });
  });

  it("maps a thrown refresh failure to the standard error contract", async () => {
    vi.mocked(refreshAiFlowLibrary).mockRejectedValue(new Error("db down"));
    const res = await POST(req());
    expect(res.status).toBeGreaterThanOrEqual(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cron-auth", () => ({
  assertCronAuth: vi.fn()
}));
vi.mock("@/lib/onboarding/abandoned-signup-cleanup", () => ({
  sweepAbandonedSignups: vi.fn()
}));
vi.mock("@/lib/cron/sweep-run", () => ({
  withSweepRun: (_sweep: string, handler: (req: Request) => Promise<Response>) => handler
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

import { POST } from "@/app/api/internal/abandoned-signup-sweep/route";
import { assertCronAuth } from "@/lib/cron-auth";
import { sweepAbandonedSignups } from "@/lib/onboarding/abandoned-signup-cleanup";

const request = () =>
  new Request("https://example.com/api/internal/abandoned-signup-sweep", { method: "POST" });

const emptyResult = {
  scanned: 0,
  deleted: [],
  skipped: [],
  errors: [],
  cappedAtLimit: false,
  dryRun: false
};

describe("POST /api/internal/abandoned-signup-sweep", () => {
  beforeEach(() => {
    vi.mocked(assertCronAuth).mockReset();
    vi.mocked(sweepAbandonedSignups).mockReset();
  });

  it("rejects a request without the cron bearer", async () => {
    vi.mocked(assertCronAuth).mockReturnValue(false);

    const res = await POST(request());

    expect(res.status).toBe(403);
    expect(sweepAbandonedSignups).not.toHaveBeenCalled();
  });

  it("runs the sweep and returns its result", async () => {
    vi.mocked(assertCronAuth).mockReturnValue(true);
    vi.mocked(sweepAbandonedSignups).mockResolvedValue({
      ...emptyResult,
      scanned: 11,
      deleted: [
        {
          id: "a912aff5-dd87-49fb-ad6a-477acefb66c0",
          name: "KIN Integrated Child Health",
          createdAt: "2026-08-21T21:35:34.393Z"
        }
      ],
      skipped: [{ id: "8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d", reason: "owner_claimed" }]
    });

    const res = await POST(request());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.sweep).toBe("abandoned-signup-sweep");
    expect(body.data.scanned).toBe(11);
    expect(body.data.deleted).toHaveLength(1);
    expect(typeof body.data.durationMs).toBe("number");
  });

  it("returns 500 when the sweep throws", async () => {
    vi.mocked(assertCronAuth).mockReturnValue(true);
    vi.mocked(sweepAbandonedSignups).mockRejectedValue(new Error("db down"));

    const res = await POST(request());

    expect(res.status).toBe(500);
  });

  it("returns 500 when the sweep throws a non-Error", async () => {
    vi.mocked(assertCronAuth).mockReturnValue(true);
    vi.mocked(sweepAbandonedSignups).mockRejectedValue("boom");

    const res = await POST(request());

    expect(res.status).toBe(500);
  });
});

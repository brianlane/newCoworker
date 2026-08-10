/**
 * The internal Slack worker endpoint (/api/internal/slack-worker): the cron
 * bearer is the only door in, and the batch summary passes through.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cron-auth", () => ({ assertCronAuth: vi.fn() }));
vi.mock("@/lib/slack/worker", () => ({ processSlackJobs: vi.fn() }));
vi.mock("@/lib/cron/sweep-run", () => ({
  withSweepRun: (_job: string, fn: (req: Request) => Promise<Response>) => fn
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { POST } from "@/app/api/internal/slack-worker/route";
import { assertCronAuth } from "@/lib/cron-auth";
import { processSlackJobs } from "@/lib/slack/worker";

function req() {
  return new Request("https://x/api/internal/slack-worker", { method: "POST", body: "{}" });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(assertCronAuth).mockReturnValue(true);
  vi.mocked(processSlackJobs).mockResolvedValue({ reclaimed: 1, processed: 2, failed: 0 });
});

describe("POST /api/internal/slack-worker", () => {
  it("refuses a bad bearer", async () => {
    vi.mocked(assertCronAuth).mockReturnValue(false);
    expect((await POST(req())).status).toBe(403);
    expect(vi.mocked(processSlackJobs)).not.toHaveBeenCalled();
  });

  it("drains the batch and reports the summary (quiet runs log nothing)", async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: { reclaimed: 1, processed: 2, failed: 0 }
    });

    vi.mocked(processSlackJobs).mockResolvedValue({ reclaimed: 0, processed: 0, failed: 0 });
    expect((await POST(req())).status).toBe(200);
  });
});

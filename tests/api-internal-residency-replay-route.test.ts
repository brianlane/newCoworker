import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cron-auth", () => ({
  assertCronAuth: vi.fn()
}));

vi.mock("@/lib/residency/replay", () => ({
  runResidencyReplay: vi.fn()
}));

const { loggerInfo, loggerError } = vi.hoisted(() => ({
  loggerInfo: vi.fn(),
  loggerError: vi.fn()
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: loggerInfo, error: loggerError, warn: vi.fn(), debug: vi.fn() }
}));

import { POST } from "@/app/api/internal/residency-replay/route";
import { assertCronAuth } from "@/lib/cron-auth";
import { runResidencyReplay } from "@/lib/residency/replay";

function makeRequest(): Request {
  return new Request("http://localhost/api/internal/residency-replay", {
    method: "POST",
    headers: { Authorization: "Bearer secret" },
    body: "{}"
  });
}

describe("api/internal/residency-replay route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(assertCronAuth).mockReturnValue(true);
  });

  it("403s on a bad cron bearer", async () => {
    vi.mocked(assertCronAuth).mockReturnValue(false);
    const res = await POST(makeRequest());
    expect(res.status).toBe(403);
    expect(runResidencyReplay).not.toHaveBeenCalled();
  });

  it("runs the replay and returns the summary", async () => {
    vi.mocked(runResidencyReplay).mockResolvedValue({
      businesses: [{ businessId: "b", replayed: 3, skipped: 0 }],
      totalReplayed: 3,
      totalSkipped: 0,
      totalErrors: 0
    });
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.totalReplayed).toBe(3);
    expect(loggerInfo).toHaveBeenCalled();
  });

  it("stays quiet in the log on an all-idle run", async () => {
    vi.mocked(runResidencyReplay).mockResolvedValue({
      businesses: [],
      totalReplayed: 0,
      totalSkipped: 0,
      totalErrors: 0
    });
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(loggerInfo).not.toHaveBeenCalled();
  });

  it("500s when the replayer throws", async () => {
    vi.mocked(runResidencyReplay).mockRejectedValue(new Error("rpc down"));
    const res = await POST(makeRequest());
    expect(res.status).toBe(500);
    expect(loggerError).toHaveBeenCalled();
  });

  it("stringifies non-Error throws", async () => {
    vi.mocked(runResidencyReplay).mockRejectedValue("string bomb");
    const res = await POST(makeRequest());
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error.message).toContain("string bomb");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cron-auth", () => ({
  assertCronAuth: vi.fn().mockReturnValue(true)
}));
vi.mock("@/lib/call-summaries/summarizer", () => ({
  summarizeCallTranscript: vi.fn()
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import { POST } from "@/app/api/internal/summarize-call/route";
import { assertCronAuth } from "@/lib/cron-auth";
import { summarizeCallTranscript } from "@/lib/call-summaries/summarizer";
import { logger } from "@/lib/logger";

const BIZ = "00000000-0000-4000-8000-000000000001";
const TID = "00000000-0000-4000-8000-000000000002";

function post(body: unknown) {
  return POST(
    new Request("http://localhost/api/internal/summarize-call", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer secret" },
      body: typeof body === "string" ? body : JSON.stringify(body)
    })
  );
}

describe("POST /api/internal/summarize-call", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(assertCronAuth).mockReturnValue(true);
  });

  it("403s without a valid cron bearer", async () => {
    vi.mocked(assertCronAuth).mockReturnValue(false);
    const res = await post({ businessId: BIZ, transcriptId: TID });
    expect(res.status).toBe(403);
    expect(summarizeCallTranscript).not.toHaveBeenCalled();
  });

  it("400s on an invalid body", async () => {
    const res = await post({ businessId: "not-a-uuid", transcriptId: TID });
    expect(res.status).toBe(400);
    expect(summarizeCallTranscript).not.toHaveBeenCalled();
  });

  it("400s on unparseable JSON", async () => {
    const res = await post("{nope");
    expect(res.status).toBe(400);
  });

  it("returns the success shape and logs at info", async () => {
    vi.mocked(summarizeCallTranscript).mockResolvedValue({
      ok: true,
      summary: "Caller booked a repair.",
      sentiment: "positive",
      turnCount: 4
    });
    const res = await post({ businessId: BIZ, transcriptId: TID, source: "cron_sweep" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { ok: boolean; sentiment: string } };
    expect(json.data.ok).toBe(true);
    expect(json.data.sentiment).toBe("positive");
    expect(summarizeCallTranscript).toHaveBeenCalledWith(BIZ, TID);
    expect(logger.info).toHaveBeenCalledWith(
      "summarize-call ok",
      expect.objectContaining({ source: "cron_sweep", sentiment: "positive" })
    );
  });

  it("logs expected skips at info", async () => {
    vi.mocked(summarizeCallTranscript).mockResolvedValue({ ok: false, reason: "tier" });
    const res = await post({ businessId: BIZ, transcriptId: TID });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { ok: boolean; reason: string } };
    expect(json.data).toMatchObject({ ok: false, reason: "tier" });
    expect(logger.info).toHaveBeenCalledWith(
      "summarize-call skipped/failed",
      expect.objectContaining({ reason: "tier", source: "unknown" })
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs real failures at warn", async () => {
    vi.mocked(summarizeCallTranscript).mockResolvedValue({
      ok: false,
      reason: "gemini_failed",
      detail: "gemini_http_500"
    });
    const res = await post({ businessId: BIZ, transcriptId: TID });
    expect(res.status).toBe(200);
    expect(logger.warn).toHaveBeenCalledWith(
      "summarize-call skipped/failed",
      expect.objectContaining({ reason: "gemini_failed", detail: "gemini_http_500" })
    );
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cron-auth", () => ({ assertCronAuth: vi.fn() }));
vi.mock("@/lib/ai-flows/email-poll", () => ({ pollEmailTriggers: vi.fn() }));

import { POST } from "@/app/api/internal/aiflow-email-poll/route";
import { assertCronAuth } from "@/lib/cron-auth";
import { pollEmailTriggers } from "@/lib/ai-flows/email-poll";

function req() {
  return new Request("http://localhost/api/internal/aiflow-email-poll", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
}

describe("api/internal/aiflow-email-poll route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(assertCronAuth).mockReturnValue(true);
  });

  it("403 without the cron bearer", async () => {
    vi.mocked(assertCronAuth).mockReturnValue(false);
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(pollEmailTriggers).not.toHaveBeenCalled();
  });

  it("runs one poll and returns its counts", async () => {
    vi.mocked(pollEmailTriggers).mockResolvedValue({
      flows: 2,
      mailboxes: 1,
      messages: 3,
      enqueued: 1
    });
    const res = await POST(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data).toEqual({ flows: 2, mailboxes: 1, messages: 3, enqueued: 1 });
  });

  it("maps a thrown poll failure to the standard error contract", async () => {
    vi.mocked(pollEmailTriggers).mockRejectedValue(new Error("db down"));
    const res = await POST(req());
    expect(res.status).toBeGreaterThanOrEqual(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });
});

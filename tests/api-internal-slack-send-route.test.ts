/**
 * The internal Slack delivery bridge (/api/internal/slack-send), which is
 * how the Deno notification mirrors reach Slack without holding any Slack
 * secret. Pinned: the cron bearer is the only door in, and structured
 * ok:false outcomes pass through as 200s (they are policy skips the caller
 * records, not transport failures).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cron-auth", () => ({ assertCronAuth: vi.fn() }));
vi.mock("@/lib/slack/deliver", () => ({ deliverSlackAlert: vi.fn() }));

import { POST } from "@/app/api/internal/slack-send/route";
import { assertCronAuth } from "@/lib/cron-auth";
import { deliverSlackAlert } from "@/lib/slack/deliver";

const BIZ = "11111111-1111-4111-8111-111111111111";

function req(body: unknown) {
  return new Request("https://x/api/internal/slack-send", {
    method: "POST",
    body: JSON.stringify(body)
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(assertCronAuth).mockReturnValue(true);
  vi.mocked(deliverSlackAlert).mockResolvedValue({
    ok: true,
    channelId: "C-1",
    channelName: "leads",
    ts: "1.2"
  });
});

describe("POST /api/internal/slack-send", () => {
  it("refuses a bad bearer", async () => {
    vi.mocked(assertCronAuth).mockReturnValue(false);
    const res = await POST(req({ businessId: BIZ, text: "hi" }));
    expect(res.status).toBe(403);
    expect(vi.mocked(deliverSlackAlert)).not.toHaveBeenCalled();
  });

  it("validates the body", async () => {
    const res = await POST(req({ businessId: "nope", text: "" }));
    expect(res.status).not.toBe(200);
  });

  it("delivers and returns the structured result", async () => {
    const res = await POST(req({ businessId: BIZ, text: "hi", blocks: [{ a: 1 }] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { ok: true, channelName: "leads" } });
    expect(vi.mocked(deliverSlackAlert)).toHaveBeenCalledWith({
      businessId: BIZ,
      text: "hi",
      blocks: [{ a: 1 }]
    });
  });

  it("passes policy skips through as 200s", async () => {
    vi.mocked(deliverSlackAlert).mockResolvedValue({
      ok: false,
      reason: "no_alert_channel"
    });
    const res = await POST(req({ businessId: BIZ, text: "hi" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { ok: false, reason: "no_alert_channel" } });
  });
});

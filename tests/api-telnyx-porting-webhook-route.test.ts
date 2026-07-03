import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/telnyx/webhook-verify", () => ({
  verifyTelnyxWebhookSignature: vi.fn()
}));

vi.mock("@/lib/byon/port-requests", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/byon/port-requests")>();
  return { ...actual, handlePortingStatusChange: vi.fn() };
});

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import { POST } from "@/app/api/telnyx/porting-webhook/route";
import { verifyTelnyxWebhookSignature } from "@/lib/telnyx/webhook-verify";
import { handlePortingStatusChange } from "@/lib/byon/port-requests";
import { logger } from "@/lib/logger";

function req(body: string) {
  return new Request("http://localhost/api/telnyx/porting-webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "telnyx-signature-ed25519": "sig",
      "telnyx-timestamp": "123"
    },
    body
  });
}

function statusEvent(payload: Record<string, unknown> = {}) {
  return JSON.stringify({
    data: {
      event_type: "porting_order.status_changed",
      occurred_at: "2026-06-02T00:00:00Z",
      payload: { id: "po-1", status: { value: "ported" }, ...payload }
    }
  });
}

describe("api/telnyx/porting-webhook route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("TELNYX_PUBLIC_KEY", "pubkey");
    vi.mocked(verifyTelnyxWebhookSignature).mockReturnValue({ ok: true });
    vi.mocked(handlePortingStatusChange).mockResolvedValue({
      handled: true,
      ported: true,
      row: null
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("500 when TELNYX_PUBLIC_KEY is not configured", async () => {
    vi.stubEnv("TELNYX_PUBLIC_KEY", undefined);
    const res = await POST(req(statusEvent()));
    expect(res.status).toBe(500);
    expect(logger.error).toHaveBeenCalledWith(
      "porting-webhook: TELNYX_PUBLIC_KEY is not configured"
    );
    expect(handlePortingStatusChange).not.toHaveBeenCalled();
  });

  it("401 on a rejected signature", async () => {
    vi.mocked(verifyTelnyxWebhookSignature).mockReturnValue({
      ok: false,
      reason: "crypto_mismatch"
    });
    const res = await POST(req(statusEvent()));
    expect(res.status).toBe(401);
    expect(verifyTelnyxWebhookSignature).toHaveBeenCalledWith(
      statusEvent(),
      "sig",
      "123",
      "pubkey"
    );
    expect(handlePortingStatusChange).not.toHaveBeenCalled();
  });

  it("400 on unparseable JSON", async () => {
    const res = await POST(req("{not json"));
    expect(res.status).toBe(400);
  });

  it("acknowledges and ignores other event types (and missing data)", async () => {
    const res = await POST(
      req(JSON.stringify({ data: { event_type: "message.finalized", payload: {} } }))
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ignored).toBe(true);
    expect(handlePortingStatusChange).not.toHaveBeenCalled();

    const res2 = await POST(req(JSON.stringify({})));
    expect(res2.status).toBe(200);
    expect((await res2.json()).ignored).toBe(true);
  });

  it("processes porting_order.status_changed and reports handled/ported", async () => {
    const res = await POST(req(statusEvent()));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, handled: true, ported: true });
    // occurred_at is forwarded so the handler can order backward moves.
    expect(handlePortingStatusChange).toHaveBeenCalledWith(
      expect.objectContaining({ id: "po-1", status: { value: "ported" } }),
      {},
      "2026-06-02T00:00:00Z"
    );
  });

  it("defaults the payload to {} and occurred_at to null when the event has none", async () => {
    vi.mocked(handlePortingStatusChange).mockResolvedValue({
      handled: false,
      ported: false,
      row: null
    });
    const res = await POST(
      req(JSON.stringify({ data: { event_type: "porting_order.status_changed" } }))
    );
    expect(res.status).toBe(200);
    expect(handlePortingStatusChange).toHaveBeenCalledWith({}, {}, null);
  });

  it("500 (so Telnyx retries) when processing fails, tolerating non-Error throws", async () => {
    vi.mocked(handlePortingStatusChange).mockRejectedValueOnce(new Error("db down"));
    const res = await POST(req(statusEvent()));
    expect(res.status).toBe(500);
    expect(logger.error).toHaveBeenCalledWith(
      "porting-webhook: failed to process status change",
      expect.objectContaining({ errorMessage: "db down" })
    );

    vi.mocked(handlePortingStatusChange).mockRejectedValueOnce("wat");
    const res2 = await POST(req(statusEvent()));
    expect(res2.status).toBe(500);
  });
});

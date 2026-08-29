import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Telegram webhook receiver.
 *
 * Telegram signs nothing. The whole of this endpoint's authentication is a
 * per-connection shared secret echoed in a header, so the assertions below
 * are about that: it is compared in constant time, a connection with no
 * stored secret is refused rather than defaulting to open, and an unknown
 * connection id is indistinguishable from a bad secret so nobody can
 * enumerate live ids.
 *
 * The other half is status codes. Telegram retries a non-2xx and backs the
 * webhook off on sustained failures, so an authentic delivery we do nothing
 * with must still answer 200, while a message we genuinely failed to store
 * must answer 500 so it comes back.
 */

vi.mock("@/lib/db/coworker-connections", () => ({ getCoworkerConnection: vi.fn() }));
vi.mock("@/lib/telegram/inbound", () => ({ handleTelegramMessage: vi.fn() }));
vi.mock("@/lib/coworker-channels/kick", () => ({ kickCoworkerWorker: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (fn: () => void) => fn()
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { POST, secretMatches } from "@/app/api/webhooks/telegram/[connectionId]/route";
import { getCoworkerConnection } from "@/lib/db/coworker-connections";
import { handleTelegramMessage } from "@/lib/telegram/inbound";
import { kickCoworkerWorker } from "@/lib/coworker-channels/kick";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const CONN_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const BIZ = "11111111-1111-4111-8111-111111111111";

const CONNECTION = {
  business_id: BIZ,
  credential: "123:AA",
  is_active: true,
  webhookSecret: "shh"
};

function req(body: unknown, secret: string | null = "shh") {
  return new Request(`https://app/api/webhooks/telegram/${CONN_ID}`, {
    method: "POST",
    headers: secret ? { "x-telegram-bot-api-secret-token": secret } : {},
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

const ctx = { params: Promise.resolve({ connectionId: CONN_ID }) };

function lookupReturns(row: { business_id: string } | null, error: string | null = null) {
  vi.mocked(createSupabaseServiceClient).mockResolvedValue({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: row, error: error ? { message: error } : null })
          })
        })
      })
    })
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  lookupReturns({ business_id: BIZ });
  vi.mocked(getCoworkerConnection).mockResolvedValue(CONNECTION as never);
  vi.mocked(handleTelegramMessage).mockResolvedValue({ enqueued: true });
});

describe("the secret comparison", () => {
  it("matches only an exact secret", () => {
    expect(secretMatches("shh", "shh")).toBe(true);
    expect(secretMatches("shhh", "shh")).toBe(false);
    expect(secretMatches("shi", "shh")).toBe(false);
  });

  it("refuses a missing secret on EITHER side, rather than defaulting to open", () => {
    // A connection with no stored secret must never be reachable.
    expect(secretMatches(null, "shh")).toBe(false);
    expect(secretMatches("shh", null)).toBe(false);
    expect(secretMatches(null, null)).toBe(false);
    expect(secretMatches("", "")).toBe(false);
  });
});

describe("authentication", () => {
  it("accepts a delivery carrying the right secret", async () => {
    const res = await POST(req({ update_id: 1 }), ctx);
    expect(res.status).toBe(200);
    expect(handleTelegramMessage).toHaveBeenCalled();
  });

  it.each([
    ["a wrong secret", "nope"],
    ["no secret at all", null]
  ])("refuses %s with 401", async (_label, secret) => {
    const res = await POST(req({ update_id: 1 }, secret), ctx);
    expect(res.status).toBe(401);
    expect(handleTelegramMessage).not.toHaveBeenCalled();
  });

  it("answers an unknown connection id exactly like a bad secret", async () => {
    // Telling them apart would let someone enumerate live connection ids.
    lookupReturns(null);
    const res = await POST(req({ update_id: 1 }), ctx);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "unauthorized" });
  });

  it("refuses a malformed connection id without querying at all", async () => {
    const res = await POST(req({ update_id: 1 }), {
      params: Promise.resolve({ connectionId: "not-a-uuid" })
    });
    expect(res.status).toBe(401);
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  it("answers 500 on a read failure, so Telegram redelivers", async () => {
    // A read blip must NOT read as "unknown bot": Telegram would keep the
    // webhook and we would silently drop every message until someone
    // noticed.
    lookupReturns(null, "db down");
    const res = await POST(req({ update_id: 1 }), ctx);
    expect(res.status).toBe(500);
  });
});

describe("status codes Telegram cares about", () => {
  it("answers 200 for a paused connection: authentic, just nothing to do", async () => {
    vi.mocked(getCoworkerConnection).mockResolvedValue({
      ...CONNECTION,
      is_active: false
    } as never);
    const res = await POST(req({ update_id: 1 }), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: "inactive" });
  });

  it("answers 200 for a connection awaiting a reconnect", async () => {
    vi.mocked(getCoworkerConnection).mockResolvedValue({
      ...CONNECTION,
      credential: ""
    } as never);
    expect((await POST(req({ update_id: 1 }), ctx)).status).toBe(200);
  });

  it("answers 200 for an unparseable body rather than inviting a retry", async () => {
    const res = await POST(req("not json"), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: "unparseable" });
  });

  it("answers 413 for an oversized body", async () => {
    const res = await POST(req("x".repeat(300 * 1024)), ctx);
    expect(res.status).toBe(413);
  });

  it("answers 500 when the handler fails, because the message is unanswered", async () => {
    vi.mocked(handleTelegramMessage).mockRejectedValue(new Error("store down"));
    const res = await POST(req({ update_id: 1 }), ctx);
    expect(res.status).toBe(500);
  });
});

describe("kicking the worker", () => {
  it("kicks only when something was actually queued", async () => {
    await POST(req({ update_id: 1 }), ctx);
    expect(kickCoworkerWorker).toHaveBeenCalledWith("telegram");

    vi.clearAllMocks();
    lookupReturns({ business_id: BIZ });
    vi.mocked(getCoworkerConnection).mockResolvedValue(CONNECTION as never);
    vi.mocked(handleTelegramMessage).mockResolvedValue({ enqueued: false, reason: "not_linked" });
    await POST(req({ update_id: 1 }), ctx);
    expect(kickCoworkerWorker).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(),
  requireOwner: vi.fn()
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(() => ({ success: true, limit: 20, remaining: 19, reset: 0 }))
}));

vi.mock("@/lib/plans/sms-tools", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/plans/sms-tools")>();
  return { ...original, smsToolsAllowedForBusiness: vi.fn() };
});

import { GET, POST } from "@/app/api/dashboard/messages/schedule/route";
import { DELETE } from "@/app/api/dashboard/messages/schedule/[id]/route";
import { getAuthUser, requireOwner } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";
import { smsToolsAllowedForBusiness } from "@/lib/plans/sms-tools";

const BIZ = "11111111-1111-4111-8111-111111111111";
const SCHED = "33333333-3333-4333-8333-333333333333";
const OWNER = { userId: "u1", email: "o@o.com", isAdmin: false };

type ChainResult = { data: unknown; error: { message: string; code?: string } | null };

function makeChain(result: ChainResult) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "insert", "update", "delete", "eq", "neq", "order", "limit"]) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.single = vi.fn().mockResolvedValue(result);
  chain.maybeSingle = vi.fn().mockResolvedValue(result);
  chain.then = (resolve: (v: ChainResult) => unknown) => Promise.resolve(result).then(resolve);
  return chain;
}

/** Per-table result; pass an array to serve successive from() calls in order
 * (the GET route issues two scheduled_sms queries: pending, then history). */
function mockDb(results: Record<string, ChainResult | ChainResult[]>) {
  const served: Record<string, number> = {};
  const from = vi.fn((table: string) => {
    const conf = results[table];
    if (Array.isArray(conf)) {
      const idx = Math.min(served[table] ?? 0, conf.length - 1);
      served[table] = (served[table] ?? 0) + 1;
      return makeChain(conf[idx]);
    }
    return makeChain(conf ?? { data: null, error: null });
  });
  vi.mocked(createSupabaseServiceClient).mockResolvedValue({
    from
  } as unknown as Awaited<ReturnType<typeof createSupabaseServiceClient>>);
  return { from };
}

const inOneHour = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

function postReq(body: unknown) {
  return new Request("http://localhost/api/dashboard/messages/schedule", {
    method: "POST",
    body: JSON.stringify(body)
  });
}

function deleteReq(body: unknown) {
  return new Request(`http://localhost/api/dashboard/messages/schedule/${SCHED}`, {
    method: "DELETE",
    body: JSON.stringify(body)
  });
}

const idParams = { params: Promise.resolve({ id: SCHED }) };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuthUser).mockResolvedValue(OWNER);
  vi.mocked(smsToolsAllowedForBusiness).mockResolvedValue(true);
  vi.mocked(rateLimit).mockReturnValue({ success: true, limit: 20, remaining: 19, reset: 0 });
});

describe("GET /api/dashboard/messages/schedule", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    expect((await GET(new Request(`http://localhost/x?businessId=${BIZ}`))).status).toBe(401);
  });

  it("rejects a malformed businessId", async () => {
    expect((await GET(new Request("http://localhost/x?businessId=nah"))).status).toBe(400);
  });

  it("lists pending soonest-first followed by recent history", async () => {
    mockDb({
      scheduled_sms: [
        {
          data: [{ id: SCHED, to_e164: "+15551234567", body: "hi", status: "pending" }],
          error: null
        },
        {
          data: [{ id: "past-1", to_e164: "+15551234567", body: "bye", status: "sent" }],
          error: null
        }
      ]
    });
    const res = await GET(new Request(`http://localhost/x?businessId=${BIZ}`));
    expect(res.status).toBe(200);
    const scheduled = (await res.json()).data.scheduled;
    expect(scheduled.map((s: { id: string }) => s.id)).toEqual([SCHED, "past-1"]);
    expect(requireOwner).toHaveBeenCalledWith(BIZ);
  });

  it("tolerates null data and admins skip requireOwner", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ ...OWNER, isAdmin: true });
    mockDb({ scheduled_sms: { data: null, error: null } });
    const adminRes = await GET(new Request(`http://localhost/x?businessId=${BIZ}`));
    expect((await adminRes.json()).data.scheduled).toEqual([]);
    expect(requireOwner).not.toHaveBeenCalled();
  });

  it("maps DB errors on either query to 500", async () => {
    mockDb({
      scheduled_sms: [
        { data: null, error: { message: "db down" } },
        { data: null, error: null }
      ]
    });
    expect((await GET(new Request(`http://localhost/x?businessId=${BIZ}`))).status).toBe(500);

    mockDb({
      scheduled_sms: [
        { data: [], error: null },
        { data: null, error: { message: "db down" } }
      ]
    });
    expect((await GET(new Request(`http://localhost/x?businessId=${BIZ}`))).status).toBe(500);
  });
});

describe("POST /api/dashboard/messages/schedule", () => {
  const valid = () => ({
    businessId: BIZ,
    toE164: "+15551234567",
    text: "Reminder about tomorrow",
    sendAt: inOneHour()
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    expect((await POST(postReq(valid()))).status).toBe(401);
  });

  it("rejects bad payloads: number, empty text, invalid sendAt", async () => {
    expect(
      (await POST(postReq({ ...valid(), toE164: "not-a-number" }))).status
    ).toBe(400);
    expect((await POST(postReq({ ...valid(), text: "  " }))).status).toBe(400);
    expect((await POST(postReq({ ...valid(), sendAt: "whenever" }))).status).toBe(400);
  });

  it("rejects near-immediate and too-far-out send times", async () => {
    const res = await POST(
      postReq({ ...valid(), sendAt: new Date(Date.now() + 10_000).toISOString() })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain("at least a minute");

    const farOut = new Date(Date.now() + 120 * 24 * 60 * 60 * 1000).toISOString();
    const res2 = await POST(postReq({ ...valid(), sendAt: farOut }));
    expect(res2.status).toBe(400);
    expect((await res2.json()).error.message).toContain("days out");
  });

  it("rate limits", async () => {
    vi.mocked(rateLimit).mockReturnValue({ success: false, limit: 20, remaining: 0, reset: 0 });
    expect((await POST(postReq(valid()))).status).toBe(429);
  });

  it("gates on tier", async () => {
    vi.mocked(smsToolsAllowedForBusiness).mockResolvedValue(false);
    expect((await POST(postReq(valid()))).status).toBe(403);
  });

  it("queues the send", async () => {
    mockDb({
      scheduled_sms: {
        data: { id: SCHED, to_e164: "+15551234567", status: "pending" },
        error: null
      }
    });
    const res = await POST(postReq(valid()));
    expect(res.status).toBe(201);
    expect((await res.json()).data.scheduled.id).toBe(SCHED);
  });

  it("maps insert errors to 500", async () => {
    mockDb({ scheduled_sms: { data: null, error: { message: "db down" } } });
    expect((await POST(postReq(valid()))).status).toBe(500);
  });
});

describe("DELETE /api/dashboard/messages/schedule/:id", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    expect((await DELETE(deleteReq({ businessId: BIZ }), idParams)).status).toBe(401);
  });

  it("rejects a malformed id or businessId", async () => {
    const res = await DELETE(deleteReq({ businessId: BIZ }), {
      params: Promise.resolve({ id: "nah" })
    });
    expect(res.status).toBe(400);
    expect((await DELETE(deleteReq({ businessId: "nah" }), idParams)).status).toBe(400);
  });

  it("cancels a pending send", async () => {
    mockDb({ scheduled_sms: { data: { id: SCHED }, error: null } });
    const res = await DELETE(deleteReq({ businessId: BIZ }), idParams);
    expect(res.status).toBe(200);
    expect((await res.json()).data.canceled).toBe(true);
  });

  it("404s when the row is gone or already dispatched, 500s on DB errors", async () => {
    mockDb({ scheduled_sms: { data: null, error: null } });
    expect((await DELETE(deleteReq({ businessId: BIZ }), idParams)).status).toBe(404);

    mockDb({ scheduled_sms: { data: null, error: { message: "db down" } } });
    expect((await DELETE(deleteReq({ businessId: BIZ }), idParams)).status).toBe(500);
  });
});

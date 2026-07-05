import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/public-api/auth", () => ({
  authenticatePublicApiRequest: vi.fn()
}));

type QueryResult = { data: unknown; error: { message: string } | null };
let queryResult: QueryResult = { data: [], error: null };
const filterMock = vi.fn();
const orMock = vi.fn();
const orderMock = vi.fn();
const fromMock = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => ({ from: fromMock }))
}));

import { GET } from "@/app/api/public/v1/events/route";
import { authenticatePublicApiRequest } from "@/lib/public-api/auth";

const AUTH = { businessId: "biz-1", apiKeyId: "key-1" };

function req(qs: string): Request {
  return new Request(`http://localhost/api/public/v1/events${qs}`);
}

/** Thenable query chain that also supports .filter()/.or() for gated sources. */
function makeQueryChain() {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "limit"]) {
    chain[m] = vi.fn(() => chain);
  }
  chain.order = orderMock.mockImplementation(() => chain);
  chain.filter = filterMock.mockImplementation(() => chain);
  chain.or = orMock.mockImplementation(() => chain);
  chain.then = (resolve: (v: QueryResult) => unknown) =>
    Promise.resolve(queryResult).then(resolve);
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  queryResult = { data: [], error: null };
  vi.mocked(authenticatePublicApiRequest).mockResolvedValue(AUTH);
  fromMock.mockImplementation(() => makeQueryChain());
});

describe("GET /api/public/v1/events", () => {
  it("401s without a valid API key", async () => {
    vi.mocked(authenticatePublicApiRequest).mockResolvedValue(null);
    const res = await GET(req("?event=sms.inbound"));
    expect(res.status).toBe(401);
  });

  it("400s on a missing or unknown event type", async () => {
    expect((await GET(req(""))).status).toBe(400);
    expect((await GET(req("?event=sms.deleted"))).status).toBe(400);
  });

  it("returns dispatcher-shaped payloads for the business", async () => {
    queryResult = {
      data: [
        {
          id: "row-1",
          created_at: "2026-07-01T00:00:00Z",
          business_id: "biz-1",
          customer_e164: "+16025551234",
          channel: "sms",
          payload: { data: { payload: { text: "hi" } } }
        }
      ],
      error: null
    };
    const res = await GET(req("?event=sms.inbound&limit=1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([
      {
        event: "sms.inbound",
        business_id: "biz-1",
        id: "row-1",
        occurred_at: "2026-07-01T00:00:00Z",
        data: { from: "+16025551234", text: "hi", channel: "sms" }
      }
    ]);
    expect(fromMock).toHaveBeenCalledWith("sms_inbound_jobs");
  });

  it("applies the source filter, readiness gate, and cursor-column ordering (call.completed)", async () => {
    queryResult = { data: [], error: null };
    const res = await GET(req("?event=call.completed"));
    expect(res.status).toBe(200);
    expect(fromMock).toHaveBeenCalledWith("voice_call_transcripts");
    expect(filterMock).toHaveBeenCalledWith("ended_at", "not.is", "null");
    // Samples mirror the dispatcher: same readiness gate (summarized OR
    // grace elapsed) and newest-first by the cursor column (ended_at).
    expect(orMock).toHaveBeenCalledWith(
      expect.stringMatching(/^summarized_at\.not\.is\.null,ended_at\.lt\./)
    );
    expect(orderMock).toHaveBeenCalledWith("ended_at", { ascending: false });
  });

  it("does not apply a readiness gate for ungated events (sms.inbound)", async () => {
    const res = await GET(req("?event=sms.inbound"));
    expect(res.status).toBe(200);
    expect(orMock).not.toHaveBeenCalled();
    expect(orderMock).toHaveBeenCalledWith("created_at", { ascending: false });
  });

  it("caps limit at 25 (400 beyond)", async () => {
    expect((await GET(req("?event=sms.inbound&limit=100"))).status).toBe(400);
  });

  it("500s with DB_ERROR when the source query fails", async () => {
    queryResult = { data: null, error: { message: "table gone" } };
    const res = await GET(req("?event=sms.inbound"));
    expect(res.status).toBe(500);
  });
});

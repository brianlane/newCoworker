import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import {
  getLatestVpsPostureReport,
  insertVpsPostureReport
} from "@/lib/db/vps-posture";

const sample = {
  id: "rep-1",
  business_id: "biz-1",
  ok: false,
  checks: [{ name: "ufw_active", ok: false, detail: "ufw inactive" }],
  created_at: "2026-07-08T00:00:00Z"
};

function makeChain() {
  const qb = {
    insert: vi.fn(() => qb),
    select: vi.fn(() => qb),
    eq: vi.fn(() => qb),
    order: vi.fn(() => qb),
    limit: vi.fn(() => qb),
    single: vi.fn(),
    maybeSingle: vi.fn()
  };
  return qb;
}

function makeDb(chain: ReturnType<typeof makeChain>) {
  return { from: vi.fn(() => chain) };
}

describe("vps_posture_reports DB layer", () => {
  beforeEach(() => vi.clearAllMocks());

  it("insertVpsPostureReport writes ok + checks and returns the row", async () => {
    const chain = makeChain();
    chain.single.mockResolvedValue({ data: sample, error: null });
    const db = makeDb(chain);
    const res = await insertVpsPostureReport(
      { businessId: "biz-1", ok: false, checks: sample.checks },
      db as never
    );
    expect(res).toEqual(sample);
    expect(db.from).toHaveBeenCalledWith("vps_posture_reports");
    expect(chain.insert).toHaveBeenCalledWith({
      business_id: "biz-1",
      ok: false,
      checks: sample.checks
    });
  });

  it("insertVpsPostureReport throws on a Supabase error", async () => {
    const chain = makeChain();
    chain.single.mockResolvedValue({ data: null, error: { message: "rls" } });
    await expect(
      insertVpsPostureReport(
        { businessId: "biz-1", ok: true, checks: [] },
        makeDb(chain) as never
      )
    ).rejects.toThrow(/insertVpsPostureReport: rls/);
  });

  it("getLatestVpsPostureReport returns the newest row (or null) and throws on error", async () => {
    const chain = makeChain();
    chain.maybeSingle.mockResolvedValueOnce({ data: sample, error: null });
    const db = makeDb(chain);
    await expect(getLatestVpsPostureReport("biz-1", db as never)).resolves.toEqual(sample);
    expect(chain.order).toHaveBeenCalledWith("created_at", { ascending: false });

    chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    await expect(getLatestVpsPostureReport("biz-1", db as never)).resolves.toBeNull();

    chain.maybeSingle.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    await expect(getLatestVpsPostureReport("biz-1", db as never)).rejects.toThrow(
      /getLatestVpsPostureReport: boom/
    );
  });

  it("both helpers fall back to the default service client", async () => {
    const chain = makeChain();
    chain.single.mockResolvedValue({ data: sample, error: null });
    chain.maybeSingle.mockResolvedValue({ data: null, error: null });
    defaultClientSpy.mockReturnValue(makeDb(chain));
    await insertVpsPostureReport({ businessId: "b", ok: true, checks: [] });
    await getLatestVpsPostureReport("b");
    expect(defaultClientSpy).toHaveBeenCalledTimes(2);
  });
});

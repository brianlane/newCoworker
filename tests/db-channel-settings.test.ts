/**
 * src/lib/db/channel-settings.ts — per-tenant RCS wiring reads/writes behind
 * the admin "Messaging channel (RCS)" card.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const createSupabaseServiceClient = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient
}));

import { getChannelSettings, upsertChannelSettings } from "@/lib/db/channel-settings";

type Row = { data: unknown; error: { message: string } | null };

function makeDb(row: Row, upsertResult: { error: { message: string } | null } = { error: null }) {
  const upsert = vi.fn().mockResolvedValue(upsertResult);
  const maybeSingle = vi.fn().mockResolvedValue(row);
  const db = {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({ maybeSingle }))
      })),
      upsert
    }))
  };
  return { db: db as never, upsert };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getChannelSettings", () => {
  it("returns the stored row", async () => {
    const { db } = makeDb({
      data: { rcs_agent_id: "agent_1", rcs_enabled: true },
      error: null
    });
    expect(await getChannelSettings("biz-1", db)).toEqual({
      rcsAgentId: "agent_1",
      rcsEnabled: true
    });
  });

  it("treats a missing row as the all-defaults state", async () => {
    const { db } = makeDb({ data: null, error: null });
    expect(await getChannelSettings("biz-1", db)).toEqual({
      rcsAgentId: null,
      rcsEnabled: false
    });
  });

  it("defaults null-ish columns on a partial row", async () => {
    const { db } = makeDb({ data: { rcs_agent_id: null }, error: null });
    expect(await getChannelSettings("biz-1", db)).toEqual({
      rcsAgentId: null,
      rcsEnabled: false
    });
  });

  it("throws on a read error", async () => {
    const { db } = makeDb({ data: null, error: { message: "boom" } });
    await expect(getChannelSettings("biz-1", db)).rejects.toThrow("boom");
  });

  it("creates a service client when none is provided", async () => {
    const { db } = makeDb({
      data: { rcs_agent_id: "agent_2", rcs_enabled: false },
      error: null
    });
    createSupabaseServiceClient.mockResolvedValue(db);
    expect(await getChannelSettings("biz-1")).toEqual({
      rcsAgentId: "agent_2",
      rcsEnabled: false
    });
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });
});

describe("upsertChannelSettings", () => {
  it("upserts on business_id and returns the normalized settings", async () => {
    const { db, upsert } = makeDb({ data: null, error: null });
    const saved = await upsertChannelSettings(
      "biz-1",
      { rcsAgentId: "  agent_3  ", rcsEnabled: true },
      db
    );
    expect(saved).toEqual({ rcsAgentId: "agent_3", rcsEnabled: true });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        business_id: "biz-1",
        rcs_agent_id: "agent_3",
        rcs_enabled: true
      }),
      { onConflict: "business_id" }
    );
  });

  it("collapses a blank or null agent id to null", async () => {
    const { db, upsert } = makeDb({ data: null, error: null });
    expect(await upsertChannelSettings("biz-1", { rcsAgentId: "   ", rcsEnabled: false }, db)).toEqual(
      { rcsAgentId: null, rcsEnabled: false }
    );
    expect(await upsertChannelSettings("biz-1", { rcsAgentId: null, rcsEnabled: false }, db)).toEqual(
      { rcsAgentId: null, rcsEnabled: false }
    );
    expect(upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({ rcs_agent_id: null }),
      { onConflict: "business_id" }
    );
  });

  it("throws on a write error", async () => {
    const { db } = makeDb({ data: null, error: null }, { error: { message: "denied" } });
    await expect(
      upsertChannelSettings("biz-1", { rcsAgentId: "a", rcsEnabled: true }, db)
    ).rejects.toThrow("denied");
  });

  it("creates a service client when none is provided", async () => {
    const { db } = makeDb({ data: null, error: null });
    createSupabaseServiceClient.mockResolvedValue(db);
    await upsertChannelSettings("biz-1", { rcsAgentId: "a", rcsEnabled: true });
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });
});

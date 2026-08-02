import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import {
  latestAcceptanceFor,
  needsAcceptance,
  recordAcceptance
} from "@/lib/legal/acceptance";
import { PRIVACY_EFFECTIVE_DATE, TERMS_EFFECTIVE_DATE } from "@/lib/legal/versions";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

type TableResult = { data: unknown; error: { message: string } | null };

/** Thenable chain stub, same shape as the privacy suites. */
function makeDb(result: TableResult = { data: null, error: null }) {
  const insert = vi.fn().mockResolvedValue(result);
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit"]) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.maybeSingle = vi.fn().mockResolvedValue(result);
  const from = vi.fn(() => ({ ...chain, insert }));
  return { from, insert, chain };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("recordAcceptance", () => {
  it("inserts a row pinned to the CURRENT versions, normalized and capped", async () => {
    const db = makeDb({ data: null, error: null });
    await recordAcceptance(
      {
        userId: "u-1",
        email: "  Person@Example.com ",
        businessId: "biz-1",
        source: "signup",
        ip: "x".repeat(100),
        userAgent: "y".repeat(500)
      },
      db as never
    );
    expect(db.from).toHaveBeenCalledWith("terms_acceptances");
    expect(db.insert).toHaveBeenCalledWith({
      user_id: "u-1",
      email: "person@example.com",
      business_id: "biz-1",
      terms_version: TERMS_EFFECTIVE_DATE,
      privacy_version: PRIVACY_EFFECTIVE_DATE,
      source: "signup",
      ip: "x".repeat(64),
      user_agent: "y".repeat(400)
    });
  });

  it("accepts an email-only pre-session row and nulls the optional fields", async () => {
    const db = makeDb({ data: null, error: null });
    await recordAcceptance({ email: "a@b.co", source: "signup" }, db as never);
    expect(db.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: null,
        email: "a@b.co",
        business_id: null,
        ip: null,
        user_agent: null
      })
    );
  });

  it("refuses a row that identifies nobody", async () => {
    await expect(recordAcceptance({ source: "gate" }, makeDb() as never)).rejects.toThrow(
      /a userId or email is required/
    );
  });

  it("throws the typed error when the insert fails", async () => {
    const db = makeDb({ data: null, error: { message: "denied" } });
    await expect(
      recordAcceptance({ userId: "u-1", source: "gate" }, db as never)
    ).rejects.toThrow(/recordAcceptance: denied/);
  });

  it("uses the default service client when none is injected", async () => {
    const db = makeDb({ data: null, error: null });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await recordAcceptance({ userId: "u-1", source: "gate" });
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });
});

describe("latestAcceptanceFor", () => {
  it("returns the newest row", async () => {
    const row = {
      terms_version: TERMS_EFFECTIVE_DATE,
      privacy_version: PRIVACY_EFFECTIVE_DATE,
      accepted_at: "2026-08-01T00:00:00Z"
    };
    const db = makeDb({ data: row, error: null });
    expect(await latestAcceptanceFor("u-1", db as never)).toEqual(row);
  });

  it("returns null when the user has no rows", async () => {
    const db = makeDb({ data: null, error: null });
    expect(await latestAcceptanceFor("u-1", db as never)).toBeNull();
  });

  it("fails OPEN (current versions) and logs when the read errors", async () => {
    const db = makeDb({ data: null, error: { message: "boom" } });
    const latest = await latestAcceptanceFor("u-1", db as never);
    expect(latest).toEqual({
      terms_version: TERMS_EFFECTIVE_DATE,
      privacy_version: PRIVACY_EFFECTIVE_DATE,
      accepted_at: ""
    });
    expect(needsAcceptance(latest)).toBe(false);
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      "latestAcceptanceFor: read failed (gate fails open this render)",
      expect.objectContaining({ userId: "u-1", error: "boom" })
    );
  });

  it("uses the default service client when none is injected", async () => {
    const db = makeDb({ data: null, error: null });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await latestAcceptanceFor("u-1");
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });
});

describe("needsAcceptance", () => {
  const current = {
    terms_version: TERMS_EFFECTIVE_DATE,
    privacy_version: PRIVACY_EFFECTIVE_DATE,
    accepted_at: "2026-08-01T00:00:00Z"
  };

  it("gates when there is no row at all", () => {
    expect(needsAcceptance(null)).toBe(true);
  });

  it("gates when either version is stale", () => {
    expect(needsAcceptance({ ...current, terms_version: "April 2, 2026" })).toBe(true);
    expect(needsAcceptance({ ...current, privacy_version: "July 15, 2026" })).toBe(true);
  });

  it("stays quiet when the newest row pins the current versions", () => {
    expect(needsAcceptance(current)).toBe(false);
  });
});

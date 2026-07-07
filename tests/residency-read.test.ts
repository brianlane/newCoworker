import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

vi.mock("@/lib/db/vps-gateway-tokens", () => ({
  getActiveGatewayTokenForBusiness: vi.fn(async () => "tok")
}));

import {
  ResidencyReadError,
  __clearResidencyModeCache,
  countMovedRows,
  escapeLikeLiteral,
  isVpsReadMode,
  readMovedRows,
  residencyModeFor
} from "@/lib/residency/read";
import { DataApiClient, DataApiTransportError } from "@/lib/residency/client";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const BIZ = "11111111-1111-4111-8111-111111111111";

function modeDb(result: { data?: unknown; error?: { message: string } | null }) {
  const maybeSingle = vi.fn(async () => ({ data: result.data ?? null, error: result.error ?? null }));
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return { db: { from } as never, from, maybeSingle };
}

function apiStub(select: (req: unknown) => Promise<unknown>) {
  return { select: vi.fn(select) } as unknown as DataApiClient;
}

describe("residencyModeFor / isVpsReadMode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __clearResidencyModeCache();
  });

  it("returns the stored mode and caches it", async () => {
    const { db, from } = modeDb({ data: { data_residency_mode: "vps" } });
    expect(await residencyModeFor(BIZ, db as never)).toBe("vps");
    expect(await residencyModeFor(BIZ, db as never)).toBe("vps");
    expect(from).toHaveBeenCalledTimes(1);
    expect(await isVpsReadMode(BIZ, db as never)).toBe(true);
  });

  it("treats dual, missing rows, and unknown values as central", async () => {
    __clearResidencyModeCache();
    const dual = modeDb({ data: { data_residency_mode: "dual" } });
    expect(await residencyModeFor(BIZ, dual.db as never)).toBe("dual");
    expect(await isVpsReadMode(BIZ, dual.db as never)).toBe(false);

    __clearResidencyModeCache();
    const missing = modeDb({ data: null });
    expect(await residencyModeFor(BIZ, missing.db as never)).toBe("supabase");

    __clearResidencyModeCache();
    const corrupt = modeDb({ data: { data_residency_mode: "purged" } });
    expect(await residencyModeFor(BIZ, corrupt.db as never)).toBe("supabase");
  });

  it("fails toward central on a lookup error (and does not cache it)", async () => {
    const { db, from } = modeDb({ error: { message: "db down" } });
    expect(await residencyModeFor(BIZ, db as never)).toBe("supabase");
    expect(await residencyModeFor(BIZ, db as never)).toBe("supabase");
    // No caching of the error result: both calls hit the DB.
    expect(from).toHaveBeenCalledTimes(2);
  });

  it("falls back to the service client when none is provided", async () => {
    const { db } = modeDb({ data: { data_residency_mode: "vps" } });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await residencyModeFor(BIZ)).toBe("vps");
  });
});

describe("readMovedRows", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns rows from the box", async () => {
    const api = apiStub(async () => ({ ok: true, rows: [{ id: "r1" }] }));
    expect(
      await readMovedRows(BIZ, { table: "email_log" }, { makeDataApi: () => api })
    ).toEqual([{ id: "r1" }]);
  });

  it("throws a typed error on a structured failure — no fallback", async () => {
    const api = apiStub(async () => ({ ok: false, error: "internal", message: "pg down" }));
    await expect(
      readMovedRows(BIZ, { table: "email_log" }, { makeDataApi: () => api })
    ).rejects.toBeInstanceOf(ResidencyReadError);
  });

  it("wraps transport failures (down box) in the typed error", async () => {
    const api = apiStub(async () => {
      throw new DataApiTransportError("unreachable");
    });
    await expect(
      readMovedRows(BIZ, { table: "email_log" }, { makeDataApi: () => api })
    ).rejects.toThrow(/unreachable/);
  });

  it("lets unrelated throws pass through unwrapped", async () => {
    const api = apiStub(async () => {
      throw new TypeError("bug");
    });
    await expect(
      readMovedRows(BIZ, { table: "email_log" }, { makeDataApi: () => api })
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("constructs the default DataApiClient when no factory is injected", async () => {
    // Stub global fetch so the default client fails deterministically with
    // NO network egress — the wrapped transport error proves the default
    // construction path ran end-to-end.
    vi.stubGlobal("fetch", async () => {
      throw new Error("no network in tests");
    });
    try {
      await expect(readMovedRows(BIZ, { table: "email_log" })).rejects.toBeInstanceOf(
        ResidencyReadError
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("countMovedRows", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the count and defaults a missing count to 0", async () => {
    const seen: unknown[] = [];
    const api = apiStub(async (req) => {
      seen.push(req);
      return { ok: true, rows: [], count: 7 };
    });
    expect(
      await countMovedRows(BIZ, { table: "notifications" }, { makeDataApi: () => api })
    ).toBe(7);
    expect(seen[0]).toMatchObject({ columns: ["id"], limit: 1, count: true });

    const noCount = apiStub(async () => ({ ok: true, rows: [] }));
    expect(
      await countMovedRows(BIZ, { table: "notifications" }, { makeDataApi: () => noCount })
    ).toBe(0);
  });

  it("throws typed errors on structured and transport failures", async () => {
    const bad = apiStub(async () => ({ ok: false, error: "internal", message: "x" }));
    await expect(
      countMovedRows(BIZ, { table: "notifications" }, { makeDataApi: () => bad })
    ).rejects.toBeInstanceOf(ResidencyReadError);

    const down = apiStub(async () => {
      throw new DataApiTransportError("gone");
    });
    await expect(
      countMovedRows(BIZ, { table: "notifications" }, { makeDataApi: () => down })
    ).rejects.toThrow(/gone/);

    const weird = apiStub(async () => {
      throw new RangeError("bug");
    });
    await expect(
      countMovedRows(BIZ, { table: "notifications" }, { makeDataApi: () => weird })
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("constructs the default DataApiClient when no factory is injected", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("no network in tests");
    });
    try {
      await expect(countMovedRows(BIZ, { table: "notifications" })).rejects.toBeInstanceOf(
        ResidencyReadError
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("escapeLikeLiteral", () => {
  it("escapes LIKE metachars only", () => {
    expect(escapeLikeLiteral("joe_smith@x.com")).toBe("joe\\_smith@x.com");
    expect(escapeLikeLiteral("100%@x.com")).toBe("100\\%@x.com");
    expect(escapeLikeLiteral("plain@x.com")).toBe("plain@x.com");
  });
});

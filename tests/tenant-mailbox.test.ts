import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: (...a: unknown[]) => defaultClientSpy(...a)
}));

import {
  LOCAL_PART_MAX_LENGTH,
  PERSONALIZE_TIERS,
  PERSONALIZED_MIN_LENGTH,
  RESERVED_LOCAL_PARTS,
  TenantMailboxError,
  checkLocalPartAvailable,
  ensureTenantMailbox,
  getTenantMailbox,
  normalizePersonalizedLocalPart,
  parseLocalPart,
  resolveBusinessByAddress,
  resolveBusinessByLocalPart,
  setPersonalizedLocalPart,
  suggestLocalPartFromName,
  tenantEmailDomain,
  tenantMailboxAddress,
  validatePersonalizedLocalPart
} from "@/lib/email/tenant-mailbox";

/**
 * A fake Supabase client whose terminal calls (maybeSingle/single) drain a
 * queue of results in call order, regardless of which builder method fires —
 * so multi-query helpers (e.g. ensureTenantMailbox) can script each step.
 */
function fakeDb(results: Array<{ data: unknown; error: unknown }>) {
  let i = 0;
  const next = () => results[i++];
  const builder: Record<string, unknown> = {};
  builder.select = vi.fn(() => builder);
  builder.eq = vi.fn(() => builder);
  builder.insert = vi.fn(() => builder);
  builder.upsert = vi.fn(() => builder);
  builder.maybeSingle = vi.fn(() => Promise.resolve(next()));
  builder.single = vi.fn(() => Promise.resolve(next()));
  return { from: vi.fn(() => builder) };
}

const ROW = {
  business_id: "biz-1",
  local_part: "amy",
  personalized: true,
  created_at: "2026-06-15T00:00:00Z",
  updated_at: "2026-06-15T00:00:00Z"
};

beforeEach(() => {
  defaultClientSpy.mockReset();
});

afterEach(() => {
  delete process.env.TENANT_EMAIL_DOMAIN;
});

describe("tenantEmailDomain", () => {
  it("defaults to newcoworker.com and lowercases/trims overrides", () => {
    expect(tenantEmailDomain({})).toBe("newcoworker.com");
    expect(tenantEmailDomain({ TENANT_EMAIL_DOMAIN: "   " })).toBe("newcoworker.com");
    expect(tenantEmailDomain({ TENANT_EMAIL_DOMAIN: "  Mail.Example.COM " })).toBe("mail.example.com");
  });
  it("reads process.env when no env is passed", () => {
    process.env.TENANT_EMAIL_DOMAIN = "biz.test";
    expect(tenantEmailDomain()).toBe("biz.test");
  });
});

describe("tenantMailboxAddress", () => {
  it("joins a lowercased local-part to the domain", () => {
    expect(tenantMailboxAddress("Amy", { TENANT_EMAIL_DOMAIN: "x.com" })).toBe("amy@x.com");
  });
});

describe("parseLocalPart", () => {
  it("handles bare, display, and invalid forms", () => {
    expect(parseLocalPart("Amy@newcoworker.com")).toBe("amy");
    expect(parseLocalPart("Amy <amy@newcoworker.com>")).toBe("amy");
    expect(parseLocalPart("not-an-email")).toBeNull();
    expect(parseLocalPart("@nope.com")).toBeNull();
  });
});

describe("validatePersonalizedLocalPart / normalizePersonalizedLocalPart", () => {
  it("accepts a clean handle", () => {
    expect(validatePersonalizedLocalPart("Amy.Laidlaw")).toEqual({ ok: true, localPart: "amy.laidlaw" });
    expect(normalizePersonalizedLocalPart("Amy_1")).toBe("amy_1");
  });
  it("rejects too-short, too-long and bad-character handles", () => {
    expect(validatePersonalizedLocalPart("ab").ok).toBe(false); // too short
    expect(validatePersonalizedLocalPart("a".repeat(LOCAL_PART_MAX_LENGTH + 1)).ok).toBe(false);
    expect(validatePersonalizedLocalPart("-bad").ok).toBe(false); // bad start char
    const res = validatePersonalizedLocalPart("ab");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("invalid_format");
  });
  it("rejects reserved handles", () => {
    const res = validatePersonalizedLocalPart("contact");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("reserved");
    expect(RESERVED_LOCAL_PARTS.has("team")).toBe(true);
  });
  it("normalize throws TenantMailboxError on invalid input", () => {
    expect(() => normalizePersonalizedLocalPart("ab")).toThrow(TenantMailboxError);
    try {
      normalizePersonalizedLocalPart("contact");
    } catch (err) {
      expect((err as TenantMailboxError).code).toBe("reserved");
    }
  });
  it("constants are sane", () => {
    expect(PERSONALIZED_MIN_LENGTH).toBe(3);
    expect(PERSONALIZE_TIERS.has("standard")).toBe(true);
    expect(PERSONALIZE_TIERS.has("starter")).toBe(false);
  });
});

describe("suggestLocalPartFromName", () => {
  it("slugifies a normal name", () => {
    expect(suggestLocalPartFromName("Amy Laidlaw!!")).toBe("amy-laidlaw");
  });
  it("returns empty for too-short or reserved results", () => {
    expect(suggestLocalPartFromName("A")).toBe("");
    expect(suggestLocalPartFromName("Contact")).toBe("");
  });
});

describe("getTenantMailbox", () => {
  it("returns the row, or null, and surfaces errors", async () => {
    await expect(getTenantMailbox("biz-1", fakeDb([{ data: ROW, error: null }]) as never)).resolves.toEqual(ROW);
    await expect(getTenantMailbox("biz-1", fakeDb([{ data: null, error: null }]) as never)).resolves.toBeNull();
    await expect(
      getTenantMailbox("biz-1", fakeDb([{ data: null, error: { message: "boom" } }]) as never)
    ).rejects.toThrow("getTenantMailbox: boom");
  });
  it("uses the default client when none injected", async () => {
    defaultClientSpy.mockResolvedValueOnce(fakeDb([{ data: ROW, error: null }]));
    await expect(getTenantMailbox("biz-1")).resolves.toEqual(ROW);
  });
});

describe("ensureTenantMailbox", () => {
  it("returns an existing row without inserting", async () => {
    const db = fakeDb([{ data: ROW, error: null }]);
    await expect(ensureTenantMailbox("biz-1", db as never)).resolves.toEqual(ROW);
  });
  it("inserts the UUID default when none exists", async () => {
    const inserted = { ...ROW, local_part: "biz-1", personalized: false };
    const db = fakeDb([
      { data: null, error: null }, // getTenantMailbox
      { data: inserted, error: null } // insert.single
    ]);
    await expect(ensureTenantMailbox("BIZ-1", db as never)).resolves.toEqual(inserted);
  });
  it("recovers from a concurrent insert (23505) by refetching", async () => {
    const db = fakeDb([
      { data: null, error: null }, // getTenantMailbox
      { data: null, error: { code: "23505" } }, // insert conflict
      { data: ROW, error: null } // refetch
    ]);
    await expect(ensureTenantMailbox("biz-1", db as never)).resolves.toEqual(ROW);
  });
  it("throws if the conflict refetch finds nothing", async () => {
    const db = fakeDb([
      { data: null, error: null },
      { data: null, error: { code: "23505" } },
      { data: null, error: null }
    ]);
    await expect(ensureTenantMailbox("biz-1", db as never)).rejects.toThrow("ensureTenantMailbox");
  });
  it("throws on a non-conflict insert error", async () => {
    const db = fakeDb([
      { data: null, error: null },
      { data: null, error: { code: "500", message: "down" } }
    ]);
    await expect(ensureTenantMailbox("biz-1", db as never)).rejects.toThrow("ensureTenantMailbox: down");
  });
});

describe("resolveBusinessByLocalPart", () => {
  it("returns the businessId, null, and surfaces errors", async () => {
    await expect(
      resolveBusinessByLocalPart("Amy", fakeDb([{ data: { business_id: "biz-1" }, error: null }]) as never)
    ).resolves.toBe("biz-1");
    await expect(
      resolveBusinessByLocalPart("amy", fakeDb([{ data: null, error: null }]) as never)
    ).resolves.toBeNull();
    await expect(
      resolveBusinessByLocalPart("amy", fakeDb([{ data: null, error: { message: "x" } }]) as never)
    ).rejects.toThrow("resolveBusinessByLocalPart: x");
  });
});

describe("resolveBusinessByAddress", () => {
  it("resolves matching-domain addresses (bare and display form)", async () => {
    await expect(
      resolveBusinessByAddress(
        "Amy <amy@newcoworker.com>",
        fakeDb([{ data: { business_id: "biz-1" }, error: null }]) as never,
        { TENANT_EMAIL_DOMAIN: "newcoworker.com" }
      )
    ).resolves.toBe("biz-1");
  });
  it("returns null for foreign domains and malformed addresses without querying", async () => {
    const db = fakeDb([]);
    await expect(
      resolveBusinessByAddress("amy@other.com", db as never, { TENANT_EMAIL_DOMAIN: "newcoworker.com" })
    ).resolves.toBeNull();
    await expect(
      resolveBusinessByAddress("@newcoworker.com", db as never, { TENANT_EMAIL_DOMAIN: "newcoworker.com" })
    ).resolves.toBeNull();
  });
  it("uses process.env domain by default", async () => {
    process.env.TENANT_EMAIL_DOMAIN = "biz.test";
    await expect(
      resolveBusinessByAddress("amy@biz.test", fakeDb([{ data: { business_id: "b" }, error: null }]) as never)
    ).resolves.toBe("b");
  });
});

describe("checkLocalPartAvailable", () => {
  it("rejects invalid formats before any query", async () => {
    await expect(checkLocalPartAvailable("ab", "biz-1", fakeDb([]) as never)).resolves.toEqual({
      available: false,
      reason: "invalid_format"
    });
  });
  it("is available when free or owned by the same business", async () => {
    await expect(
      checkLocalPartAvailable("amy", "biz-1", fakeDb([{ data: null, error: null }]) as never)
    ).resolves.toEqual({ available: true });
    await expect(
      checkLocalPartAvailable("amy", "biz-1", fakeDb([{ data: { business_id: "biz-1" }, error: null }]) as never)
    ).resolves.toEqual({ available: true });
  });
  it("is taken when owned by another business", async () => {
    await expect(
      checkLocalPartAvailable("amy", "biz-1", fakeDb([{ data: { business_id: "biz-2" }, error: null }]) as never)
    ).resolves.toEqual({ available: false, reason: "taken" });
  });
  it("surfaces query errors", async () => {
    await expect(
      checkLocalPartAvailable("amy", "biz-1", fakeDb([{ data: null, error: { message: "db" } }]) as never)
    ).rejects.toThrow("checkLocalPartAvailable: db");
  });
});

describe("setPersonalizedLocalPart", () => {
  it("rejects ineligible tiers", async () => {
    await expect(
      setPersonalizedLocalPart({ businessId: "biz-1", tier: "starter", localPart: "amy" }, fakeDb([]) as never)
    ).rejects.toMatchObject({ code: "tier_not_eligible" });
  });
  it("rejects invalid handles via normalize", async () => {
    await expect(
      setPersonalizedLocalPart({ businessId: "biz-1", tier: "standard", localPart: "ab" }, fakeDb([]) as never)
    ).rejects.toMatchObject({ code: "invalid_format" });
  });
  it("rejects a handle taken by another business", async () => {
    const db = fakeDb([{ data: { business_id: "biz-2" }, error: null }]); // availability check
    await expect(
      setPersonalizedLocalPart({ businessId: "biz-1", tier: "standard", localPart: "amy" }, db as never)
    ).rejects.toMatchObject({ code: "taken" });
  });
  it("upserts and returns the row on success", async () => {
    const db = fakeDb([
      { data: null, error: null }, // availability: free
      { data: ROW, error: null } // upsert.single
    ]);
    await expect(
      setPersonalizedLocalPart({ businessId: "biz-1", tier: "enterprise", localPart: "amy" }, db as never)
    ).resolves.toEqual(ROW);
  });
  it("maps an upsert unique-violation to taken", async () => {
    const db = fakeDb([
      { data: null, error: null },
      { data: null, error: { code: "23505" } }
    ]);
    await expect(
      setPersonalizedLocalPart({ businessId: "biz-1", tier: "standard", localPart: "amy" }, db as never)
    ).rejects.toMatchObject({ code: "taken" });
  });
  it("throws on other upsert errors", async () => {
    const db = fakeDb([
      { data: null, error: null },
      { data: null, error: { code: "500", message: "down" } }
    ]);
    await expect(
      setPersonalizedLocalPart({ businessId: "biz-1", tier: "standard", localPart: "amy" }, db as never)
    ).rejects.toThrow("setPersonalizedLocalPart: down");
  });
  it("uses the default client when none injected", async () => {
    defaultClientSpy.mockResolvedValueOnce(
      fakeDb([
        { data: null, error: null },
        { data: ROW, error: null }
      ])
    );
    await expect(
      setPersonalizedLocalPart({ businessId: "biz-1", tier: "standard", localPart: "amy" })
    ).resolves.toEqual(ROW);
  });
});

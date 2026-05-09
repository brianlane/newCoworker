import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CUSTOM_AUTH_SCHEMES,
  CUSTOM_DESCRIPTION_MAX,
  CUSTOM_LABEL_MAX,
  CustomIntegrationValidationError,
  createCustomIntegration,
  deleteCustomIntegration,
  getCustomIntegrationById,
  getCustomIntegrationByLabel,
  isBareIpHost,
  isPrivateOrLoopbackHost,
  listCustomIntegrations,
  parseBaseUrl,
  toPublicCustomIntegration,
  updateCustomIntegration,
  validateUpsertInput
} from "@/lib/db/custom-integrations";
import { encryptIntegrationSecret } from "@/lib/integrations/secrets";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";

const ROW = {
  id: "ci-1",
  business_id: "biz-1",
  label: "Acme CRM",
  base_url: "https://api.acme.com/v2",
  auth_scheme: "bearer" as const,
  header_name: null,
  secret_encrypted: null as string | null,
  description: "Acme contacts + deals",
  is_active: true,
  created_at: "2026-05-08T00:00:00Z",
  updated_at: "2026-05-08T00:00:00Z"
};

function dbStub(overrides: Record<string, unknown> = {}) {
  return {
    from: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    ilike: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: ROW, error: null }),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.INTEGRATIONS_ENCRYPTION_KEY = "test-secret-for-custom-integrations";
});

describe("isPrivateOrLoopbackHost", () => {
  it.each([
    ["localhost", true],
    ["api.localhost", true],
    ["evil.LOCALHOST", true],
    ["127.0.0.1", true],
    ["10.0.0.5", true],
    ["172.16.4.7", true],
    ["172.31.255.254", true],
    ["172.15.0.1", false],
    ["172.32.0.1", false],
    ["192.168.1.1", true],
    ["169.254.169.254", true],
    ["0.0.0.0", true],
    ["metadata.google.internal", true],
    ["api.acme.com", false],
    ["8.8.8.8", false],
    // Out-of-range octets: shape matches IPv4 dotted-quad, but the
    // shared `isPrivateIpv4` helper conservatively classifies any
    // input outside 0–255 as private. We adopt that conservative
    // answer at registration time too — refusing nonsense addresses
    // costs nothing and removes an obfuscation vector.
    ["256.256.256.256", true],
    // Multicast (224–239) + reserved (240–255) — the local IPv4
    // helper used to miss these; now delegated to the shared module.
    ["224.0.0.1", true],
    ["239.255.255.255", true],
    ["240.0.0.1", true],
    ["255.255.255.255", true],
    // IPv6 — defense-in-depth so a future caller relying on this
    // function alone (without isBareIpHost) doesn't have an SSRF gap.
    ["::1", true],
    ["::", true],
    ["fc00::1", true],
    ["fd12:3456::abcd", true],
    ["fe80::1", true],
    ["::ffff:127.0.0.1", true],
    ["::ffff:10.0.0.5", true],
    ["::ffff:8.8.8.8", false],
    ["2001:4860:4860::8888", false],
    ["fb00::1", false]
  ])("classifies %s as private=%s", (host, expected) => {
    expect(isPrivateOrLoopbackHost(host)).toBe(expected);
  });
});

describe("parseBaseUrl", () => {
  it("accepts a clean https URL", () => {
    const r = parseBaseUrl("https://api.acme.com/v2");
    expect(r).toEqual({ origin: "https://api.acme.com", pathPrefix: "/v2" });
  });

  it("normalizes trailing slash on path", () => {
    const r = parseBaseUrl("https://api.acme.com/v2/");
    expect(r.pathPrefix).toBe("/v2");
  });

  it("preserves explicit '/' as the root path", () => {
    const r = parseBaseUrl("https://api.acme.com/");
    expect(r.pathPrefix).toBe("/");
  });

  it("rejects http://", () => {
    expect(() => parseBaseUrl("http://api.acme.com")).toThrow(/https/);
  });

  it("rejects malformed URLs", () => {
    expect(() => parseBaseUrl("not a url")).toThrow(/valid URL/);
  });

  it("rejects userinfo (user:pass@host)", () => {
    expect(() => parseBaseUrl("https://u:p@api.acme.com")).toThrow(/userinfo/);
  });

  it("rejects query string in base_url", () => {
    expect(() => parseBaseUrl("https://api.acme.com/?x=1")).toThrow(/query/);
  });

  it("rejects fragment in base_url", () => {
    expect(() => parseBaseUrl("https://api.acme.com/#x")).toThrow(/query/);
  });

  it("rejects private hosts", () => {
    expect(() => parseBaseUrl("https://localhost/x")).toThrow(/private/);
    expect(() => parseBaseUrl("https://169.254.169.254/")).toThrow(/private/);
  });

  it("rejects bare public IPv4 literals", () => {
    // 93.184.216.34 (example.com) is public, so it would pass the
    // private-host check. But the call-time SSRF guard always refuses
    // bare IP literals, so the registration must refuse them too.
    expect(() => parseBaseUrl("https://93.184.216.34/api")).toThrow(
      /bare IP literal/
    );
    expect(() => parseBaseUrl("https://8.8.8.8/v1")).toThrow(/bare IP literal/);
  });

  it("rejects bare IPv6 literals", () => {
    // URL spec strips brackets from `url.hostname`, but the colon
    // remains and is the unmistakable signal of an IPv6 literal.
    expect(() => parseBaseUrl("https://[2001:4860:4860::8888]/v1")).toThrow(
      /bare IP literal/
    );
  });
});

describe("isBareIpHost", () => {
  it.each([
    ["8.8.8.8", true],
    ["93.184.216.34", true],
    ["256.256.256.256", false],
    ["api.acme.com", false],
    ["2001:4860:4860::8888", true],
    ["::1", true],
    ["my-host", false]
  ])("classifies %s as bareIp=%s", (host, expected) => {
    expect(isBareIpHost(host)).toBe(expected);
  });
});

describe("validateUpsertInput", () => {
  const base = {
    businessId: "biz-1",
    label: "Acme",
    baseUrl: "https://api.acme.com",
    authScheme: "bearer" as const,
    secret: "k"
  };

  it("accepts a minimal create payload", () => {
    expect(() => validateUpsertInput(base)).not.toThrow();
  });

  it("rejects empty label", () => {
    expect(() => validateUpsertInput({ ...base, label: "" })).toThrow(
      CustomIntegrationValidationError
    );
  });

  it("rejects label longer than CUSTOM_LABEL_MAX", () => {
    expect(() =>
      validateUpsertInput({ ...base, label: "x".repeat(CUSTOM_LABEL_MAX + 1) })
    ).toThrow(/exceeds/);
  });

  it("rejects control characters in label", () => {
    expect(() => validateUpsertInput({ ...base, label: "Acme\u0001" })).toThrow(
      /control/
    );
  });

  it("requires header_name when scheme is 'header'", () => {
    expect(() =>
      validateUpsertInput({ ...base, authScheme: "header" })
    ).toThrow(/header_name is required/);
  });

  it("requires header_name when scheme is 'query'", () => {
    expect(() =>
      validateUpsertInput({ ...base, authScheme: "query" })
    ).toThrow(/header_name is required/);
  });

  it("rejects header_name with bad characters", () => {
    expect(() =>
      validateUpsertInput({
        ...base,
        authScheme: "header",
        headerName: "bad header"
      })
    ).toThrow(/invalid characters/);
  });

  it("requires a secret on create when scheme is not 'none'", () => {
    expect(() =>
      validateUpsertInput({ ...base, secret: undefined })
    ).toThrow(/secret is required/);
    expect(() =>
      validateUpsertInput({ ...base, secret: "" })
    ).toThrow(/secret is required/);
    expect(() =>
      validateUpsertInput({ ...base, secret: null })
    ).toThrow(/secret is required/);
  });

  it("does NOT require a secret on update when scheme is not 'none' (undefined = leave alone)", () => {
    expect(() =>
      validateUpsertInput({ ...base, id: "ci-1", secret: undefined })
    ).not.toThrow();
  });

  it("does NOT require a secret when scheme is 'none'", () => {
    expect(() =>
      validateUpsertInput({ ...base, authScheme: "none", secret: undefined })
    ).not.toThrow();
  });

  it("rejects description longer than CUSTOM_DESCRIPTION_MAX", () => {
    expect(() =>
      validateUpsertInput({
        ...base,
        description: "x".repeat(CUSTOM_DESCRIPTION_MAX + 1)
      })
    ).toThrow(/description exceeds/);
  });

  it("rejects label that is whitespace-only", () => {
    expect(() => validateUpsertInput({ ...base, label: "   " })).toThrow(
      /label is required/
    );
  });

  it("rejects label that exceeds CUSTOM_LABEL_MAX after trimming", () => {
    expect(() =>
      validateUpsertInput({ ...base, label: `  ${"x".repeat(CUSTOM_LABEL_MAX + 1)}  ` })
    ).toThrow(/exceeds/);
  });

  it("rejects header_name longer than max", () => {
    expect(() =>
      validateUpsertInput({
        ...base,
        authScheme: "header",
        headerName: "X".repeat(200)
      })
    ).toThrow(/exceeds/);
  });

  it("rejects unknown auth_scheme cast through the type", () => {
    expect(() =>
      validateUpsertInput({
        ...base,
        // @ts-expect-error — testing runtime guard against type-cast bypass
        authScheme: "garbage"
      })
    ).toThrow(/auth_scheme is invalid/);
  });

  it("CUSTOM_AUTH_SCHEMES includes all five schemes", () => {
    expect(CUSTOM_AUTH_SCHEMES).toEqual([
      "bearer",
      "header",
      "basic",
      "query",
      "none"
    ]);
  });
});

describe("toPublicCustomIntegration", () => {
  it("strips secret_encrypted and sets has_secret=true when present", () => {
    const pub = toPublicCustomIntegration({ ...ROW, secret_encrypted: "enc:v1:..." });
    expect(pub.has_secret).toBe(true);
    expect((pub as unknown as Record<string, unknown>).secret_encrypted).toBeUndefined();
  });

  it("sets has_secret=false when secret_encrypted is null", () => {
    const pub = toPublicCustomIntegration({ ...ROW, secret_encrypted: null });
    expect(pub.has_secret).toBe(false);
  });
});

describe("listCustomIntegrations", () => {
  it("returns rows with has_secret booleans (no cleartext leakage)", async () => {
    const rows = [
      { ...ROW, secret_encrypted: encryptIntegrationSecret("k") },
      { ...ROW, id: "ci-2", label: "Other", secret_encrypted: null }
    ];
    const order = vi.fn().mockResolvedValue({ data: rows, error: null });
    const db = dbStub({ order });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const res = await listCustomIntegrations("biz-1");
    expect(res).toHaveLength(2);
    expect(res[0].has_secret).toBe(true);
    expect(res[1].has_secret).toBe(false);
    for (const r of res) {
      expect((r as unknown as Record<string, unknown>).secret_encrypted).toBeUndefined();
      expect((r as unknown as Record<string, unknown>).secret).toBeUndefined();
    }
  });

  it("filters by is_active when activeOnly=true", async () => {
    const order = vi.fn().mockResolvedValue({ data: [], error: null });
    const eq = vi.fn().mockReturnValue({ order, eq: vi.fn().mockReturnValue({ order }) });
    const select = vi.fn().mockReturnValue({ eq });
    const from = vi.fn().mockReturnValue({ select });
    const db = { from } as unknown as never;

    await listCustomIntegrations("biz-1", { activeOnly: true }, db);
    expect(eq).toHaveBeenCalledWith("business_id", "biz-1");
  });

  it("throws on db error", async () => {
    const order = vi
      .fn()
      .mockResolvedValue({ data: null, error: { message: "boom" } });
    const db = dbStub({ order });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(listCustomIntegrations("biz-1")).rejects.toThrow(/boom/);
  });

  it("returns [] when the DB returns null data without an error", async () => {
    const order = vi.fn().mockResolvedValue({ data: null, error: null });
    const db = dbStub({ order });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(listCustomIntegrations("biz-1")).resolves.toEqual([]);
  });
});

describe("getCustomIntegrationByLabel", () => {
  it("returns null on empty label", async () => {
    const r = await getCustomIntegrationByLabel("biz-1", "  ");
    expect(r).toBeNull();
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  it("returns null when no match", async () => {
    const db = dbStub({
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await getCustomIntegrationByLabel("biz-1", "missing")).toBeNull();
  });

  it("returns decrypted row on match (cleartext secret available to caller)", async () => {
    const encrypted = {
      ...ROW,
      secret_encrypted: encryptIntegrationSecret("super-secret")
    };
    const db = dbStub({
      maybeSingle: vi.fn().mockResolvedValue({ data: encrypted, error: null })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const row = await getCustomIntegrationByLabel("biz-1", "Acme CRM");
    expect(row?.secret).toBe("super-secret");
    expect(row?.label).toBe("Acme CRM");
  });

  it("uses ilike() for case-insensitive lookup", async () => {
    const ilike = vi.fn().mockReturnThis();
    const db = dbStub({
      ilike,
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await getCustomIntegrationByLabel("biz-1", "ACME crm");
    // `ACME crm` has no LIKE wildcards, so the escaped form is identical.
    expect(ilike).toHaveBeenCalledWith("label", "ACME crm");
  });

  it("escapes LIKE/ILIKE wildcards so '%' / '_' are treated as literal", async () => {
    const ilike = vi.fn().mockReturnThis();
    const db = dbStub({
      ilike,
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    // An agent that submits `%` for the label must not match any row in
    // the business — and definitely must not stream a credential to the
    // first row found by collation order.
    await getCustomIntegrationByLabel("biz-1", "%");
    expect(ilike).toHaveBeenCalledWith("label", "\\%");

    await getCustomIntegrationByLabel("biz-1", "ac_me");
    expect(ilike).toHaveBeenCalledWith("label", "ac\\_me");

    await getCustomIntegrationByLabel("biz-1", "back\\slash");
    expect(ilike).toHaveBeenCalledWith("label", "back\\\\slash");
  });

  it("throws on db error", async () => {
    const db = dbStub({
      maybeSingle: vi
        .fn()
        .mockResolvedValue({ data: null, error: { message: "boom" } })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(getCustomIntegrationByLabel("biz-1", "Acme")).rejects.toThrow(
      /boom/
    );
  });
});

describe("createCustomIntegration", () => {
  it("encrypts secret before insert and returns public shape", async () => {
    const inserted = {
      ...ROW,
      secret_encrypted: encryptIntegrationSecret("k")
    };
    const single = vi.fn().mockResolvedValue({ data: inserted, error: null });
    const select = vi.fn().mockReturnValue({ single });
    const insert = vi.fn().mockReturnValue({ select });
    const from = vi.fn().mockReturnValue({ insert });
    const db = { from } as unknown as never;

    const res = await createCustomIntegration(
      {
        businessId: "biz-1",
        label: "Acme CRM",
        baseUrl: "https://api.acme.com/v2",
        authScheme: "bearer",
        secret: "k"
      },
      db
    );
    expect(res.has_secret).toBe(true);
    const payload = insert.mock.calls[0][0] as Record<string, string>;
    expect(payload.secret_encrypted).toMatch(/^enc:v1:/);
    // The cleartext is 1 char so "doesn't contain k" can collide with
    // random base64; assert via length instead — encrypted form is far
    // longer than the cleartext.
    expect(payload.secret_encrypted.length).toBeGreaterThan(20);
  });

  it("stores null secret when scheme is 'none'", async () => {
    const single = vi.fn().mockResolvedValue({
      data: { ...ROW, auth_scheme: "none", secret_encrypted: null },
      error: null
    });
    const select = vi.fn().mockReturnValue({ single });
    const insert = vi.fn().mockReturnValue({ select });
    const from = vi.fn().mockReturnValue({ insert });
    const db = { from } as unknown as never;

    await createCustomIntegration(
      {
        businessId: "biz-1",
        label: "Public API",
        baseUrl: "https://api.example.com",
        authScheme: "none"
      },
      db
    );
    const payload = insert.mock.calls[0][0] as Record<string, string | null>;
    expect(payload.secret_encrypted).toBeNull();
  });

  it("nulls header_name when scheme doesn't need it", async () => {
    const single = vi.fn().mockResolvedValue({ data: ROW, error: null });
    const select = vi.fn().mockReturnValue({ single });
    const insert = vi.fn().mockReturnValue({ select });
    const from = vi.fn().mockReturnValue({ insert });
    const db = { from } as unknown as never;

    await createCustomIntegration(
      {
        businessId: "biz-1",
        label: "Acme",
        baseUrl: "https://api.acme.com",
        authScheme: "bearer",
        secret: "k",
        headerName: "ignored"
      },
      db
    );
    const payload = insert.mock.calls[0][0] as Record<string, string | null>;
    expect(payload.header_name).toBeNull();
  });

  it("throws CustomIntegrationValidationError on bad input", async () => {
    await expect(
      createCustomIntegration({
        businessId: "biz-1",
        label: "",
        baseUrl: "https://api.acme.com",
        authScheme: "bearer",
        secret: "k"
      })
    ).rejects.toBeInstanceOf(CustomIntegrationValidationError);
  });
});

/**
 * Build a stub Supabase client that supports both call patterns inside
 * `updateCustomIntegration`:
 *   - `db.from(t).update(...).eq(...).eq(...).select().single()` (the
 *     actual update),
 *   - `db.from(t).select("secret_encrypted,auth_scheme").eq(...).eq(...).maybeSingle()`
 *     (the existence-check that runs when the caller selected a
 *     credentialed scheme but didn't supply a new secret).
 *
 * Tests can override either chain via the options bag. The default
 * existence-check returns a row with auth_scheme="bearer" — matching
 * the typical test input — so non-rotation updates short-circuit
 * cleanly. Override `selectMaybeSingle` to exercise scheme-change /
 * missing-row / DB-error branches.
 */
type UpdateDbOptions = {
  /** Resolves the .single() at the end of the update chain. */
  updateSingle?: ReturnType<typeof vi.fn>;
  /** Resolves the .maybeSingle() at the end of the existence-check chain. */
  selectMaybeSingle?: ReturnType<typeof vi.fn>;
};

function buildUpdateDb(options: UpdateDbOptions = {}) {
  const updateSingle =
    options.updateSingle ?? vi.fn().mockResolvedValue({ data: ROW, error: null });
  const selectAfterUpdate = vi.fn().mockReturnValue({ single: updateSingle });
  const eqInnerUpdate = vi.fn().mockReturnValue({ select: selectAfterUpdate });
  const eqOuterUpdate = vi.fn().mockReturnValue({ eq: eqInnerUpdate });
  const update = vi.fn().mockReturnValue({ eq: eqOuterUpdate });

  const maybeSingle =
    options.selectMaybeSingle ??
    vi.fn().mockResolvedValue({
      data: { secret_encrypted: "enc:v1:existing", auth_scheme: "bearer" },
      error: null
    });
  const eqInnerSelect = vi.fn().mockReturnValue({ maybeSingle });
  const eqOuterSelect = vi.fn().mockReturnValue({ eq: eqInnerSelect });
  const select = vi.fn().mockReturnValue({ eq: eqOuterSelect });

  const from = vi.fn().mockReturnValue({ update, select });
  return { db: { from } as unknown as never, update, maybeSingle };
}

describe("updateCustomIntegration", () => {
  it("omits secret_encrypted from patch when secret is undefined (preserves stored)", async () => {
    const { db, update } = buildUpdateDb();

    await updateCustomIntegration(
      {
        id: "ci-1",
        businessId: "biz-1",
        label: "Acme CRM",
        baseUrl: "https://api.acme.com/v2",
        authScheme: "bearer"
      },
      db
    );
    const patch = update.mock.calls[0][0] as Record<string, unknown>;
    expect(patch).not.toHaveProperty("secret_encrypted");
  });

  it("encrypts and writes secret when caller supplies a value", async () => {
    const { db, update } = buildUpdateDb();

    await updateCustomIntegration(
      {
        id: "ci-1",
        businessId: "biz-1",
        label: "Acme CRM",
        baseUrl: "https://api.acme.com/v2",
        authScheme: "bearer",
        secret: "rotated"
      },
      db
    );
    const patch = update.mock.calls[0][0] as Record<string, string>;
    expect(patch.secret_encrypted).toMatch(/^enc:v1:/);
  });

  it("clears secret_encrypted when scheme flips to 'none'", async () => {
    const { db, update } = buildUpdateDb();

    await updateCustomIntegration(
      {
        id: "ci-1",
        businessId: "biz-1",
        label: "Acme CRM",
        baseUrl: "https://api.acme.com/v2",
        authScheme: "none"
      },
      db
    );
    const patch = update.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.secret_encrypted).toBeNull();
  });

  it("treats empty secret string as 'leave alone' (not 'clear')", async () => {
    const { db, update } = buildUpdateDb();

    await updateCustomIntegration(
      {
        id: "ci-1",
        businessId: "biz-1",
        label: "Acme CRM",
        baseUrl: "https://api.acme.com/v2",
        authScheme: "bearer",
        secret: ""
      },
      db
    );
    const patch = update.mock.calls[0][0] as Record<string, unknown>;
    // Empty-string must NOT clobber the stored ciphertext — that would
    // leave the row with scheme=bearer + no credential.
    expect(patch).not.toHaveProperty("secret_encrypted");
  });

  it("rejects update when scheme=bearer but no stored secret AND none supplied", async () => {
    // Same-scheme update path — row's existing scheme matches the
    // input scheme, but the stored ciphertext is null. The row would
    // be unusable, so refuse.
    const selectMaybeSingle = vi.fn().mockResolvedValue({
      data: { secret_encrypted: null, auth_scheme: "bearer" },
      error: null
    });
    const { db } = buildUpdateDb({ selectMaybeSingle });

    await expect(
      updateCustomIntegration(
        {
          id: "ci-1",
          businessId: "biz-1",
          label: "Acme CRM",
          baseUrl: "https://api.acme.com/v2",
          authScheme: "bearer"
        },
        db
      )
    ).rejects.toMatchObject({
      validationCode: "secret_required",
      // Same-scheme path uses the original (non-scheme-change) message.
      message: /secret is required/i
    });
  });

  it("rejects update when scheme=bearer + empty secret AND row has no stored secret", async () => {
    const selectMaybeSingle = vi.fn().mockResolvedValue({
      data: { secret_encrypted: null },
      error: null
    });
    const { db } = buildUpdateDb({ selectMaybeSingle });

    await expect(
      updateCustomIntegration(
        {
          id: "ci-1",
          businessId: "biz-1",
          label: "Acme CRM",
          baseUrl: "https://api.acme.com/v2",
          authScheme: "bearer",
          secret: ""
        },
        db
      )
    ).rejects.toMatchObject({
      validationCode: "secret_required"
    });
  });

  it("rejects update when row no longer exists (race / cross-tenant)", async () => {
    const selectMaybeSingle = vi
      .fn()
      .mockResolvedValue({ data: null, error: null });
    const { db } = buildUpdateDb({ selectMaybeSingle });

    await expect(
      updateCustomIntegration(
        {
          id: "ci-1",
          businessId: "biz-1",
          label: "Acme CRM",
          baseUrl: "https://api.acme.com/v2",
          authScheme: "bearer"
        },
        db
      )
    ).rejects.toBeInstanceOf(CustomIntegrationValidationError);
  });

  it("propagates DB error on the existence-check fetch", async () => {
    const selectMaybeSingle = vi
      .fn()
      .mockResolvedValue({ data: null, error: { message: "rls denied" } });
    const { db } = buildUpdateDb({ selectMaybeSingle });

    await expect(
      updateCustomIntegration(
        {
          id: "ci-1",
          businessId: "biz-1",
          label: "Acme CRM",
          baseUrl: "https://api.acme.com/v2",
          authScheme: "bearer"
        },
        db
      )
    ).rejects.toThrow(/rls denied/);
  });

  // Bugbot finding: "Auth scheme change silently keeps incompatible
  // stored secret". Switching e.g. bearer → basic with empty fields
  // used to silently keep the old bearer token as the basic-auth
  // secret, producing a row the proxy can never honor (it base64s
  // the bearer token as if it were `user:pass`). The server now
  // refuses any scheme change that doesn't come with a fresh
  // credential, regardless of whether the stored row has SOME
  // secret on file.
  it("refuses bearer→basic scheme change with empty secret (silent-breakage guard)", async () => {
    const selectMaybeSingle = vi.fn().mockResolvedValue({
      data: { secret_encrypted: "enc:v1:bearer-token", auth_scheme: "bearer" },
      error: null
    });
    const { db } = buildUpdateDb({ selectMaybeSingle });

    await expect(
      updateCustomIntegration(
        {
          id: "ci-1",
          businessId: "biz-1",
          label: "Acme CRM",
          baseUrl: "https://api.acme.com/v2",
          authScheme: "basic"
          // No secret supplied: previously the row would silently
          // keep the bearer token as the basic-auth secret.
        },
        db
      )
    ).rejects.toMatchObject({
      validationCode: "secret_required",
      message: /switching login type/i
    });
  });

  it("refuses bearer→header scheme change with empty secret", async () => {
    const selectMaybeSingle = vi.fn().mockResolvedValue({
      data: { secret_encrypted: "enc:v1:bearer-token", auth_scheme: "bearer" },
      error: null
    });
    const { db } = buildUpdateDb({ selectMaybeSingle });

    await expect(
      updateCustomIntegration(
        {
          id: "ci-1",
          businessId: "biz-1",
          label: "Acme CRM",
          baseUrl: "https://api.acme.com/v2",
          authScheme: "header",
          headerName: "X-API-Key"
        },
        db
      )
    ).rejects.toMatchObject({
      validationCode: "secret_required",
      message: /switching login type/i
    });
  });

  it("allows bearer→basic scheme change when a fresh secret is supplied", async () => {
    const selectMaybeSingle = vi.fn().mockResolvedValue({
      data: { secret_encrypted: "enc:v1:bearer-token", auth_scheme: "bearer" },
      error: null
    });
    const { db, update } = buildUpdateDb({ selectMaybeSingle });

    await updateCustomIntegration(
      {
        id: "ci-1",
        businessId: "biz-1",
        label: "Acme CRM",
        baseUrl: "https://api.acme.com/v2",
        authScheme: "basic",
        secret: "newuser:newpass"
      },
      db
    );
    const patch = update.mock.calls[0][0] as Record<string, string>;
    expect(patch.auth_scheme).toBe("basic");
    expect(patch.secret_encrypted).toMatch(/^enc:v1:/);
  });

  it("allows credentialed→none scheme change without a secret (clears stored)", async () => {
    // Going from a credentialed scheme to "none" must NOT require a
    // fresh secret — the patch wipes the stored ciphertext anyway.
    const selectMaybeSingle = vi.fn().mockResolvedValue({
      data: { secret_encrypted: "enc:v1:bearer-token", auth_scheme: "bearer" },
      error: null
    });
    const { db, update } = buildUpdateDb({ selectMaybeSingle });

    await updateCustomIntegration(
      {
        id: "ci-1",
        businessId: "biz-1",
        label: "Acme CRM",
        baseUrl: "https://api.acme.com/v2",
        authScheme: "none"
      },
      db
    );
    const patch = update.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.auth_scheme).toBe("none");
    expect(patch.secret_encrypted).toBeNull();
  });
});

describe("deleteCustomIntegration", () => {
  it("deletes and resolves on success", async () => {
    const eqInner = vi.fn().mockResolvedValue({ error: null });
    const eqOuter = vi.fn().mockReturnValue({ eq: eqInner });
    const del = vi.fn().mockReturnValue({ eq: eqOuter });
    const from = vi.fn().mockReturnValue({ delete: del });
    const db = { from } as unknown as never;

    await deleteCustomIntegration("biz-1", "ci-1", db);
    expect(from).toHaveBeenCalledWith("custom_integrations");
  });

  it("throws on error", async () => {
    const eqInner = vi.fn().mockResolvedValue({ error: { message: "no" } });
    const eqOuter = vi.fn().mockReturnValue({ eq: eqInner });
    const del = vi.fn().mockReturnValue({ eq: eqOuter });
    const from = vi.fn().mockReturnValue({ delete: del });
    const db = { from } as unknown as never;

    await expect(deleteCustomIntegration("biz-1", "ci-1", db)).rejects.toThrow(/no/);
  });
});

describe("getCustomIntegrationById", () => {
  it("returns public shape (no secret)", async () => {
    const db = dbStub({
      maybeSingle: vi.fn().mockResolvedValue({
        data: { ...ROW, secret_encrypted: encryptIntegrationSecret("k") },
        error: null
      })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    const r = await getCustomIntegrationById("biz-1", "ci-1");
    expect(r?.has_secret).toBe(true);
    expect((r as unknown as Record<string, unknown>).secret).toBeUndefined();
  });

  it("returns null when missing", async () => {
    const db = dbStub({
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await getCustomIntegrationById("biz-1", "ci-1")).toBeNull();
  });

  it("throws on db error", async () => {
    const db = dbStub({
      maybeSingle: vi
        .fn()
        .mockResolvedValue({ data: null, error: { message: "bad" } })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(getCustomIntegrationById("biz-1", "ci-1")).rejects.toThrow(
      /bad/
    );
  });
});

describe("createCustomIntegration extras", () => {
  it("preserves header_name when scheme=query", async () => {
    const single = vi.fn().mockResolvedValue({ data: ROW, error: null });
    const select = vi.fn().mockReturnValue({ single });
    const insert = vi.fn().mockReturnValue({ select });
    const from = vi.fn().mockReturnValue({ insert });
    const db = { from } as unknown as never;

    await createCustomIntegration(
      {
        businessId: "biz-1",
        label: "Acme",
        baseUrl: "https://api.acme.com",
        authScheme: "query",
        headerName: "api_key",
        secret: "k"
      },
      db
    );
    const payload = insert.mock.calls[0][0] as Record<string, string | null>;
    expect(payload.header_name).toBe("api_key");
  });

  it("trims and stores a non-empty description", async () => {
    const single = vi.fn().mockResolvedValue({ data: ROW, error: null });
    const select = vi.fn().mockReturnValue({ single });
    const insert = vi.fn().mockReturnValue({ select });
    const from = vi.fn().mockReturnValue({ insert });
    const db = { from } as unknown as never;

    await createCustomIntegration(
      {
        businessId: "biz-1",
        label: "Acme",
        baseUrl: "https://api.acme.com",
        authScheme: "bearer",
        secret: "k",
        description: "  Acme contacts  "
      },
      db
    );
    const payload = insert.mock.calls[0][0] as Record<string, string | null>;
    expect(payload.description).toBe("Acme contacts");
  });

  it("normalizes whitespace-only description to null", async () => {
    const single = vi.fn().mockResolvedValue({ data: ROW, error: null });
    const select = vi.fn().mockReturnValue({ single });
    const insert = vi.fn().mockReturnValue({ select });
    const from = vi.fn().mockReturnValue({ insert });
    const db = { from } as unknown as never;

    await createCustomIntegration(
      {
        businessId: "biz-1",
        label: "Acme",
        baseUrl: "https://api.acme.com",
        authScheme: "bearer",
        secret: "k",
        description: "   "
      },
      db
    );
    const payload = insert.mock.calls[0][0] as Record<string, string | null>;
    expect(payload.description).toBeNull();
  });

  it("throws on db error", async () => {
    const single = vi
      .fn()
      .mockResolvedValue({ data: null, error: { message: "no" } });
    const select = vi.fn().mockReturnValue({ single });
    const insert = vi.fn().mockReturnValue({ select });
    const from = vi.fn().mockReturnValue({ insert });
    const db = { from } as unknown as never;

    await expect(
      createCustomIntegration(
        {
          businessId: "biz-1",
          label: "Acme",
          baseUrl: "https://api.acme.com",
          authScheme: "bearer",
          secret: "k"
        },
        db
      )
    ).rejects.toThrow(/no/);
  });

  it("lazily creates the service client when none is injected", async () => {
    const single = vi.fn().mockResolvedValue({ data: ROW, error: null });
    const select = vi.fn().mockReturnValue({ single });
    const insert = vi.fn().mockReturnValue({ select });
    const from = vi.fn().mockReturnValue({ insert });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(
      { from } as never
    );
    await createCustomIntegration({
      businessId: "biz-1",
      label: "Acme",
      baseUrl: "https://api.acme.com",
      authScheme: "bearer",
      secret: "k"
    });
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });
});

describe("updateCustomIntegration extras", () => {
  it("preserves header_name when scheme=header on update", async () => {
    // Stored row already had scheme=header so no fresh credential is
    // required to keep editing header_name / label / etc.
    const selectMaybeSingle = vi.fn().mockResolvedValue({
      data: { secret_encrypted: "enc:v1:existing", auth_scheme: "header" },
      error: null
    });
    const { db, update } = buildUpdateDb({ selectMaybeSingle });
    await updateCustomIntegration(
      {
        id: "ci-1",
        businessId: "biz-1",
        label: "Acme CRM",
        baseUrl: "https://api.acme.com/v2",
        authScheme: "header",
        headerName: "X-API-Key"
      },
      db
    );
    const patch = update.mock.calls[0][0] as Record<string, string | null>;
    expect(patch.header_name).toBe("X-API-Key");
  });

  it("writes is_active when caller supplies it", async () => {
    const { db, update } = buildUpdateDb();
    await updateCustomIntegration(
      {
        id: "ci-1",
        businessId: "biz-1",
        label: "Acme CRM",
        baseUrl: "https://api.acme.com/v2",
        authScheme: "bearer",
        isActive: false
      },
      db
    );
    const patch = update.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.is_active).toBe(false);
  });

  it("clears stored secret when caller passes null with scheme=none", async () => {
    const { db, update } = buildUpdateDb();
    await updateCustomIntegration(
      {
        id: "ci-1",
        businessId: "biz-1",
        label: "Acme CRM",
        baseUrl: "https://api.acme.com/v2",
        authScheme: "none",
        secret: null
      },
      db
    );
    const patch = update.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.secret_encrypted).toBeNull();
  });

  it("throws on db error", async () => {
    const updateSingle = vi
      .fn()
      .mockResolvedValue({ data: null, error: { message: "denied" } });
    const { db } = buildUpdateDb({ updateSingle });
    await expect(
      updateCustomIntegration(
        {
          id: "ci-1",
          businessId: "biz-1",
          label: "Acme",
          baseUrl: "https://api.acme.com",
          authScheme: "bearer",
          // Supply secret so the existence-check is bypassed and the
          // failing path is the actual UPDATE.
          secret: "k"
        },
        db
      )
    ).rejects.toThrow(/denied/);
  });

  it("lazily creates the service client when none is injected", async () => {
    const { db: stub } = buildUpdateDb();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(stub as never);
    await updateCustomIntegration({
      id: "ci-1",
      businessId: "biz-1",
      label: "Acme",
      baseUrl: "https://api.acme.com",
      authScheme: "bearer",
      secret: "rotated"
    });
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });
});

describe("listCustomIntegrations + service client", () => {
  it("lazily creates the service client when none is injected", async () => {
    const order = vi.fn().mockResolvedValue({ data: [], error: null });
    const db = dbStub({ order });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await listCustomIntegrations("biz-1");
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });
});

describe("deleteCustomIntegration + service client", () => {
  it("lazily creates the service client when none is injected", async () => {
    const eqInner = vi.fn().mockResolvedValue({ error: null });
    const eqOuter = vi.fn().mockReturnValue({ eq: eqInner });
    const del = vi.fn().mockReturnValue({ eq: eqOuter });
    const from = vi.fn().mockReturnValue({ delete: del });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(
      { from } as never
    );
    await deleteCustomIntegration("biz-1", "ci-1");
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });
});

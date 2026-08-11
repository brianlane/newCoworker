import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import {
  deleteWorkspaceOAuthConnection,
  flipWorkspaceConnectionToDirect,
  getWorkspaceConnectionSecrets,
  insertDirectWorkspaceConnection,
  setWorkspaceConnectionActive,
  updateWorkspaceConnectionTokens,
  getWorkspaceOAuthConnection,
  getWorkspaceOAuthConnectionByNangoIds,
  listWorkspaceOAuthConnections,
  updateWorkspaceOAuthConnectionLink,
  upsertWorkspaceOAuthConnection
} from "@/lib/db/workspace-oauth-connections";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  decryptIntegrationSecret,
  encryptIntegrationSecret
} from "@/lib/integrations/secrets";

const MOCK = {
  id: "woc-1",
  business_id: "biz-1",
  provider_config_key: "gmail",
  connection_id: "conn-1",
  metadata: {},
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z"
};

function mockDb(overrides: Record<string, unknown> = {}) {
  return {
    from: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    upsert: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: MOCK, error: null }),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    ...overrides
  };
}

describe("db/workspace-oauth-connections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("listWorkspaceOAuthConnections returns rows", async () => {
    const db = {
      ...mockDb(),
      order: vi.fn().mockResolvedValue({ data: [MOCK], error: null })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const rows = await listWorkspaceOAuthConnections("biz-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].connection_id).toBe("conn-1");
  });

  it("listWorkspaceOAuthConnections throws on error", async () => {
    const db = {
      ...mockDb(),
      order: vi.fn().mockResolvedValue({ data: null, error: { message: "e" } })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(listWorkspaceOAuthConnections("biz-1")).rejects.toThrow(
      "listWorkspaceOAuthConnections"
    );
  });

  it("listWorkspaceOAuthConnections returns empty when data is null", async () => {
    const db = {
      ...mockDb(),
      order: vi.fn().mockResolvedValue({ data: null, error: null })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(listWorkspaceOAuthConnections("biz-1")).resolves.toEqual([]);
  });

  it("getWorkspaceOAuthConnection returns row", async () => {
    const db = mockDb({
      maybeSingle: vi.fn().mockResolvedValue({ data: MOCK, error: null })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const row = await getWorkspaceOAuthConnection("biz-1", "woc-1");
    expect(row?.id).toBe("woc-1");
  });

  it("getWorkspaceOAuthConnection returns null when missing", async () => {
    const db = mockDb({
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(getWorkspaceOAuthConnection("biz-1", "woc-9")).resolves.toBeNull();
  });

  it("getWorkspaceOAuthConnection throws on error", async () => {
    const db = mockDb({
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: "bad" } })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(getWorkspaceOAuthConnection("biz-1", "woc-1")).rejects.toThrow(
      "getWorkspaceOAuthConnection"
    );
  });

  it("getWorkspaceOAuthConnectionByNangoIds returns row", async () => {
    const db = mockDb({
      maybeSingle: vi.fn().mockResolvedValue({ data: MOCK, error: null })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const row = await getWorkspaceOAuthConnectionByNangoIds("biz-1", "gmail", "conn-1");
    expect(row?.connection_id).toBe("conn-1");
  });

  it("getWorkspaceOAuthConnectionByNangoIds returns null when missing", async () => {
    const db = mockDb({
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(
      getWorkspaceOAuthConnectionByNangoIds("biz-1", "gmail", "nope")
    ).resolves.toBeNull();
  });

  it("getWorkspaceOAuthConnectionByNangoIds throws on error", async () => {
    const db = mockDb({
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: "e" } })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(
      getWorkspaceOAuthConnectionByNangoIds("biz-1", "gmail", "conn-1")
    ).rejects.toThrow("getWorkspaceOAuthConnectionByNangoIds");
  });

  it("upsertWorkspaceOAuthConnection upserts", async () => {
    const db = mockDb({
      single: vi.fn().mockResolvedValue({ data: MOCK, error: null })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const row = await upsertWorkspaceOAuthConnection({
      businessId: "biz-1",
      providerConfigKey: "gmail",
      connectionId: "conn-1"
    });
    expect(row.id).toBe("woc-1");
    expect(db.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        business_id: "biz-1",
        provider_config_key: "gmail",
        connection_id: "conn-1"
      }),
      { onConflict: "business_id,provider_config_key,connection_id" }
    );
  });

  it("upsertWorkspaceOAuthConnection throws on error", async () => {
    const db = mockDb({
      single: vi.fn().mockResolvedValue({ data: null, error: { message: "fail" } })
    });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    await expect(
      upsertWorkspaceOAuthConnection({
        businessId: "biz-1",
        providerConfigKey: "gmail",
        connectionId: "conn-1"
      })
    ).rejects.toThrow("upsertWorkspaceOAuthConnection");
  });

  it("updateWorkspaceOAuthConnectionLink re-points a row at a new Nango id", async () => {
    const single = vi.fn().mockResolvedValue({
      data: { ...MOCK, connection_id: "conn-2" },
      error: null
    });
    const select = vi.fn().mockReturnValue({ single });
    const eqId = vi.fn().mockReturnValue({ select });
    const eqBiz = vi.fn().mockReturnValue({ eq: eqId });
    const update = vi.fn().mockReturnValue({ eq: eqBiz });
    const finalDb = { from: vi.fn().mockReturnValue({ update }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(finalDb as never);

    const row = await updateWorkspaceOAuthConnectionLink({
      businessId: "biz-1",
      id: "woc-1",
      connectionId: "conn-2",
      metadata: { provider_account_email: "sam@example.com" }
    });
    expect(row.connection_id).toBe("conn-2");
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        connection_id: "conn-2",
        metadata: { provider_account_email: "sam@example.com" }
      })
    );
    expect(eqBiz).toHaveBeenCalledWith("business_id", "biz-1");
    expect(eqId).toHaveBeenCalledWith("id", "woc-1");
  });

  it("updateWorkspaceOAuthConnectionLink throws on error", async () => {
    const single = vi.fn().mockResolvedValue({ data: null, error: { message: "nope" } });
    const select = vi.fn().mockReturnValue({ single });
    const eqId = vi.fn().mockReturnValue({ select });
    const eqBiz = vi.fn().mockReturnValue({ eq: eqId });
    const update = vi.fn().mockReturnValue({ eq: eqBiz });
    const finalDb = { from: vi.fn().mockReturnValue({ update }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(finalDb as never);

    await expect(
      updateWorkspaceOAuthConnectionLink({
        businessId: "biz-1",
        id: "woc-1",
        connectionId: "conn-2",
        metadata: {}
      })
    ).rejects.toThrow("updateWorkspaceOAuthConnectionLink");
  });

  it("deleteWorkspaceOAuthConnection deletes and returns row", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: MOCK, error: null });
    const select = vi.fn().mockReturnValue({ maybeSingle });
    const eqId = vi.fn().mockReturnValue({ select });
    const eqBiz = vi.fn().mockReturnValue({ eq: eqId });
    const del = vi.fn().mockReturnValue({ eq: eqBiz });
    const finalDb = { from: vi.fn().mockReturnValue({ delete: del }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(finalDb as never);

    const row = await deleteWorkspaceOAuthConnection("biz-1", "woc-1");
    expect(row?.id).toBe("woc-1");
  });

  it("deleteWorkspaceOAuthConnection returns null when no row deleted", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const select = vi.fn().mockReturnValue({ maybeSingle });
    const eqId = vi.fn().mockReturnValue({ select });
    const eqBiz = vi.fn().mockReturnValue({ eq: eqId });
    const del = vi.fn().mockReturnValue({ eq: eqBiz });
    const finalDb = { from: vi.fn().mockReturnValue({ delete: del }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(finalDb as never);

    await expect(deleteWorkspaceOAuthConnection("biz-1", "woc-1")).resolves.toBeNull();
  });

  it("deleteWorkspaceOAuthConnection throws on error", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: { message: "nope" } });
    const select = vi.fn().mockReturnValue({ maybeSingle });
    const eqId = vi.fn().mockReturnValue({ select });
    const eqBiz = vi.fn().mockReturnValue({ eq: eqId });
    const del = vi.fn().mockReturnValue({ eq: eqBiz });
    const finalDb = { from: vi.fn().mockReturnValue({ delete: del }) };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(finalDb as never);

    await expect(deleteWorkspaceOAuthConnection("biz-1", "woc-1")).rejects.toThrow(
      "deleteWorkspaceOAuthConnection"
    );
  });

  it("listWorkspaceOAuthConnections uses injected client", async () => {
    const db = { ...mockDb(), order: vi.fn().mockResolvedValue({ data: [], error: null }) };
    await listWorkspaceOAuthConnections("biz-1", db as never);
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------------ *
 * Direct-transport rows.
 *
 * These are the only functions that touch token ciphertext. The important
 * property, asserted throughout, is that tokens are ENCRYPTED on the way in
 * and DECRYPTED on the way out, and that a row without a complete usable pair
 * reads as "no connection" rather than handing back a half-usable token.
 * ------------------------------------------------------------------------ */
describe("db/workspace-oauth-connections direct rows", () => {
  const ROW_ID = "woc-direct-1";
  const tokens = {
    accessToken: "at-plain",
    refreshToken: "rt-plain",
    expiresAt: new Date("2026-08-11T10:00:00Z"),
    scope: "Mail.Send"
  };

  /** Mirrors what the row looks like once the setters have written it. */
  function storedRow(over: Record<string, unknown> = {}) {
    return {
      id: ROW_ID,
      transport: "direct",
      is_active: true,
      access_token_encrypted: encryptIntegrationSecret("at-plain"),
      refresh_token_encrypted: encryptIntegrationSecret("rt-plain"),
      token_expires_at: "2026-08-11T10:00:00Z",
      updated_at: "2026-08-01T00:00:00Z",
      ...over
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // setup-env.ts strips INTEGRATIONS_ENCRYPTION_KEY so no suite can touch a
    // real credential; these cases need a key to exercise the envelope.
    vi.stubEnv("INTEGRATIONS_ENCRYPTION_KEY", "unit-test-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("getWorkspaceConnectionSecrets", () => {
    it("decrypts the stored pair", async () => {
      const db = {
        ...mockDb(),
        maybeSingle: vi.fn().mockResolvedValue({ data: storedRow(), error: null })
      };
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

      await expect(getWorkspaceConnectionSecrets(ROW_ID)).resolves.toEqual({
        id: ROW_ID,
        accessToken: "at-plain",
        refreshToken: "rt-plain",
        tokenExpiresAt: "2026-08-11T10:00:00Z",
        isActive: true,
        updatedAt: "2026-08-01T00:00:00Z"
      });
    });

    it("returns null for a missing row", async () => {
      const db = {
        ...mockDb(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
      };
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      await expect(getWorkspaceConnectionSecrets(ROW_ID)).resolves.toBeNull();
    });

    it("returns null for a NANGO row, which has no tokens by definition", async () => {
      const db = {
        ...mockDb(),
        maybeSingle: vi
          .fn()
          .mockResolvedValue({ data: storedRow({ transport: "nango" }), error: null })
      };
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      await expect(getWorkspaceConnectionSecrets(ROW_ID)).resolves.toBeNull();
    });

    it.each([
      ["access token", { access_token_encrypted: null }],
      ["refresh token", { refresh_token_encrypted: null }],
      ["expiry", { token_expires_at: null }]
    ])("returns null when the %s is missing", async (_label, over) => {
      // Never hand back a partial pair: an empty bearer is worse than no
      // connection, because it looks like a provider rejection.
      const db = {
        ...mockDb(),
        maybeSingle: vi.fn().mockResolvedValue({ data: storedRow(over), error: null })
      };
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      await expect(getWorkspaceConnectionSecrets(ROW_ID)).resolves.toBeNull();
    });

    it("reports an inactive row without hiding it, so the caller decides", async () => {
      const db = {
        ...mockDb(),
        maybeSingle: vi.fn().mockResolvedValue({ data: storedRow({ is_active: false }), error: null })
      };
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      const row = await getWorkspaceConnectionSecrets(ROW_ID);
      expect(row?.isActive).toBe(false);
    });

    it("throws on a query error", async () => {
      const db = {
        ...mockDb(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } })
      };
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      await expect(getWorkspaceConnectionSecrets(ROW_ID)).rejects.toThrow("boom");
    });
  });

  describe("updateWorkspaceConnectionTokens", () => {
    it("encrypts both tokens and fences on updated_at", async () => {
      const match = vi.fn().mockReturnThis();
      const db = {
        ...mockDb(),
        update: vi.fn().mockReturnThis(),
        match,
        select: vi.fn().mockResolvedValue({ data: [{ id: ROW_ID }], error: null })
      };
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

      await expect(
        updateWorkspaceConnectionTokens(ROW_ID, tokens, "2026-08-01T00:00:00Z")
      ).resolves.toBe(true);

      const written = db.update.mock.calls[0][0] as Record<string, string>;
      // Ciphertext, not the plain token.
      expect(written.access_token_encrypted).toMatch(/^enc:v1:/);
      expect(written.refresh_token_encrypted).toMatch(/^enc:v1:/);
      expect(decryptIntegrationSecret(written.access_token_encrypted)).toBe("at-plain");
      expect(decryptIntegrationSecret(written.refresh_token_encrypted)).toBe("rt-plain");
      expect(written.oauth_scope).toBe("Mail.Send");
      expect(match).toHaveBeenCalledWith({ id: ROW_ID, updated_at: "2026-08-01T00:00:00Z" });
    });

    it("omits the fence when no expected timestamp is given", async () => {
      const match = vi.fn().mockReturnThis();
      const db = {
        ...mockDb(),
        update: vi.fn().mockReturnThis(),
        match,
        select: vi.fn().mockResolvedValue({ data: [{ id: ROW_ID }], error: null })
      };
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

      await updateWorkspaceConnectionTokens(ROW_ID, tokens);
      expect(match).toHaveBeenCalledWith({ id: ROW_ID });
    });

    it("returns false when the fence matched nothing (someone else rotated first)", async () => {
      const db = {
        ...mockDb(),
        update: vi.fn().mockReturnThis(),
        match: vi.fn().mockReturnThis(),
        select: vi.fn().mockResolvedValue({ data: [], error: null })
      };
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      await expect(updateWorkspaceConnectionTokens(ROW_ID, tokens, "stale")).resolves.toBe(false);
    });

    it("returns false when the driver reports no rows at all", async () => {
      const db = {
        ...mockDb(),
        update: vi.fn().mockReturnThis(),
        match: vi.fn().mockReturnThis(),
        select: vi.fn().mockResolvedValue({ data: null, error: null })
      };
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      await expect(updateWorkspaceConnectionTokens(ROW_ID, tokens)).resolves.toBe(false);
    });

    it("throws on a query error", async () => {
      const db = {
        ...mockDb(),
        update: vi.fn().mockReturnThis(),
        match: vi.fn().mockReturnThis(),
        select: vi.fn().mockResolvedValue({ data: null, error: { message: "nope" } })
      };
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      await expect(updateWorkspaceConnectionTokens(ROW_ID, tokens)).rejects.toThrow("nope");
    });
  });

  describe("setWorkspaceConnectionActive", () => {
    it("flips the flag", async () => {
      const db = {
        ...mockDb(),
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({ error: null })
      };
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

      await setWorkspaceConnectionActive(ROW_ID, false);
      expect((db.update.mock.calls[0][0] as { is_active: boolean }).is_active).toBe(false);
    });

    it("throws on a query error", async () => {
      const db = {
        ...mockDb(),
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({ error: { message: "bad" } })
      };
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      await expect(setWorkspaceConnectionActive(ROW_ID, true)).rejects.toThrow("bad");
    });
  });

  describe("insertDirectWorkspaceConnection", () => {
    const input = {
      businessId: "biz-1",
      providerConfigKey: "outlook",
      connectionId: "direct:abc",
      metadata: { provider_account_email: "sam@acme.com" },
      tokens
    };

    it("writes a direct, active row with encrypted tokens", async () => {
      const db = {
        ...mockDb(),
        insert: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: MOCK, error: null })
      };
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

      await insertDirectWorkspaceConnection(input);

      const written = db.insert.mock.calls[0][0] as Record<string, unknown>;
      expect(written.transport).toBe("direct");
      expect(written.is_active).toBe(true);
      expect(decryptIntegrationSecret(written.access_token_encrypted as string)).toBe("at-plain");
    });

    it("throws on a query error", async () => {
      const db = {
        ...mockDb(),
        insert: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: null, error: { message: "dup" } })
      };
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      await expect(insertDirectWorkspaceConnection(input)).rejects.toThrow("dup");
    });
  });

  describe("flipWorkspaceConnectionToDirect", () => {
    const args = {
      id: ROW_ID,
      businessId: "biz-1",
      connectionId: "direct:new",
      metadata: { shared_calendar_id: "cal-1", provider_account_email: "sam@acme.com" },
      tokens
    };

    it("converts a row to direct IN PLACE, keeping its id", async () => {
      // The row id is what AiFlow mailbox bindings reference, so a reconnect
      // must never mint a new one.
      const db = {
        ...mockDb(),
        update: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: MOCK, error: null })
      };
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

      await flipWorkspaceConnectionToDirect(args);

      const written = db.update.mock.calls[0][0] as Record<string, unknown>;
      expect(written.transport).toBe("direct");
      expect(written.is_active).toBe(true);
      expect(written.connection_id).toBe("direct:new");
      // App-owned metadata the caller merged in survives the flip.
      expect(written.metadata).toEqual(args.metadata);
      expect(db.eq).toHaveBeenCalledWith("id", ROW_ID);
      expect(db.eq).toHaveBeenCalledWith("business_id", "biz-1");
    });

    it("throws on a query error", async () => {
      const db = {
        ...mockDb(),
        update: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: null, error: { message: "gone" } })
      };
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      await expect(flipWorkspaceConnectionToDirect(args)).rejects.toThrow("gone");
    });
  });
});

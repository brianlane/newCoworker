/**
 * calendly_webhook_subscriptions DB layer
 * (src/lib/db/calendly-webhook-subscriptions.ts): decrypt-on-read, upsert
 * shape (encrypted signing key, attempt stamping), delete, and error
 * surfacing.
 */
import { describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));
// Deterministic envelope so assertions don't depend on env keys.
vi.mock("@/lib/integrations/secrets", () => ({
  encryptIntegrationSecret: vi.fn((v: string | null | undefined) =>
    v ? `enc(${v})` : null
  ),
  decryptIntegrationSecret: vi.fn((v: string | null | undefined) => {
    if (!v) return null;
    const m = /^enc\((.*)\)$/.exec(v);
    return m ? m[1] : v;
  })
}));

import {
  deleteCalendlyWebhookSubscription,
  getCalendlyWebhookSubscription,
  listCalendlyWebhookSubscriptions,
  upsertCalendlyWebhookSubscription
} from "@/lib/db/calendly-webhook-subscriptions";

function chain(): Record<string, ReturnType<typeof vi.fn>> {
  const c: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const m of ["select", "upsert", "delete", "eq"]) c[m] = vi.fn(() => c);
  c.maybeSingle = vi.fn();
  return c;
}

function makeDb(c: unknown) {
  return { from: vi.fn(() => c) } as never;
}

const CONN = "cccccccc-1111-4111-8111-111111111111";
const BIZ = "11111111-1111-4111-8111-111111111111";

const STORED = {
  id: "cws-1",
  business_id: BIZ,
  status: "active",
  subscription_uri: "https://api.calendly.com/webhook_subscriptions/WH1",
  signing_key_encrypted: "enc(sk-secret)",
  user_uri: "https://api.calendly.com/users/U1",
  connection_key: "calendly-direct:cx-1",
  last_attempt_at: "2026-07-18T00:00:00Z"
};

describe("getCalendlyWebhookSubscription", () => {
  it("returns null when no row exists", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getCalendlyWebhookSubscription(BIZ, CONN, makeDb(c))).toBeNull();
  });

  it("decrypts the stored signing key (null for non-active rows)", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: STORED, error: null });
    const row = await getCalendlyWebhookSubscription(BIZ, CONN, makeDb(c));
    expect(row).toMatchObject({ status: "active", signingKey: "sk-secret" });
    expect(row).not.toHaveProperty("signing_key_encrypted");

    const c2 = chain();
    c2.maybeSingle.mockResolvedValue({
      data: { ...STORED, status: "unsupported", signing_key_encrypted: null },
      error: null
    });
    expect((await getCalendlyWebhookSubscription(BIZ, CONN, makeDb(c2)))?.signingKey).toBeNull();
  });

  it("throws on a read error and uses the default client when none injected", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: { message: "read down" } });
    defaultClientSpy.mockReturnValue(makeDb(c));
    await expect(getCalendlyWebhookSubscription(BIZ, CONN)).rejects.toThrow(
      "getCalendlyWebhookSubscription: read down"
    );
  });
});

describe("listCalendlyWebhookSubscriptions", () => {
  it("lists the business's rows (decrypted), bounded and oldest-attempt-first", async () => {
    const c = chain();
    // then-able terminal for the list chain
    (c as Record<string, unknown>).order = vi.fn(() => c);
    (c as Record<string, unknown>).limit = vi.fn(() =>
      Promise.resolve({ data: [STORED], error: null })
    );
    const rows = await listCalendlyWebhookSubscriptions(BIZ, makeDb(c));
    expect(rows).toHaveLength(1);
    expect(rows[0].signingKey).toBe("sk-secret");
    expect((c as { order: ReturnType<typeof vi.fn> }).order).toHaveBeenCalledWith(
      "last_attempt_at",
      { ascending: true }
    );
  });

  it("throws on a read error (default client) and coalesces empty data", async () => {
    const cErr = chain();
    (cErr as Record<string, unknown>).order = vi.fn(() => cErr);
    (cErr as Record<string, unknown>).limit = vi.fn(() =>
      Promise.resolve({ data: null, error: { message: "read down" } })
    );
    defaultClientSpy.mockReturnValue(makeDb(cErr));
    await expect(listCalendlyWebhookSubscriptions(BIZ)).rejects.toThrow(
      "listCalendlyWebhookSubscriptions: read down"
    );
    const cEmpty = chain();
    (cEmpty as Record<string, unknown>).order = vi.fn(() => cEmpty);
    (cEmpty as Record<string, unknown>).limit = vi.fn(() =>
      Promise.resolve({ data: null, error: null })
    );
    expect(await listCalendlyWebhookSubscriptions(BIZ, makeDb(cEmpty))).toEqual([]);
  });
});

describe("upsertCalendlyWebhookSubscription", () => {
  it("stores the encrypted signing key on the CONNECTION conflict target", async () => {
    const c = chain();
    c.upsert.mockResolvedValue({ error: null });
    await upsertCalendlyWebhookSubscription(
      {
        businessId: BIZ,
        connectionId: CONN,
        status: "active",
        subscriptionUri: "https://api.calendly.com/webhook_subscriptions/WH1",
        signingKey: "sk-secret",
        userUri: "https://api.calendly.com/users/U1",
        connectionKey: "calendly-direct:cx-1"
      },
      makeDb(c)
    );
    expect(c.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        business_id: BIZ,
        connection_id: CONN,
        status: "active",
        subscription_uri: "https://api.calendly.com/webhook_subscriptions/WH1",
        signing_key_encrypted: "enc(sk-secret)",
        user_uri: "https://api.calendly.com/users/U1",
        connection_key: "calendly-direct:cx-1",
        last_attempt_at: expect.any(String)
      }),
      { onConflict: "connection_id" }
    );
  });

  it("clears uri/key for non-active statuses and throws on write errors", async () => {
    const c = chain();
    c.upsert.mockResolvedValue({ error: null });
    await upsertCalendlyWebhookSubscription(
      { businessId: BIZ, connectionId: CONN, status: "unsupported" },
      makeDb(c)
    );
    expect(c.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "unsupported",
        subscription_uri: null,
        signing_key_encrypted: null,
        user_uri: null,
        connection_key: null
      }),
      { onConflict: "connection_id" }
    );

    const cErr = chain();
    cErr.upsert.mockResolvedValue({ error: { message: "write down" } });
    defaultClientSpy.mockReturnValue(makeDb(cErr));
    await expect(
      upsertCalendlyWebhookSubscription({ businessId: BIZ, connectionId: CONN, status: "error" })
    ).rejects.toThrow("upsertCalendlyWebhookSubscription: write down");
  });
});

describe("deleteCalendlyWebhookSubscription", () => {
  it("deletes ONE connection's row", async () => {
    const c = chain();
    c.eq.mockReturnValueOnce(c as never).mockResolvedValue({ error: null } as never);
    await deleteCalendlyWebhookSubscription(BIZ, CONN, makeDb(c));
    expect(c.delete).toHaveBeenCalled();
    expect(c.eq).toHaveBeenCalledWith("business_id", BIZ);
    expect(c.eq).toHaveBeenCalledWith("connection_id", CONN);
  });

  it("throws on a delete error (default client)", async () => {
    const c = chain();
    c.eq.mockReturnValueOnce(c as never).mockResolvedValue({
      error: { message: "delete down" }
    } as never);
    defaultClientSpy.mockReturnValue(makeDb(c));
    await expect(deleteCalendlyWebhookSubscription(BIZ, CONN)).rejects.toThrow(
      "deleteCalendlyWebhookSubscription: delete down"
    );
  });
});

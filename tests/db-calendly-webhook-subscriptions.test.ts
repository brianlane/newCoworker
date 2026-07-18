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

const BIZ = "11111111-1111-4111-8111-111111111111";

const STORED = {
  id: "cws-1",
  business_id: BIZ,
  status: "active",
  subscription_uri: "https://api.calendly.com/webhook_subscriptions/WH1",
  signing_key_encrypted: "enc(sk-secret)",
  last_attempt_at: "2026-07-18T00:00:00Z"
};

describe("getCalendlyWebhookSubscription", () => {
  it("returns null when no row exists", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getCalendlyWebhookSubscription(BIZ, makeDb(c))).toBeNull();
  });

  it("decrypts the stored signing key (null for non-active rows)", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: STORED, error: null });
    const row = await getCalendlyWebhookSubscription(BIZ, makeDb(c));
    expect(row).toMatchObject({ status: "active", signingKey: "sk-secret" });
    expect(row).not.toHaveProperty("signing_key_encrypted");

    const c2 = chain();
    c2.maybeSingle.mockResolvedValue({
      data: { ...STORED, status: "unsupported", signing_key_encrypted: null },
      error: null
    });
    expect((await getCalendlyWebhookSubscription(BIZ, makeDb(c2)))?.signingKey).toBeNull();
  });

  it("throws on a read error and uses the default client when none injected", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: { message: "read down" } });
    defaultClientSpy.mockReturnValue(makeDb(c));
    await expect(getCalendlyWebhookSubscription(BIZ)).rejects.toThrow(
      "getCalendlyWebhookSubscription: read down"
    );
  });
});

describe("upsertCalendlyWebhookSubscription", () => {
  it("stores the encrypted signing key on the business conflict target", async () => {
    const c = chain();
    c.upsert.mockResolvedValue({ error: null });
    await upsertCalendlyWebhookSubscription(
      {
        businessId: BIZ,
        status: "active",
        subscriptionUri: "https://api.calendly.com/webhook_subscriptions/WH1",
        signingKey: "sk-secret"
      },
      makeDb(c)
    );
    expect(c.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        business_id: BIZ,
        status: "active",
        subscription_uri: "https://api.calendly.com/webhook_subscriptions/WH1",
        signing_key_encrypted: "enc(sk-secret)",
        last_attempt_at: expect.any(String)
      }),
      { onConflict: "business_id" }
    );
  });

  it("clears uri/key for non-active statuses and throws on write errors", async () => {
    const c = chain();
    c.upsert.mockResolvedValue({ error: null });
    await upsertCalendlyWebhookSubscription({ businessId: BIZ, status: "unsupported" }, makeDb(c));
    expect(c.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "unsupported",
        subscription_uri: null,
        signing_key_encrypted: null
      }),
      { onConflict: "business_id" }
    );

    const cErr = chain();
    cErr.upsert.mockResolvedValue({ error: { message: "write down" } });
    defaultClientSpy.mockReturnValue(makeDb(cErr));
    await expect(
      upsertCalendlyWebhookSubscription({ businessId: BIZ, status: "error" })
    ).rejects.toThrow("upsertCalendlyWebhookSubscription: write down");
  });
});

describe("deleteCalendlyWebhookSubscription", () => {
  it("deletes by business id", async () => {
    const c = chain();
    c.eq.mockResolvedValue({ error: null });
    await deleteCalendlyWebhookSubscription(BIZ, makeDb(c));
    expect(c.delete).toHaveBeenCalled();
    expect(c.eq).toHaveBeenCalledWith("business_id", BIZ);
  });

  it("throws on a delete error (default client)", async () => {
    const c = chain();
    c.eq.mockResolvedValue({ error: { message: "delete down" } });
    defaultClientSpy.mockReturnValue(makeDb(c));
    await expect(deleteCalendlyWebhookSubscription(BIZ)).rejects.toThrow(
      "deleteCalendlyWebhookSubscription: delete down"
    );
  });
});

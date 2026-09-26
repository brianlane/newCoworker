import { describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));
vi.mock("@/lib/integrations/secrets", () => ({
  encryptIntegrationSecret: vi.fn((v: string | null | undefined) => (v ? `enc(${v})` : null)),
  decryptIntegrationSecret: vi.fn((v: string | null | undefined) => {
    if (!v) return null;
    const m = /^enc\((.*)\)$/.exec(v);
    return m ? m[1] : null;
  })
}));

import {
  deactivateCalConnection,
  getActiveCalConnectionId,
  getCalConnectionByBusiness,
  getCalConnectionById,
  getPublicCalConnection,
  markCalHealthy,
  newCalWebhookToken,
  setCalDefaultEventType,
  setCalWebhook,
  toPublicCalConnection,
  updateCalTokens,
  upsertCalConnection
} from "@/lib/db/cal-connections";

type Chain = {
  select: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
};

function chain(terminal?: unknown): Chain {
  const c = {
    select: vi.fn(() => c),
    upsert: vi.fn(() => c),
    update: vi.fn(() => c),
    eq: vi.fn(() => c),
    single: vi.fn(async () => terminal),
    maybeSingle: vi.fn(async () => terminal),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(terminal).then(resolve)
  };
  return c as never;
}

function makeDb(c: unknown) {
  return { from: vi.fn(() => c) } as never;
}

const BIZ = "11111111-1111-4111-8111-111111111111";
const STORED = {
  id: "cal-1",
  business_id: BIZ,
  access_token_encrypted: "enc(access)",
  refresh_token_encrypted: "enc(refresh)",
  token_expires_at: "2026-09-26T16:00:00.000Z",
  cal_user_id: "9",
  account_email: "a@b.co",
  account_name: "Ada",
  username: "ada",
  time_zone: "America/New_York",
  default_event_type_id: null,
  webhook_id: null,
  webhook_secret_encrypted: "enc(whsec)",
  webhook_verification_token: "tok",
  is_active: true,
  needs_reauth: false,
  last_healthy_at: null,
  reauth_email_count: 0,
  reauth_email_last_sent_at: null,
  created_at: "2026-09-26T00:00:00.000Z",
  updated_at: "2026-09-26T00:00:00.000Z"
};

describe("cal connection store", () => {
  it("mints a webhook token and hides ciphertext on the public row", () => {
    expect(newCalWebhookToken()).toMatch(/^[0-9a-f]{48}$/);
    const pub = toPublicCalConnection(STORED);
    expect(pub.has_tokens).toBe(true);
    expect(pub).not.toHaveProperty("access_token_encrypted");
    expect(toPublicCalConnection({ ...STORED, access_token_encrypted: "" }).has_tokens).toBe(false);
  });

  it("upserts and reads a decrypted row", async () => {
    const c = chain({ data: STORED, error: null });
    const row = await upsertCalConnection(
      {
        businessId: BIZ,
        tokens: { accessToken: "access", refreshToken: "refresh", expiresAt: new Date("2026-09-26T16:00:00.000Z") },
        profile: { id: "9", email: "a@b.co", name: "Ada", username: "ada", timeZone: "America/New_York" },
        defaultEventTypeId: null,
        webhookToken: "tok"
      },
      makeDb(c)
    );
    expect(row.accessToken).toBe("access");
    expect(row.webhookSecret).toBe("whsec");
    await expect(getCalConnectionById("cal-1", makeDb(chain({ data: STORED, error: null })))).resolves.toMatchObject({
      id: "cal-1"
    });
    await expect(getCalConnectionById("missing", makeDb(chain({ data: null, error: null })))).resolves.toBeNull();
    await expect(getCalConnectionByBusiness(BIZ, makeDb(chain({ data: null, error: null })))).resolves.toBeNull();
    await expect(getActiveCalConnectionId(BIZ, makeDb(chain({ data: { id: "cal-1" }, error: null })))).resolves.toBe("cal-1");
    await expect(getActiveCalConnectionId(BIZ, makeDb(chain({ data: null, error: null })))).resolves.toBeNull();
    await expect(getPublicCalConnection(BIZ, makeDb(chain({ data: STORED, error: null })))).resolves.toMatchObject({
      has_tokens: true
    });
    await expect(getPublicCalConnection(BIZ, makeDb(chain({ data: null, error: null })))).resolves.toBeNull();
  });

  it("fails closed on a bad token envelope and on query errors", async () => {
    await expect(
      getCalConnectionById("cal-1", makeDb(chain({ data: { ...STORED, access_token_encrypted: "garbage" }, error: null })))
    ).rejects.toThrow(/no stored token pair/);
    await expect(getCalConnectionById("cal-1", makeDb(chain({ data: null, error: { message: "boom" } })))).rejects.toThrow(
      /getCalConnectionById: boom/
    );
    await expect(getCalConnectionByBusiness(BIZ, makeDb(chain({ data: null, error: { message: "boom" } })))).rejects.toThrow(
      /getCalConnectionByBusiness/
    );
    await expect(getActiveCalConnectionId(BIZ, makeDb(chain({ data: null, error: { message: "boom" } })))).rejects.toThrow(
      /getActiveCalConnectionId/
    );
    await expect(getPublicCalConnection(BIZ, makeDb(chain({ data: null, error: { message: "boom" } })))).rejects.toThrow(
      /getPublicCalConnection/
    );
    const badUpsert = chain({ data: null, error: { message: "nope" } });
    await expect(
      upsertCalConnection(
        {
          businessId: BIZ,
          tokens: { accessToken: "a", refreshToken: "r", expiresAt: new Date() },
          profile: { id: null, email: null, name: null, username: null, timeZone: null },
          defaultEventTypeId: null,
          webhookToken: "tok"
        },
        makeDb(badUpsert)
      )
    ).rejects.toThrow(/upsertCalConnection/);
  });

  it("updates tokens, health, webhook, default type, and active flag", async () => {
    const ok = chain({ error: null });
    await updateCalTokens("cal-1", { accessToken: "a", refreshToken: "r", expiresAt: new Date() }, makeDb(ok));
    await markCalHealthy("cal-1", makeDb(chain({ error: null })));
    await setCalWebhook("cal-1", "wh_1", "secret", makeDb(chain({ error: null })));
    await setCalDefaultEventType("cal-1", "42", makeDb(chain({ error: null })));
    await deactivateCalConnection(BIZ, makeDb(chain({ error: null })));
    await expect(markCalHealthy("cal-1", makeDb(chain({ error: { message: "x" } })))).rejects.toThrow(/markCalHealthy/);
    await expect(
      updateCalTokens("cal-1", { accessToken: "a", refreshToken: "r", expiresAt: new Date() }, makeDb(chain({ error: { message: "x" } })))
    ).rejects.toThrow(/updateCalTokens/);
    await expect(setCalWebhook("cal-1", "wh", "s", makeDb(chain({ error: { message: "x" } })))).rejects.toThrow(/setCalWebhook/);
    await expect(setCalDefaultEventType("cal-1", null, makeDb(chain({ error: { message: "x" } })))).rejects.toThrow(
      /setCalDefaultEventType/
    );
    await expect(deactivateCalConnection(BIZ, makeDb(chain({ error: { message: "x" } })))).rejects.toThrow(
      /deactivateCalConnection/
    );
  });

  it("uses the service client when none is passed", async () => {
    defaultClientSpy.mockResolvedValue(makeDb(chain({ data: null, error: null })));
    await expect(getActiveCalConnectionId(BIZ)).resolves.toBeNull();
  });
});

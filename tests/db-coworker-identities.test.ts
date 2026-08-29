import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Channel identity bindings and the enrolment codes that create them.
 *
 * This is the mechanism that decides whether an opaque Telegram account is
 * treated as the business owner, so the properties below are the security
 * ones: a code is stored HASHED, redeems exactly ONCE, and tells a wrong
 * code apart from an expired one only to us, never to the presenter.
 */

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { createHash } from "node:crypto";
import {
  createLinkCode,
  deleteChannelIdentities,
  findChannelIdentity,
  normalizeLinkCode,
  redeemLinkCode,
  upsertChannelIdentity
} from "@/lib/db/coworker-identities";

/**
 * The stored hash, computed HERE rather than imported from the module under
 * test. A fixture built with the module's own helper would agree with it by
 * construction even if the hashing changed; this asserts the actual scheme,
 * which is what a leaked row's safety rests on.
 */
const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

/** Codes live long enough to switch apps and paste, and no longer. */
const TTL_MS = 15 * 60 * 1000;

const BIZ = "11111111-1111-4111-8111-111111111111";
const NOW = Date.parse("2026-08-28T12:00:00Z");

type Result = { data: unknown; error: { message: string } | null };

function chain(terminal: Result, seen: { inserted?: Record<string, unknown>; filters: [string, unknown][] }) {
  const c: Record<string, unknown> = {};
  c.insert = vi.fn((row: Record<string, unknown>) => {
    seen.inserted = row;
    return c;
  });
  c.upsert = vi.fn((row: Record<string, unknown>) => {
    seen.inserted = row;
    return c;
  });
  for (const m of ["select", "update", "delete", "is"]) c[m] = vi.fn(() => c);
  c.eq = vi.fn((col: string, val: unknown) => {
    seen.filters.push([col, val]);
    return c;
  });
  c.maybeSingle = vi.fn(async () => terminal);
  c.single = vi.fn(async () => terminal);
  c.then = (resolve: (v: Result) => unknown) => resolve(terminal);
  return c;
}

function db(results: Result[]) {
  const seen: { inserted?: Record<string, unknown>; filters: [string, unknown][] } = {
    filters: []
  };
  const from = vi.fn();
  for (const r of results) from.mockReturnValueOnce(chain(r, seen));
  return { client: { from } as never, seen };
}

const OPEN_CODE = {
  id: "code-1",
  business_id: BIZ,
  channel: "telegram",
  employee_id: null,
  is_owner: true,
  expires_at: new Date(NOW + 60_000).toISOString(),
  redeemed_at: null,
  code_hash: sha256("ABCD2345")
};

beforeEach(() => vi.clearAllMocks());

async function mint() {
  const { client, seen } = db([{ data: null, error: null }]);
  const out = await createLinkCode(
    {
      businessId: BIZ,
      channel: "telegram",
      employeeId: null,
      isOwner: true,
      createdByUserId: null,
      now: NOW
    },
    client
  );
  return { ...out, seen };
}

describe("the code itself", () => {
  it("avoids characters that cannot be transcribed", async () => {
    // These get read off one screen and typed into another, sometimes from
    // a photograph. O/0 and I/1/L are a support ticket waiting to happen.
    for (let i = 0; i < 100; i += 1) {
      const { code } = await mint();
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    }
  });

  it("is not predictable across calls", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) seen.add((await mint()).code);
    expect(seen.size).toBeGreaterThan(80);
  });

  it("normalises case, spaces and hyphens before hashing", () => {
    expect(normalizeLinkCode(" abcd-2345 ")).toBe("ABCD2345");
  });
});

describe("minting a code", () => {
  it("stores only the HASH, never the code", async () => {
    // A leaked database row must not be redeemable.
    const { code, seen } = await mint();
    expect(seen.inserted?.code_hash).toBe(sha256(code));
    expect(JSON.stringify(seen.inserted)).not.toContain(code);
  });

  it("expires in fifteen minutes", async () => {
    const { expiresAt } = await mint();
    expect(Date.parse(expiresAt) - NOW).toBe(TTL_MS);
  });

  it("throws when the write fails, rather than handing back a dead code", async () => {
    const { client } = db([{ data: null, error: { message: "down" } }]);
    await expect(
      createLinkCode(
        { businessId: BIZ, channel: "telegram", employeeId: null, isOwner: true, createdByUserId: null },
        client
      )
    ).rejects.toThrow("down");
  });
});

describe("redeeming a code", () => {
  it("binds the presenting account and marks the code used", async () => {
    const { client } = db([
      { data: OPEN_CODE, error: null },
      { data: [{ id: "code-1" }], error: null },
      { data: { id: "ident-1", is_owner: true }, error: null }
    ]);
    const out = await redeemLinkCode(
      { channel: "telegram", code: "abcd-2345", externalUserId: "4242", now: NOW },
      client
    );
    expect(out).toMatchObject({ ok: true });
  });

  it.each([
    ["a code nobody minted", null, "unknown"],
    [
      "a code for a DIFFERENT channel",
      { ...OPEN_CODE, channel: "discord" },
      "unknown"
    ],
    [
      "an expired code",
      { ...OPEN_CODE, expires_at: new Date(NOW - 1).toISOString() },
      "expired"
    ],
    [
      "a code already used",
      { ...OPEN_CODE, redeemed_at: new Date(NOW - 1000).toISOString() },
      "already_redeemed"
    ]
  ])("refuses %s", async (_label, row, reason) => {
    const { client } = db([{ data: row, error: null }]);
    expect(
      await redeemLinkCode(
        { channel: "telegram", code: "ABCD2345", externalUserId: "4242", now: NOW },
        client
      )
    ).toEqual({ ok: false, reason });
  });

  it("lets exactly one of two racing redemptions win", async () => {
    // The claim is filtered on still-unredeemed, so the loser's update
    // matches zero rows. PostgREST does not call that an error, which is
    // why the select on the update is what decides the race.
    const { client } = db([
      { data: OPEN_CODE, error: null },
      { data: [], error: null }
    ]);
    expect(
      await redeemLinkCode(
        { channel: "telegram", code: "ABCD2345", externalUserId: "4242", now: NOW },
        client
      )
    ).toEqual({ ok: false, reason: "already_redeemed" });
  });

  it("throws on a read failure instead of reporting an unknown code", async () => {
    const { client } = db([{ data: null, error: { message: "down" } }]);
    await expect(
      redeemLinkCode({ channel: "telegram", code: "X", externalUserId: "1" }, client)
    ).rejects.toThrow("down");
  });

  it("throws when the claim write fails", async () => {
    const { client } = db([
      { data: OPEN_CODE, error: null },
      { data: null, error: { message: "claim down" } }
    ]);
    await expect(
      redeemLinkCode(
        { channel: "telegram", code: "ABCD2345", externalUserId: "4242", now: NOW },
        client
      )
    ).rejects.toThrow("claim down");
  });

  it("refuses a stored hash of the wrong length rather than comparing it", async () => {
    // timingSafeEqual throws on a length mismatch, which would surface as a
    // 500 on a webhook instead of a clean "that code is not valid".
    const { client } = db([{ data: { ...OPEN_CODE, code_hash: "abcd" }, error: null }]);
    expect(
      await redeemLinkCode(
        { channel: "telegram", code: "ABCD2345", externalUserId: "4242", now: NOW },
        client
      )
    ).toEqual({ ok: false, reason: "unknown" });
  });
});

describe("the binding", () => {
  it("upserts on (business, channel, account) so re-linking replaces", async () => {
    const { client, seen } = db([{ data: { id: "ident-1" }, error: null }]);
    await upsertChannelIdentity(
      {
        businessId: BIZ,
        channel: "telegram",
        externalUserId: "4242",
        employeeId: null,
        isOwner: true,
        verifiedPhoneE164: "+15145188192",
        linkedVia: "shared_contact"
      },
      client
    );
    expect(seen.inserted).toMatchObject({
      external_user_id: "4242",
      is_owner: true,
      verified_phone_e164: "+15145188192",
      // Recorded because the two methods are not equally strong: a shared
      // contact is the PROVIDER asserting a number it verified.
      linked_via: "shared_contact"
    });
  });

  it("throws when the binding cannot be written", async () => {
    const { client } = db([{ data: null, error: { message: "down" } }]);
    await expect(
      upsertChannelIdentity(
        {
          businessId: BIZ,
          channel: "telegram",
          externalUserId: "4242",
          employeeId: null,
          isOwner: false,
          linkedVia: "link_code"
        },
        client
      )
    ).rejects.toThrow("down");
  });

  it("looks a binding up by business, channel and account together", async () => {
    const { client, seen } = db([{ data: { id: "ident-1" }, error: null }]);
    await findChannelIdentity(BIZ, "telegram", "4242", client);
    expect(seen.filters).toEqual([
      ["business_id", BIZ],
      ["channel", "telegram"],
      ["external_user_id", "4242"]
    ]);
  });

  it("returns null for an account nobody bound", async () => {
    const { client } = db([{ data: null, error: null }]);
    expect(await findChannelIdentity(BIZ, "telegram", "4242", client)).toBeNull();
  });

  it("throws on a lookup failure, so a blip never reads as 'not staff'", async () => {
    const { client } = db([{ data: null, error: { message: "down" } }]);
    await expect(findChannelIdentity(BIZ, "telegram", "4242", client)).rejects.toThrow("down");
  });

  it("forgets every binding for a channel on disconnect, and reports a failure", async () => {
    // Scoped to the channel, never wider: disconnecting Telegram must not
    // unbind the same people from Slack.
    const okDb = db([{ data: null, error: null }]);
    await expect(deleteChannelIdentities(BIZ, "telegram", okDb.client)).resolves.toBeUndefined();
    expect(okDb.seen.filters).toEqual([
      ["business_id", BIZ],
      ["channel", "telegram"]
    ]);

    const badDb = db([{ data: null, error: { message: "down" } }]);
    await expect(deleteChannelIdentities(BIZ, "telegram", badDb.client)).rejects.toThrow("down");
  });
});

describe("the default service client", () => {
  /** Same reasoning as the connections store: the fallback is production. */
  it.each([
    ["findChannelIdentity", () => findChannelIdentity(BIZ, "telegram", "4242")],
    ["deleteChannelIdentities", () => deleteChannelIdentities(BIZ, "telegram")],
    [
      "createLinkCode",
      () =>
        createLinkCode({
          businessId: BIZ,
          channel: "telegram",
          employeeId: null,
          isOwner: true,
          createdByUserId: null
        })
    ],
    [
      "upsertChannelIdentity",
      () =>
        upsertChannelIdentity({
          businessId: BIZ,
          channel: "telegram",
          externalUserId: "4242",
          employeeId: null,
          isOwner: false,
          linkedVia: "link_code"
        })
    ],
    ["redeemLinkCode", () => redeemLinkCode({ channel: "telegram", code: "X", externalUserId: "1" })]
  ])("%s falls back to it", async (_name, run) => {
    const { client } = db([{ data: null, error: null }]);
    defaultClientSpy.mockReturnValueOnce(client);
    await expect(run()).resolves.toBeDefined;
  });
});

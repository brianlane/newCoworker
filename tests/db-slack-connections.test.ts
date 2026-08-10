/**
 * Tests for the Slack connection store (src/lib/db/slack-connections.ts).
 *
 * The properties that matter are security ones: the bot token never reaches
 * the dashboard shape, a wiped token (Slack-side uninstall) survives as a
 * "needs reconnect" row instead of decrypting to garbage, an undecryptable
 * stored value fails closed, and a workspace already claimed by another
 * business surfaces as a typed error instead of a raw unique-index message.
 */
import { describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));
// Deterministic envelope so assertions don't depend on env keys. A stored
// value of "enc(UNDECRYPTABLE)" decrypts to null to exercise fail-closed.
vi.mock("@/lib/integrations/secrets", () => ({
  encryptIntegrationSecret: vi.fn((v: string | null | undefined) => (v ? `enc(${v})` : null)),
  decryptIntegrationSecret: vi.fn((v: string | null | undefined) => {
    if (!v) return null;
    const m = /^enc\((.*)\)$/.exec(v);
    if (!m) return v;
    return m[1] === "UNDECRYPTABLE" ? null : m[1];
  })
}));

import {
  deleteSlackConnection,
  getActiveSlackConnection,
  getPublicSlackConnection,
  getSlackConnection,
  getSlackConnectionByTeamId,
  markSlackConnectionDeauthorizedByTeamId,
  setSlackAlertChannel,
  setSlackConnectionActive,
  SlackWorkspaceAlreadyLinkedError,
  toPublicSlackConnection,
  upsertSlackConnection
} from "@/lib/db/slack-connections";

const BIZ = "11111111-1111-4111-8111-111111111111";

const STORED = {
  id: "sc-1",
  business_id: BIZ,
  team_id: "T-1",
  team_name: "Acme",
  enterprise_id: null,
  bot_user_id: "U-BOT",
  app_id: "A-1",
  bot_token_encrypted: "enc(xoxb-token)",
  scopes: "chat:write,im:history",
  alert_channel_id: null,
  alert_channel_name: null,
  is_active: true,
  installed_by_user_id: "user-1",
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-01T00:00:00Z"
};

type QueryResult = { data: unknown; error: { message: string; code?: string } | null };

/** One fluent query: every builder step returns itself; awaiting resolves `terminal`. */
function chain(terminal: QueryResult) {
  const c: Record<string, unknown> = {};
  for (const m of ["select", "insert", "update", "delete", "eq"]) {
    c[m] = vi.fn(() => c);
  }
  c.single = vi.fn(async () => terminal);
  c.maybeSingle = vi.fn(async () => terminal);
  c.then = (resolve: (v: QueryResult) => unknown) => Promise.resolve(terminal).then(resolve);
  return c as never;
}

function makeDb(...chains: unknown[]) {
  const from = vi.fn();
  for (const c of chains) from.mockReturnValueOnce(c);
  return { from } as never;
}

describe("toPublicSlackConnection", () => {
  it("strips the ciphertext and exposes only has_bot_token", () => {
    const pub = toPublicSlackConnection(STORED as never);
    expect(pub.has_bot_token).toBe(true);
    expect("bot_token_encrypted" in pub).toBe(false);
    expect(toPublicSlackConnection({ ...STORED, bot_token_encrypted: "" } as never).has_bot_token).toBe(
      false
    );
  });
});

describe("getSlackConnection", () => {
  it("decrypts the bot token server-side", async () => {
    const row = await getSlackConnection(BIZ, makeDb(chain({ data: STORED, error: null })));
    expect(row?.botToken).toBe("xoxb-token");
    expect(row && "bot_token_encrypted" in row).toBe(false);
  });

  it("returns an empty bearer for a deliberately wiped token", async () => {
    const row = await getSlackConnection(
      BIZ,
      makeDb(chain({ data: { ...STORED, bot_token_encrypted: "" }, error: null }))
    );
    expect(row?.botToken).toBe("");
  });

  it("fails closed on an undecryptable stored value", async () => {
    await expect(
      getSlackConnection(
        BIZ,
        makeDb(chain({ data: { ...STORED, bot_token_encrypted: "enc(UNDECRYPTABLE)" }, error: null }))
      )
    ).rejects.toThrow(/no stored bot token/);
  });

  it("returns null when absent and throws on a read error", async () => {
    expect(await getSlackConnection(BIZ, makeDb(chain({ data: null, error: null })))).toBeNull();
    await expect(
      getSlackConnection(BIZ, makeDb(chain({ data: null, error: { message: "boom" } })))
    ).rejects.toThrow(/getSlackConnection: boom/);
  });

  it("falls back to the default service client when none is passed", async () => {
    defaultClientSpy.mockReturnValue(makeDb(chain({ data: STORED, error: null })));
    expect((await getSlackConnection(BIZ))?.botToken).toBe("xoxb-token");
  });
});

describe("getActiveSlackConnection", () => {
  it("requires is_active AND a usable token", async () => {
    expect(
      (await getActiveSlackConnection(BIZ, makeDb(chain({ data: STORED, error: null }))))?.id
    ).toBe("sc-1");
    expect(
      await getActiveSlackConnection(
        BIZ,
        makeDb(chain({ data: { ...STORED, is_active: false }, error: null }))
      )
    ).toBeNull();
    expect(
      await getActiveSlackConnection(
        BIZ,
        makeDb(chain({ data: { ...STORED, bot_token_encrypted: "" }, error: null }))
      )
    ).toBeNull();
    expect(
      await getActiveSlackConnection(BIZ, makeDb(chain({ data: null, error: null })))
    ).toBeNull();
  });
});

describe("getPublicSlackConnection", () => {
  it("returns the masked shape, null when absent, and throws on errors", async () => {
    const pub = await getPublicSlackConnection(BIZ, makeDb(chain({ data: STORED, error: null })));
    expect(pub?.has_bot_token).toBe(true);
    expect(
      await getPublicSlackConnection(BIZ, makeDb(chain({ data: null, error: null })))
    ).toBeNull();
    await expect(
      getPublicSlackConnection(BIZ, makeDb(chain({ data: null, error: { message: "bad" } })))
    ).rejects.toThrow(/getPublicSlackConnection: bad/);
  });
});

describe("getSlackConnectionByTeamId", () => {
  it("routes a team id to its decrypted row, null when unknown, error on failure", async () => {
    const row = await getSlackConnectionByTeamId("T-1", makeDb(chain({ data: STORED, error: null })));
    expect(row?.business_id).toBe(BIZ);
    expect(
      await getSlackConnectionByTeamId("T-x", makeDb(chain({ data: null, error: null })))
    ).toBeNull();
    await expect(
      getSlackConnectionByTeamId("T-1", makeDb(chain({ data: null, error: { message: "x" } })))
    ).rejects.toThrow(/getSlackConnectionByTeamId: x/);
  });
});

const UPSERT_INPUT = {
  businessId: BIZ,
  teamId: "T-1",
  teamName: "Acme",
  enterpriseId: null,
  botUserId: "U-BOT",
  appId: "A-1",
  botToken: "xoxb-token",
  scopes: "chat:write",
  installedByUserId: "user-1"
};

describe("upsertSlackConnection", () => {
  it("inserts when no row exists and returns the masked shape", async () => {
    const insertChain = chain({ data: STORED, error: null });
    const db = makeDb(chain({ data: null, error: null }), insertChain);
    const pub = await upsertSlackConnection(UPSERT_INPUT, db);
    expect(pub.has_bot_token).toBe(true);
    expect((insertChain as { insert: ReturnType<typeof vi.fn> }).insert).toHaveBeenCalledWith(
      expect.objectContaining({
        business_id: BIZ,
        bot_token_encrypted: "enc(xoxb-token)",
        is_active: true
      })
    );
  });

  it("updates (and re-activates) when the business already has a row", async () => {
    const updateChain = chain({ data: STORED, error: null });
    const db = makeDb(chain({ data: { id: "sc-1" }, error: null }), updateChain);
    await upsertSlackConnection(UPSERT_INPUT, db);
    expect((updateChain as { update: ReturnType<typeof vi.fn> }).update).toHaveBeenCalledWith(
      expect.objectContaining({ is_active: true, bot_token_encrypted: "enc(xoxb-token)" })
    );
  });

  it("maps the team unique index to SlackWorkspaceAlreadyLinkedError on both paths", async () => {
    await expect(
      upsertSlackConnection(
        UPSERT_INPUT,
        makeDb(
          chain({ data: null, error: null }),
          chain({ data: null, error: { message: "duplicate key", code: "23505" } })
        )
      )
    ).rejects.toBeInstanceOf(SlackWorkspaceAlreadyLinkedError);

    await expect(
      upsertSlackConnection(
        UPSERT_INPUT,
        makeDb(
          chain({ data: { id: "sc-1" }, error: null }),
          chain({
            data: null,
            error: { message: 'violates unique constraint "uq_slack_connections_team"' }
          })
        )
      )
    ).rejects.toBeInstanceOf(SlackWorkspaceAlreadyLinkedError);
  });

  it("propagates other errors with context", async () => {
    await expect(
      upsertSlackConnection(
        UPSERT_INPUT,
        makeDb(chain({ data: null, error: { message: "read broke" } }))
      )
    ).rejects.toThrow(/upsertSlackConnection: read broke/);

    await expect(
      upsertSlackConnection(
        UPSERT_INPUT,
        makeDb(chain({ data: null, error: null }), chain({ data: null, error: { message: "ins" } }))
      )
    ).rejects.toThrow(/upsertSlackConnection: ins/);

    await expect(
      upsertSlackConnection(
        UPSERT_INPUT,
        makeDb(
          chain({ data: { id: "sc-1" }, error: null }),
          chain({ data: null, error: { message: "upd" } })
        )
      )
    ).rejects.toThrow(/upsertSlackConnection: upd/);
  });
});

describe("setSlackAlertChannel", () => {
  it("stores a channel, clears with null, and throws on errors", async () => {
    const setChain = chain({ data: null, error: null });
    await setSlackAlertChannel(BIZ, { id: "C-1", name: "leads" }, makeDb(setChain));
    expect((setChain as { update: ReturnType<typeof vi.fn> }).update).toHaveBeenCalledWith(
      expect.objectContaining({ alert_channel_id: "C-1", alert_channel_name: "leads" })
    );

    const clearChain = chain({ data: null, error: null });
    await setSlackAlertChannel(BIZ, null, makeDb(clearChain));
    expect((clearChain as { update: ReturnType<typeof vi.fn> }).update).toHaveBeenCalledWith(
      expect.objectContaining({ alert_channel_id: null, alert_channel_name: null })
    );

    await expect(
      setSlackAlertChannel(BIZ, null, makeDb(chain({ data: null, error: { message: "e" } })))
    ).rejects.toThrow(/setSlackAlertChannel: e/);
  });
});

describe("default service client fallbacks", () => {
  it("every accessor works without an explicit client", async () => {
    defaultClientSpy.mockReturnValueOnce(makeDb(chain({ data: STORED, error: null })));
    expect((await getActiveSlackConnection(BIZ))?.id).toBe("sc-1");

    defaultClientSpy.mockReturnValueOnce(makeDb(chain({ data: STORED, error: null })));
    expect((await getPublicSlackConnection(BIZ))?.has_bot_token).toBe(true);

    defaultClientSpy.mockReturnValueOnce(makeDb(chain({ data: STORED, error: null })));
    expect((await getSlackConnectionByTeamId("T-1"))?.business_id).toBe(BIZ);

    defaultClientSpy.mockReturnValueOnce(
      makeDb(chain({ data: null, error: null }), chain({ data: STORED, error: null }))
    );
    expect((await upsertSlackConnection(UPSERT_INPUT)).has_bot_token).toBe(true);

    defaultClientSpy.mockReturnValueOnce(makeDb(chain({ data: null, error: null })));
    await setSlackAlertChannel(BIZ, null);

    defaultClientSpy.mockReturnValueOnce(makeDb(chain({ data: null, error: null })));
    await setSlackConnectionActive(BIZ, true);

    defaultClientSpy.mockReturnValueOnce(makeDb(chain({ data: null, error: null })));
    await deleteSlackConnection(BIZ);

    defaultClientSpy.mockReturnValueOnce(makeDb(chain({ data: null, error: null })));
    await markSlackConnectionDeauthorizedByTeamId("T-1");
  });
});

describe("setSlackConnectionActive / deleteSlackConnection / deauthorize", () => {
  it("flips is_active and throws on errors", async () => {
    const c = chain({ data: null, error: null });
    await setSlackConnectionActive(BIZ, false, makeDb(c));
    expect((c as { update: ReturnType<typeof vi.fn> }).update).toHaveBeenCalledWith(
      expect.objectContaining({ is_active: false })
    );
    await expect(
      setSlackConnectionActive(BIZ, true, makeDb(chain({ data: null, error: { message: "e" } })))
    ).rejects.toThrow(/setSlackConnectionActive: e/);
  });

  it("deletes the row and throws on errors", async () => {
    const c = chain({ data: null, error: null });
    await deleteSlackConnection(BIZ, makeDb(c));
    expect((c as { delete: ReturnType<typeof vi.fn> }).delete).toHaveBeenCalled();
    await expect(
      deleteSlackConnection(BIZ, makeDb(chain({ data: null, error: { message: "e" } })))
    ).rejects.toThrow(/deleteSlackConnection: e/);
  });

  it("wipes the dead token and deactivates by team id", async () => {
    const c = chain({ data: null, error: null });
    await markSlackConnectionDeauthorizedByTeamId("T-1", makeDb(c));
    expect((c as { update: ReturnType<typeof vi.fn> }).update).toHaveBeenCalledWith(
      expect.objectContaining({ is_active: false, bot_token_encrypted: "" })
    );
    expect((c as { eq: ReturnType<typeof vi.fn> }).eq).toHaveBeenCalledWith("team_id", "T-1");
    await expect(
      markSlackConnectionDeauthorizedByTeamId(
        "T-1",
        makeDb(chain({ data: null, error: { message: "e" } }))
      )
    ).rejects.toThrow(/markSlackConnectionDeauthorizedByTeamId: e/);
  });
});

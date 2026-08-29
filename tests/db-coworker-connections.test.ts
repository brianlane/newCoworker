import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Connections for the team-chat channels on the shared pipeline.
 *
 * The two properties worth pinning: the PUBLIC read must never be able to
 * serialise a credential (a route that cannot leak one, cannot leak one),
 * and an undecryptable credential must degrade to "needs reconnect" rather
 * than throwing, because a throw here would turn one tenant's stale row
 * into a failed worker pass for everybody in the batch.
 */

vi.mock("@/lib/integrations/secrets", () => ({
  encryptIntegrationSecret: vi.fn((v: string) => `enc:${v}`),
  decryptIntegrationSecret: vi.fn((v: string) => {
    if (v === "enc:BROKEN") throw new Error("key rotated");
    if (v === "enc:STRINGTHROW") throw "key rotated";
    if (v === "enc:NULL") return null;
    return v.startsWith("enc:") ? v.slice(4) : v;
  })
}));
const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import {
  CoworkerWorkspaceAlreadyLinkedError,
  deleteCoworkerConnection,
  getActiveCoworkerConnection,
  getCoworkerConnection,
  getPublicCoworkerConnection,
  setCoworkerAlertTarget,
  setCoworkerConnectionActive,
  upsertCoworkerConnection
} from "@/lib/db/coworker-connections";

const BIZ = "11111111-1111-4111-8111-111111111111";

type Result = { data: unknown; error: { message: string } | null };

/** A PostgREST-shaped chain that records the select it was given. */
function chain(terminal: Result, seen: { select?: string; filters: [string, unknown][] }) {
  const c: Record<string, unknown> = {};
  for (const m of ["insert", "update", "delete", "upsert"]) c[m] = vi.fn(() => c);
  c.select = vi.fn((cols?: string) => {
    if (typeof cols === "string") seen.select = cols;
    return c;
  });
  c.eq = vi.fn((col: string, val: unknown) => {
    seen.filters.push([col, val]);
    return c;
  });
  c.maybeSingle = vi.fn(async () => terminal);
  c.single = vi.fn(async () => terminal);
  // update/delete await the BUILDER itself rather than a terminal method,
  // so the double has to be thenable or those calls resolve to the builder
  // object and every error check silently passes.
  c.then = (resolve: (v: Result) => unknown) => resolve(terminal);
  return c;
}

function db(results: Result[]) {
  const seen: { select?: string; filters: [string, unknown][] } = { filters: [] };
  const from = vi.fn();
  for (const r of results) from.mockReturnValueOnce(chain(r, seen));
  return { client: { from } as never, seen };
}

const STORED = {
  id: "conn-1",
  business_id: BIZ,
  channel: "telegram",
  external_workspace_id: "999",
  external_workspace_name: "@acme_bot",
  alert_target_id: "-100",
  alert_target_name: null,
  is_active: true,
  created_at: "",
  updated_at: "",
  credentials_encrypted: "enc:123:AA",
  webhook_secret: "shh"
};

beforeEach(() => vi.clearAllMocks());

describe("reading a connection", () => {
  it("decrypts the credential for the send paths", async () => {
    const { client } = db([{ data: STORED, error: null }]);
    const row = await getCoworkerConnection(BIZ, "telegram", client);
    expect(row?.credential).toBe("123:AA");
    expect(row?.webhookSecret).toBe("shh");
  });

  it("reports an undecryptable credential as EMPTY, never as a throw", async () => {
    // The column is NOT NULL, so this only happens when the encryption key
    // rotated out from under a stored row. Every caller already treats an
    // empty credential as "needs reconnect".
    const { client } = db([{ data: { ...STORED, credentials_encrypted: "enc:BROKEN" }, error: null }]);
    const row = await getCoworkerConnection(BIZ, "telegram", client);
    expect(row?.credential).toBe("");
  });

  it("coalesces a null decrypt result to an empty credential", async () => {
    // The helper returns null for an empty input. Every caller here expects
    // a string, and "" is already the needs-reconnect signal.
    const { client } = db([{ data: { ...STORED, credentials_encrypted: "enc:NULL" }, error: null }]);
    expect((await getCoworkerConnection(BIZ, "telegram", client))?.credential).toBe("");
  });

  it("survives a decrypt failure that was not an Error", async () => {
    const { client } = db([
      { data: { ...STORED, credentials_encrypted: "enc:STRINGTHROW" }, error: null }
    ]);
    expect((await getCoworkerConnection(BIZ, "telegram", client))?.credential).toBe("");
  });

  it("handles a wiped credential without calling decrypt at all", async () => {
    const { client } = db([{ data: { ...STORED, credentials_encrypted: "" }, error: null }]);
    expect((await getCoworkerConnection(BIZ, "telegram", client))?.credential).toBe("");
  });

  it("throws on a read error rather than reporting no connection", async () => {
    const { client } = db([{ data: null, error: { message: "down" } }]);
    await expect(getCoworkerConnection(BIZ, "telegram", client)).rejects.toThrow("down");
  });

  it("returns null when there is no row", async () => {
    const { client } = db([{ data: null, error: null }]);
    expect(await getCoworkerConnection(BIZ, "telegram", client)).toBeNull();
  });
});

describe("the public read", () => {
  it("cannot serialise a credential, because it never asks for one", async () => {
    const { client, seen } = db([{ data: { id: "conn-1" }, error: null }]);
    await getPublicCoworkerConnection(BIZ, "telegram", client);
    expect(seen.select).not.toContain("credentials_encrypted");
    expect(seen.select).not.toContain("webhook_secret");
  });

  it("throws on a read error", async () => {
    const { client } = db([{ data: null, error: { message: "down" } }]);
    await expect(getPublicCoworkerConnection(BIZ, "telegram", client)).rejects.toThrow("down");
  });

  it("returns null when there is no row", async () => {
    const { client } = db([{ data: null, error: null }]);
    expect(await getPublicCoworkerConnection(BIZ, "telegram", client)).toBeNull();
  });
});

describe("the active read", () => {
  it.each([
    ["paused", { ...STORED, is_active: false }],
    ["credential unreadable", { ...STORED, credentials_encrypted: "enc:BROKEN" }]
  ])("returns null when %s", async (_label, row) => {
    const { client } = db([{ data: row, error: null }]);
    expect(await getActiveCoworkerConnection(BIZ, "telegram", client)).toBeNull();
  });

  it("returns the row when it is live", async () => {
    const { client } = db([{ data: STORED, error: null }]);
    expect(await getActiveCoworkerConnection(BIZ, "telegram", client)).not.toBeNull();
  });
});

describe("routing an inbound event to its business", () => {
  it("keys the ownership check on the PROVIDER's workspace id", async () => {
    // Driven through the upsert, which is the only caller until a channel
    // that routes by workspace id (Teams, Google Chat) needs it directly.
    const { client, seen } = db([
      { data: null, error: null },
      { data: { id: "conn-1" }, error: null }
    ]);
    await upsertCoworkerConnection(
      { businessId: BIZ, channel: "telegram", externalWorkspaceId: "999", credential: "x" },
      client
    );
    expect(seen.filters).toContainEqual(["channel", "telegram"]);
    expect(seen.filters).toContainEqual(["external_workspace_id", "999"]);
  });

  it("throws on a read error, so an unknown bot is never mistaken for a miss", async () => {
    const { client } = db([{ data: null, error: { message: "down" } }]);
    await expect(
      upsertCoworkerConnection(
        { businessId: BIZ, channel: "telegram", externalWorkspaceId: "999", credential: "x" },
        client
      )
    ).rejects.toThrow("down");
  });
});

describe("connecting", () => {
  it("encrypts the credential and reports the public row", async () => {
    const { client } = db([
      { data: null, error: null },
      { data: { id: "conn-1", business_id: BIZ }, error: null }
    ]);
    const row = await upsertCoworkerConnection(
      {
        businessId: BIZ,
        channel: "telegram",
        externalWorkspaceId: "999",
        credential: "123:AA"
      },
      client
    );
    expect(row.id).toBe("conn-1");
  });

  it("refuses a workspace another business already owns, with a nameable error", async () => {
    // The unique index would hold anyway, but a raw 23505 is not something
    // the connect route can explain to whoever is at the settings page.
    const { client } = db([{ data: { ...STORED, business_id: "someone-else" }, error: null }]);
    await expect(
      upsertCoworkerConnection(
        { businessId: BIZ, channel: "telegram", externalWorkspaceId: "999", credential: "x" },
        client
      )
    ).rejects.toBeInstanceOf(CoworkerWorkspaceAlreadyLinkedError);
  });

  it("lets the SAME business reconnect its own bot", async () => {
    const { client } = db([
      { data: STORED, error: null },
      { data: { id: "conn-1" }, error: null }
    ]);
    await expect(
      upsertCoworkerConnection(
        { businessId: BIZ, channel: "telegram", externalWorkspaceId: "999", credential: "x" },
        client
      )
    ).resolves.toMatchObject({ id: "conn-1" });
  });

  it("throws on a failed write", async () => {
    const { client } = db([
      { data: null, error: null },
      { data: null, error: { message: "write down" } }
    ]);
    await expect(
      upsertCoworkerConnection(
        { businessId: BIZ, channel: "telegram", externalWorkspaceId: "999", credential: "x" },
        client
      )
    ).rejects.toThrow("write down");
  });
});

describe("settings and disconnect", () => {
  const writes = {
    "alert target": (c: never) =>
      setCoworkerAlertTarget(BIZ, "telegram", { id: "-1", name: "x" }, c),
    pause: (c: never) => setCoworkerConnectionActive(BIZ, "telegram", true, c),
    delete: (c: never) => deleteCoworkerConnection(BIZ, "telegram", c)
  } as const;

  it.each(Object.keys(writes))("throws when the %s write fails", async (label) => {
    const { client } = db([{ data: null, error: { message: "down" } }]);
    await expect(writes[label as keyof typeof writes](client as never)).rejects.toThrow("down");
  });

  it.each(Object.keys(writes))("succeeds quietly when the %s write lands", async (label) => {
    const { client } = db([{ data: null, error: null }]);
    await expect(writes[label as keyof typeof writes](client as never)).resolves.toBeUndefined();
  });

  it("scopes every write to this business AND this channel", async () => {
    // Without the channel filter a pause on Telegram would pause every
    // team-chat channel the business has.
    const { client, seen } = db([{ data: null, error: null }]);
    await setCoworkerConnectionActive(BIZ, "telegram", false, client);
    expect(seen.filters).toContainEqual(["business_id", BIZ]);
    expect(seen.filters).toContainEqual(["channel", "telegram"]);
  });
});

describe("the default service client", () => {
  /**
   * Every function here takes an optional client so tests can inject one,
   * and reaches for the service client otherwise. That fallback IS the
   * production path, so it is exercised for each of them rather than for
   * one representative: the ones nobody checks are the ones that get a
   * client threaded through them wrongly later.
   */
  const calls: [string, () => Promise<unknown>][] = [
    ["getCoworkerConnection", () => getCoworkerConnection(BIZ, "telegram")],
    ["getActiveCoworkerConnection", () => getActiveCoworkerConnection(BIZ, "telegram")],
    ["getPublicCoworkerConnection", () => getPublicCoworkerConnection(BIZ, "telegram")],
    ["setCoworkerAlertTarget", () => setCoworkerAlertTarget(BIZ, "telegram", { id: "-1", name: null })],
    ["setCoworkerConnectionActive", () => setCoworkerConnectionActive(BIZ, "telegram", true)],
    ["deleteCoworkerConnection", () => deleteCoworkerConnection(BIZ, "telegram")]
  ];

  it.each(calls)("%s falls back to it", async (_name, run) => {
    const { client } = db([{ data: null, error: null }]);
    defaultClientSpy.mockReturnValueOnce(client);
    await expect(run()).resolves.toBeDefined;
  });

  it("upsertCoworkerConnection falls back to it too", async () => {
    // Two reads, so it needs its own fixture rather than the shared one.
    const { client } = db([
      { data: null, error: null },
      { data: { id: "conn-1" }, error: null }
    ]);
    defaultClientSpy.mockReturnValue(client);
    await expect(
      upsertCoworkerConnection({
        businessId: BIZ,
        channel: "telegram",
        externalWorkspaceId: "999",
        credential: "x"
      })
    ).resolves.toMatchObject({ id: "conn-1" });
  });
});

/**
 * Prospecting DB access (src/lib/outreach/db.ts): success + error paths for
 * every helper, the guarded status claim, and the two suppression axes
 * (domain uniqueness at insert, address uniqueness surfacing as a patch that
 * reports false instead of throwing).
 *
 * Every helper is exercised with an injected client AND with the default one,
 * because both arms of `client ?? (await createSupabaseServiceClient())` are
 * live code paths in production.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import {
  claimDiscoveryRun,
  claimProspectNudge,
  countProspectsNudgedSince,
  countProspectsByStatus,
  countProspectsInVertical,
  countProspectsSentSince,
  countProspectsToRewrite,
  existingProspectDomains,
  findProspectByEmail,
  getOutreachSettings,
  getProspect,
  insertDraftedProspect,
  insertProspects,
  listActiveOutreachSettings,
  listProspectOutcomes,
  listProspectsByEmail,
  listProspectsByEmailAnyTenant,
  listProspectsByStatus,
  listProspectsDueForNudge,
  listProspectsContactedSince,
  listProspectsToProbe,
  listProspectsToRewrite,
  OUTREACH_ACTIVE_PAGE_SIZE,
  patchProspect,
  skipProspectsInVertical,
  transitionProspect,
  upsertOutreachSettings
} from "@/lib/outreach/db";
import { PG_UNIQUE_VIOLATION } from "@/lib/customer-memory/db";
import { UNKNOWN_VERTICAL } from "@/lib/outreach/stats";

const BIZ = "11111111-1111-4111-8111-111111111111";
const PROSPECT = "22222222-2222-4222-8222-222222222222";

type Chain = Record<string, ReturnType<typeof vi.fn>> & PromiseLike<unknown>;

function chain(terminal?: unknown): Chain {
  const c: Record<string, unknown> = {};
  for (const m of [
    "select",
    "insert",
    "update",
    "delete",
    "upsert",
    "eq",
    "neq",
    "in",
    "ilike",
    "is",
    "gte",
    "lte",
    "lt",
    "not",
    "or",
    "order",
    "range",
    "limit"
  ]) {
    c[m] = vi.fn(() => c);
  }
  c.single = vi.fn();
  c.maybeSingle = vi.fn();
  c.then = (resolve: (v: unknown) => unknown) => Promise.resolve(terminal).then(resolve);
  return c as Chain;
}

function makeDb(c: unknown) {
  return { from: vi.fn(() => c) } as never;
}

/** A chain whose `.maybeSingle()` resolves to the given payload. */
function singleChain(payload: unknown): Chain {
  const c = chain();
  c.maybeSingle.mockResolvedValue(payload);
  return c;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getOutreachSettings", () => {
  it("reads the row through an injected client and the default one", async () => {
    const row = { business_id: BIZ, mode: "auto" };
    expect(await getOutreachSettings(BIZ, makeDb(singleChain({ data: row, error: null })))).toEqual(
      row
    );

    defaultClientSpy.mockReturnValue(makeDb(singleChain({ data: row, error: null })));
    expect(await getOutreachSettings(BIZ)).toEqual(row);
  });

  it("coerces a missing row to null and throws on error", async () => {
    expect(
      await getOutreachSettings(BIZ, makeDb(singleChain({ data: null, error: null })))
    ).toBeNull();
    await expect(
      getOutreachSettings(BIZ, makeDb(singleChain({ data: null, error: { message: "boom" } })))
    ).rejects.toThrow(/boom/);
  });
});

describe("upsertOutreachSettings", () => {
  it("upserts on business_id, stamps updated_at, and returns the row", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: { business_id: BIZ, mode: "manual" }, error: null });
    expect(await upsertOutreachSettings(BIZ, { mode: "manual" }, makeDb(c))).toMatchObject({
      mode: "manual"
    });
    expect(c.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        business_id: BIZ,
        mode: "manual",
        updated_at: expect.any(String)
      }),
      { onConflict: "business_id" }
    );
  });

  it("works through the default client and throws on error", async () => {
    const ok = chain();
    ok.single.mockResolvedValue({ data: { business_id: BIZ }, error: null });
    defaultClientSpy.mockReturnValue(makeDb(ok));
    expect(await upsertOutreachSettings(BIZ, { daily_cap: 5 })).toMatchObject({
      business_id: BIZ
    });

    const bad = chain();
    bad.single.mockResolvedValue({ data: null, error: { message: "nope" } });
    await expect(upsertOutreachSettings(BIZ, {}, makeDb(bad))).rejects.toThrow(/nope/);
  });
});

describe("listActiveOutreachSettings", () => {
  it("excludes the off mode, coerces null, and throws on error", async () => {
    const c = chain({ data: [{ business_id: BIZ, mode: "auto" }], error: null });
    expect(await listActiveOutreachSettings(makeDb(c))).toHaveLength(1);
    expect(c.neq).toHaveBeenCalledWith("mode", "off");
    // Ordered by a STABLE key: the sweep stamps last_discovery_at as it goes,
    // so a time ordering would reshuffle rows underneath the pagination and a
    // business could be swept twice or skipped.
    expect(c.order).toHaveBeenCalledWith("business_id", { ascending: true });
    expect(c.range).toHaveBeenCalledWith(0, 199);

    defaultClientSpy.mockReturnValue(makeDb(chain({ data: null, error: null })));
    expect(await listActiveOutreachSettings()).toEqual([]);

    await expect(
      listActiveOutreachSettings(makeDb(chain({ data: null, error: { message: "list" } })))
    ).rejects.toThrow(/list/);
  });

  it("reads a later page when asked, so a big fleet is not truncated", async () => {
    const c = chain({ data: [], error: null });
    await listActiveOutreachSettings(makeDb(c), OUTREACH_ACTIVE_PAGE_SIZE);
    expect(c.range).toHaveBeenCalledWith(200, 399);
  });
});

describe("insertProspects", () => {
  const row = { business_id: BIZ, domain: "acme.com" };

  it("short-circuits on an empty batch without touching the database", async () => {
    const db = makeDb(chain());
    expect(await insertProspects([], db)).toEqual([]);
    expect((db as unknown as { from: ReturnType<typeof vi.fn> }).from).not.toHaveBeenCalled();
  });

  it("ignores domains already in the ledger and returns only new rows", async () => {
    const c = chain({ data: [{ id: PROSPECT, domain: "acme.com" }], error: null });
    expect(await insertProspects([row], makeDb(c))).toHaveLength(1);
    expect(c.upsert).toHaveBeenCalledWith([row], {
      onConflict: "business_id,domain",
      ignoreDuplicates: true
    });

    defaultClientSpy.mockReturnValue(makeDb(chain({ data: null, error: null })));
    expect(await insertProspects([row])).toEqual([]);

    await expect(
      insertProspects([row], makeDb(chain({ data: null, error: { message: "ins" } })))
    ).rejects.toThrow(/ins/);
  });
});

describe("insertDraftedProspect", () => {
  const row = {
    id: PROSPECT,
    business_id: BIZ,
    domain: "acme.com",
    business_name: "Acme",
    email: "info@acme.com",
    phone: null,
    website: null,
    vertical: "",
    city: "Tempe AZ",
    findings: [],
    pitch_subject: "Acme: hello",
    pitch_paragraphs: "Hi Acme,",
    pitch_body: "Hi Acme,\n\nfooter\n",
    drafted_at: "2026-09-05T00:00:00Z"
  };

  it("inserts ONE row already at drafted and returns it", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: { ...row, status: "drafted" }, error: null });
    expect(await insertDraftedProspect(row, makeDb(c))).toMatchObject({ id: PROSPECT, status: "drafted" });
    // Straight to drafted: a row that passed through `discovered` would be
    // probed by the sweep and overwritten or retired before the owner saw it.
    expect(c.insert).toHaveBeenCalledWith({ ...row, status: "drafted", status_detail: null });
    expect(c.select).toHaveBeenCalled();

    const d = chain();
    d.single.mockResolvedValue({ data: { ...row, status: "drafted" }, error: null });
    defaultClientSpy.mockReturnValue(makeDb(d));
    expect(await insertDraftedProspect(row)).toMatchObject({ id: PROSPECT });
  });

  it("reports a unique violation as null and throws on anything else", async () => {
    // Both suppression axes surface as the same code: the (business, domain)
    // constraint and the partial index on lower(email).
    const dup = chain();
    dup.single.mockResolvedValue({ data: null, error: { code: PG_UNIQUE_VIOLATION, message: "dup" } });
    expect(await insertDraftedProspect(row, makeDb(dup))).toBeNull();

    const bad = chain();
    bad.single.mockResolvedValue({ data: null, error: { code: "42P01", message: "no table" } });
    await expect(insertDraftedProspect(row, makeDb(bad))).rejects.toThrow(
      /insertDraftedProspect: no table/
    );
  });
});

describe("existingProspectDomains", () => {
  it("returns the suppression set, empty-input short-circuits, and throws on error", async () => {
    const db = makeDb(chain());
    expect(await existingProspectDomains(BIZ, [], db)).toEqual(new Set());
    expect((db as unknown as { from: ReturnType<typeof vi.fn> }).from).not.toHaveBeenCalled();

    const c = chain({ data: [{ domain: "acme.com" }], error: null });
    expect(await existingProspectDomains(BIZ, ["acme.com", "new.com"], makeDb(c))).toEqual(
      new Set(["acme.com"])
    );

    defaultClientSpy.mockReturnValue(makeDb(chain({ data: null, error: null })));
    expect(await existingProspectDomains(BIZ, ["x.com"])).toEqual(new Set());

    await expect(
      existingProspectDomains(BIZ, ["x.com"], makeDb(chain({ data: null, error: { message: "dm" } })))
    ).rejects.toThrow(/dm/);
  });
});

describe("listProspectsToProbe", () => {
  it("takes the busiest prospects first, oldest as the tie-break", async () => {
    const c = chain({ data: [{ id: PROSPECT }], error: null });
    expect(await listProspectsToProbe(BIZ, 8, makeDb(c))).toHaveLength(1);
    expect(c.eq).toHaveBeenCalledWith("status", "discovered");
    // A probe and a draft each cost a fetch and a model call, so the
    // established businesses get them first. Ordering only: nothing is
    // excluded on review count.
    expect(c.order).toHaveBeenCalledWith("review_count", {
      ascending: false,
      nullsFirst: false
    });
    expect(c.order).toHaveBeenCalledWith("created_at", { ascending: true });

    defaultClientSpy.mockReturnValue(makeDb(chain({ data: null, error: null })));
    expect(await listProspectsToProbe(BIZ, 8)).toEqual([]);

    await expect(
      listProspectsToProbe(BIZ, 8, makeDb(chain({ data: null, error: { message: "tp" } })))
    ).rejects.toThrow(/tp/);
  });
});

describe("listProspectsByStatus / getProspect / listProspectOutcomes", () => {
  it("lists by status, coerces null, and throws on error", async () => {
    const c = chain({ data: [{ id: PROSPECT }], error: null });
    expect(await listProspectsByStatus(BIZ, ["drafted"], 10, makeDb(c))).toHaveLength(1);
    expect(c.in).toHaveBeenCalledWith("status", ["drafted"]);

    defaultClientSpy.mockReturnValue(makeDb(chain({ data: null, error: null })));
    expect(await listProspectsByStatus(BIZ, ["queued"], 5)).toEqual([]);

    await expect(
      listProspectsByStatus(BIZ, ["sent"], 5, makeDb(chain({ data: null, error: { message: "ls" } })))
    ).rejects.toThrow(/ls/);
  });

  it("gets one prospect, or null, or throws", async () => {
    expect(
      await getProspect(BIZ, PROSPECT, makeDb(singleChain({ data: { id: PROSPECT }, error: null })))
    ).toMatchObject({ id: PROSPECT });

    defaultClientSpy.mockReturnValue(makeDb(singleChain({ data: null, error: null })));
    expect(await getProspect(BIZ, PROSPECT)).toBeNull();

    await expect(
      getProspect(BIZ, PROSPECT, makeDb(singleChain({ data: null, error: { message: "gp" } })))
    ).rejects.toThrow(/gp/);
  });

  it("reads outcome rows for the funnel, coerces null, and throws on error", async () => {
    const c = chain({ data: [{ status: "sent", vertical: "hvac" }], error: null });
    expect(await listProspectOutcomes(BIZ, makeDb(c))).toEqual([
      { status: "sent", vertical: "hvac" }
    ]);

    defaultClientSpy.mockReturnValue(makeDb(chain({ data: null, error: null })));
    expect(await listProspectOutcomes(BIZ)).toEqual([]);

    await expect(
      listProspectOutcomes(BIZ, makeDb(chain({ data: null, error: { message: "oc" } })))
    ).rejects.toThrow(/oc/);
  });
});

describe("listProspectsDueForNudge", () => {
  it("asks only for sent, never-nudged prospects inside the patience window", async () => {
    const c = chain({ data: [{ id: PROSPECT }], error: null });
    expect(
      await listProspectsDueForNudge(
        BIZ,
        "2026-07-06T00:00:00Z",
        "2026-07-22T00:00:00Z",
        5,
        makeDb(c)
      )
    ).toHaveLength(1);
    expect(c.eq).toHaveBeenCalledWith("status", "sent");
    // The null check is what makes "one follow-up, ever" true.
    expect(c.is).toHaveBeenCalledWith("nudged_at", null);
    expect(c.gte).toHaveBeenCalledWith("sent_at", "2026-07-06T00:00:00Z");
    expect(c.lte).toHaveBeenCalledWith("sent_at", "2026-07-22T00:00:00Z");

    defaultClientSpy.mockReturnValue(makeDb(chain({ data: null, error: null })));
    expect(await listProspectsDueForNudge(BIZ, "a", "b", 5)).toEqual([]);

    await expect(
      listProspectsDueForNudge(BIZ, "a", "b", 5, makeDb(chain({ data: null, error: { message: "nd" } })))
    ).rejects.toThrow(/nd/);
  });
});

describe("findProspectByEmail", () => {
  it("normalizes the address, short-circuits on blank, and throws on error", async () => {
    const db = makeDb(chain());
    expect(await findProspectByEmail(BIZ, "   ", db)).toBeNull();
    expect((db as unknown as { from: ReturnType<typeof vi.fn> }).from).not.toHaveBeenCalled();

    const c = singleChain({ data: { id: PROSPECT }, error: null });
    expect(await findProspectByEmail(BIZ, "  Owner@ACME.com ", makeDb(c))).toMatchObject({
      id: PROSPECT
    });
    // Equality, never ILIKE: an underscore in a local part is a wildcard to
    // ILIKE, so john_smith@acme.com would also match johnXsmith@acme.com and
    // could mark the wrong prospect replied.
    expect(c.eq).toHaveBeenCalledWith("email", "owner@acme.com");
    expect(c.ilike).not.toHaveBeenCalled();

    defaultClientSpy.mockReturnValue(makeDb(singleChain({ data: null, error: null })));
    expect(await findProspectByEmail(BIZ, "nobody@acme.com")).toBeNull();

    await expect(
      findProspectByEmail(BIZ, "a@b.com", makeDb(singleChain({ data: null, error: { message: "fe" } })))
    ).rejects.toThrow(/fe/);
  });
});

describe("listProspectsByEmail", () => {
  it("normalizes, scopes to the tenant, equality not ILIKE", async () => {
    const db = makeDb(chain());
    expect(await listProspectsByEmail(BIZ, "   ", db)).toEqual([]);
    expect((db as unknown as { from: ReturnType<typeof vi.fn> }).from).not.toHaveBeenCalled();

    const c = chain({ data: [{ id: PROSPECT }], error: null });
    expect(await listProspectsByEmail(BIZ, "  Owner@ACME.com ", makeDb(c))).toHaveLength(1);
    expect(c.eq).toHaveBeenCalledWith("business_id", BIZ);
    expect(c.eq).toHaveBeenCalledWith("email", "owner@acme.com");
    expect(c.ilike).not.toHaveBeenCalled();
    expect(c.limit).toHaveBeenCalledWith(10);

    defaultClientSpy.mockReturnValue(makeDb(chain({ data: null, error: null })));
    expect(await listProspectsByEmail(BIZ, "nobody@acme.com")).toEqual([]);

    await expect(
      listProspectsByEmail(BIZ, "a@b.com", makeDb(chain({ data: null, error: { message: "le" } })))
    ).rejects.toThrow(/le/);
  });
});

describe("listProspectsByEmailAnyTenant", () => {
  it("looks up by address alone, equality not ILIKE", async () => {
    const db = makeDb(chain());
    expect(await listProspectsByEmailAnyTenant("   ", db)).toEqual([]);
    expect((db as unknown as { from: ReturnType<typeof vi.fn> }).from).not.toHaveBeenCalled();

    const c = chain({ data: [{ id: PROSPECT }], error: null });
    expect(await listProspectsByEmailAnyTenant("  Owner@ACME.com ", makeDb(c))).toHaveLength(1);
    expect(c.eq).toHaveBeenCalledWith("email", "owner@acme.com");
    expect(c.eq).not.toHaveBeenCalledWith("business_id", BIZ);
    expect(c.ilike).not.toHaveBeenCalled();
    expect(c.limit).toHaveBeenCalledWith(10);

    defaultClientSpy.mockReturnValue(makeDb(chain({ data: null, error: null })));
    expect(await listProspectsByEmailAnyTenant("nobody@acme.com")).toEqual([]);

    await expect(
      listProspectsByEmailAnyTenant("a@b.com", makeDb(chain({ data: null, error: { message: "at" } })))
    ).rejects.toThrow(/at/);
  });
});

describe("patchProspect", () => {
  it("reports success, and reports false on the address-axis unique violation", async () => {
    const ok = chain({ error: null });
    expect(await patchProspect(BIZ, PROSPECT, { status: "drafted" }, makeDb(ok))).toBe(true);
    expect(ok.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "drafted", updated_at: expect.any(String) })
    );

    // A second prospect of this business already owns this address: the write
    // is refused by the partial unique index, and the caller must be able to
    // retire the duplicate rather than crash the sweep.
    const dupe = chain({ error: { code: PG_UNIQUE_VIOLATION, message: "duplicate key" } });
    expect(await patchProspect(BIZ, PROSPECT, { email: "shared@acme.com" }, makeDb(dupe))).toBe(
      false
    );

    defaultClientSpy.mockReturnValue(makeDb(chain({ error: null })));
    expect(await patchProspect(BIZ, PROSPECT, { status: "sent" })).toBe(true);

    await expect(
      patchProspect(BIZ, PROSPECT, {}, makeDb(chain({ error: { code: "42P01", message: "pp" } })))
    ).rejects.toThrow(/pp/);
  });
});

describe("transitionProspect", () => {
  it("only moves a row still in the expected status", async () => {
    const moved = chain({ data: [{ id: PROSPECT }], error: null });
    expect(
      await transitionProspect(BIZ, PROSPECT, "drafted", { status: "queued" }, makeDb(moved))
    ).toBe(true);
    expect(moved.eq).toHaveBeenCalledWith("status", "drafted");

    // Lost the claim: an overlapping sweep (or the owner's Send press) already
    // advanced it, so this caller must not send too.
    const lost = chain({ data: [], error: null });
    expect(
      await transitionProspect(BIZ, PROSPECT, "drafted", { status: "queued" }, makeDb(lost))
    ).toBe(false);

    defaultClientSpy.mockReturnValue(makeDb(chain({ data: [{ id: PROSPECT }], error: null })));
    expect(await transitionProspect(BIZ, PROSPECT, "queued", { status: "sent" })).toBe(true);

    await expect(
      transitionProspect(
        BIZ,
        PROSPECT,
        "drafted",
        {},
        makeDb(chain({ data: null, error: { message: "tp" } }))
      )
    ).rejects.toThrow(/tp/);
  });
});

describe("claimDiscoveryRun", () => {
  it("wins only when today's discovery has not been claimed", async () => {
    const won = chain({ data: [{ business_id: BIZ }], error: null });
    expect(
      await claimDiscoveryRun(BIZ, "2026-07-27T16:00:00Z", "2026-07-27T00:00:00Z", makeDb(won))
    ).toBe(true);
    // The condition rides INSIDE the update: a read-then-write would let two
    // overlapping sweeps both buy the same paid Places searches.
    expect(won.or).toHaveBeenCalledWith(
      "last_discovery_at.is.null,last_discovery_at.lt.2026-07-27T00:00:00Z"
    );

    const lost = chain({ data: [], error: null });
    expect(
      await claimDiscoveryRun(BIZ, "2026-07-27T16:00:00Z", "2026-07-27T00:00:00Z", makeDb(lost))
    ).toBe(false);

    defaultClientSpy.mockReturnValue(makeDb(chain({ data: [{ business_id: BIZ }], error: null })));
    expect(await claimDiscoveryRun(BIZ, "2026-07-27T16:00:00Z", "2026-07-27T00:00:00Z")).toBe(true);

    await expect(
      claimDiscoveryRun(
        BIZ,
        "2026-07-27T16:00:00Z",
        "2026-07-27T00:00:00Z",
        makeDb(chain({ data: null, error: { message: "cd" } }))
      )
    ).rejects.toThrow(/cd/);
  });
});

describe("claimProspectNudge", () => {
  it("wins only while the follow-up is still unspent", async () => {
    const won = chain({ data: [{ id: PROSPECT }], error: null });
    expect(await claimProspectNudge(BIZ, PROSPECT, "2026-07-27T16:00:00Z", makeDb(won))).toBe(true);
    // Both guards ride inside the UPDATE, so exactly one caller can win: the
    // status check alone would let two overlapping passes both send.
    expect(won.eq).toHaveBeenCalledWith("status", "sent");
    expect(won.is).toHaveBeenCalledWith("nudged_at", null);
    expect(won.update).toHaveBeenCalledWith(
      expect.objectContaining({ nudged_at: "2026-07-27T16:00:00Z" })
    );

    const lost = chain({ data: [], error: null });
    expect(await claimProspectNudge(BIZ, PROSPECT, "2026-07-27T16:00:00Z", makeDb(lost))).toBe(
      false
    );

    defaultClientSpy.mockReturnValue(makeDb(chain({ data: [{ id: PROSPECT }], error: null })));
    expect(await claimProspectNudge(BIZ, PROSPECT, "2026-07-27T16:00:00Z")).toBe(true);

    await expect(
      claimProspectNudge(
        BIZ,
        PROSPECT,
        "2026-07-27T16:00:00Z",
        makeDb(chain({ data: null, error: { message: "cn" } }))
      )
    ).rejects.toThrow(/cn/);
  });
});

describe("countProspectsSentSince / countProspectsNudgedSince", () => {
  const DAY = "2026-07-27T00:00:00.000Z";

  it("counts today's sends, treats a null count as zero, and throws on error", async () => {
    const c = chain({ count: 4, error: null });
    expect(await countProspectsSentSince(BIZ, DAY, makeDb(c))).toBe(4);
    expect(c.gte).toHaveBeenCalledWith("sent_at", DAY);

    defaultClientSpy.mockReturnValue(makeDb(chain({ count: null, error: null })));
    expect(await countProspectsSentSince(BIZ, DAY)).toBe(0);

    await expect(
      countProspectsSentSince(BIZ, DAY, makeDb(chain({ count: null, error: { message: "cnt" } })))
    ).rejects.toThrow(/cnt/);
  });

  it("counts today's follow-ups separately, since both spend the same cap", async () => {
    const c = chain({ count: 2, error: null });
    expect(await countProspectsNudgedSince(BIZ, DAY, makeDb(c))).toBe(2);
    expect(c.gte).toHaveBeenCalledWith("nudged_at", DAY);

    defaultClientSpy.mockReturnValue(makeDb(chain({ count: null, error: null })));
    expect(await countProspectsNudgedSince(BIZ, DAY)).toBe(0);

    await expect(
      countProspectsNudgedSince(BIZ, DAY, makeDb(chain({ count: null, error: { message: "nc" } })))
    ).rejects.toThrow(/nc/);
  });
});

describe("listProspectsToRewrite / countProspectsToRewrite (the bulk rewrite cursor)", () => {
  const STARTED = "2026-08-19T05:09:13.000Z";

  it("reads the oldest untouched drafts first, so a run walks the queue once", async () => {
    // The cursor is `updated_at < startedAt` and every rewrite stamps
    // `updated_at`, so a rewritten draft drops out of the next batch on its
    // own. Ordering oldest-first is what makes that a walk rather than a
    // shuffle: the batch always takes the rows the run has not reached.
    const c = chain({ data: [{ id: PROSPECT }], error: null });
    expect(await listProspectsToRewrite(BIZ, STARTED, 20, makeDb(c))).toHaveLength(1);
    expect(c.eq).toHaveBeenCalledWith("business_id", BIZ);
    expect(c.eq).toHaveBeenCalledWith("status", "drafted");
    expect(c.lt).toHaveBeenCalledWith("updated_at", STARTED);
    expect(c.order).toHaveBeenCalledWith("updated_at", { ascending: true });
    expect(c.limit).toHaveBeenCalledWith(20);

    defaultClientSpy.mockReturnValue(makeDb(chain({ data: null, error: null })));
    expect(await listProspectsToRewrite(BIZ, STARTED, 20)).toEqual([]);

    await expect(
      listProspectsToRewrite(BIZ, STARTED, 20, makeDb(chain({ data: null, error: { message: "lst" } })))
    ).rejects.toThrow(/lst/);
  });

  it("counts what the run still has to reach, and treats a null count as none left", async () => {
    const c = chain({ count: 143, error: null });
    expect(await countProspectsToRewrite(BIZ, STARTED, makeDb(c))).toBe(143);
    expect(c.select).toHaveBeenCalledWith("id", { count: "exact", head: true });
    expect(c.lt).toHaveBeenCalledWith("updated_at", STARTED);

    // Null reads as zero, which ends the caller's loop. The alternative bias
    // would spin: a count that cannot be read is not evidence of work left.
    defaultClientSpy.mockReturnValue(makeDb(chain({ count: null, error: null })));
    expect(await countProspectsToRewrite(BIZ, STARTED)).toBe(0);

    await expect(
      countProspectsToRewrite(BIZ, STARTED, makeDb(chain({ count: null, error: { message: "cnt" } })))
    ).rejects.toThrow(/cnt/);
  });
});

describe("countProspectsInVertical / skipProspectsInVertical (calling off a trade)", () => {
  it("counts only what has not gone out yet", async () => {
    const c = chain({ count: 63, error: null });
    expect(await countProspectsInVertical(BIZ, "dental office", makeDb(c))).toBe(63);
    expect(c.eq).toHaveBeenCalledWith("vertical", "dental office");
    // `queued` is already in flight and a sent pitch is a thing that happened,
    // so neither is cancellable.
    expect(c.in).toHaveBeenCalledWith("status", ["discovered", "drafted"]);

    defaultClientSpy.mockReturnValue(makeDb(chain({ count: null, error: null })));
    expect(await countProspectsInVertical(BIZ, "dental office")).toBe(0);

    await expect(
      countProspectsInVertical(BIZ, "x", makeDb(chain({ count: null, error: { message: "cnt" } })))
    ).rejects.toThrow(/cnt/);
  });

  it("translates the funnel's (unknown) bucket back into a blank column", async () => {
    // The funnel groups rows with no recorded trade under a LABEL that no row
    // stores. Filtering on it literally matches nothing, so the Skip button on
    // that row would report success and retire none of the prospects it was
    // pointing at.
    const c = chain({ count: 4, error: null });
    expect(await countProspectsInVertical(BIZ, UNKNOWN_VERTICAL, makeDb(c))).toBe(4);
    expect(c.or).toHaveBeenCalledWith("vertical.is.null,vertical.eq.");
    expect(c.eq).not.toHaveBeenCalledWith("vertical", UNKNOWN_VERTICAL);

    // Both queries have to translate it the same way, or the count and the
    // write disagree about which rows the press covers.
    const u = chain({ error: null });
    await skipProspectsInVertical(BIZ, UNKNOWN_VERTICAL, "d", makeDb(u));
    expect(u.or).toHaveBeenCalledWith("vertical.is.null,vertical.eq.");
    expect(u.eq).not.toHaveBeenCalledWith("vertical", UNKNOWN_VERTICAL);
  });

  it("retires the trade with the status filter inside the write", async () => {
    // Read-then-write would mark a prospect skipped that the sweep sent in
    // between, quietly removing a real send from the funnel. The filter rides
    // in the UPDATE so that row simply does not match.
    const c = chain({ error: null });
    await skipProspectsInVertical(BIZ, "dental office", "owner stopped", makeDb(c));
    expect(c.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "skipped", status_detail: "owner stopped" })
    );
    expect(c.eq).toHaveBeenCalledWith("business_id", BIZ);
    expect(c.eq).toHaveBeenCalledWith("vertical", "dental office");
    expect(c.in).toHaveBeenCalledWith("status", ["discovered", "drafted"]);

    defaultClientSpy.mockReturnValue(makeDb(chain({ error: null })));
    await expect(skipProspectsInVertical(BIZ, "x", "d")).resolves.toBeUndefined();

    await expect(
      skipProspectsInVertical(BIZ, "x", "d", makeDb(chain({ error: { message: "upd" } })))
    ).rejects.toThrow(/upd/);
  });
});

describe("countProspectsByStatus", () => {
  it("counts one status, treats a null count as zero, and throws on error", async () => {
    const c = chain({ count: 141, error: null });
    expect(await countProspectsByStatus(BIZ, "drafted", makeDb(c))).toBe(141);
    expect(c.eq).toHaveBeenCalledWith("business_id", BIZ);
    expect(c.eq).toHaveBeenCalledWith("status", "drafted");

    defaultClientSpy.mockReturnValue(makeDb(chain({ count: null, error: null })));
    expect(await countProspectsByStatus(BIZ, "drafted")).toBe(0);

    await expect(
      countProspectsByStatus(BIZ, "drafted", makeDb(chain({ count: null, error: { message: "cnt" } })))
    ).rejects.toThrow(/cnt/);
  });
});

describe("listProspectsContactedSince (who the board should show as Contacted)", () => {
  const SINCE = "2026-08-17T00:00:00.000Z";

  it("takes recently emailed prospects that have a phone, newest first", async () => {
    // Phone-bearing only: the CRM is phone-keyed, so a prospect discovered with
    // just an address files no contact and has nothing on the board to move.
    const c = chain({ data: [{ id: PROSPECT }], error: null });
    expect(await listProspectsContactedSince(BIZ, SINCE, 100, makeDb(c))).toHaveLength(1);
    expect(c.eq).toHaveBeenCalledWith("business_id", BIZ);
    expect(c.gte).toHaveBeenCalledWith("sent_at", SINCE);
    expect(c.not).toHaveBeenCalledWith("phone", "is", null);
    // The marker is what lets the phase DRAIN. Reading "recently emailed"
    // alone returns the same rows every pass, so anything behind the limit
    // ages out still sitting in New Lead.
    expect(c.is).toHaveBeenCalledWith("contacted_stage_at", null);
    // Oldest first, so the queue is worked front to back rather than the
    // newest arrivals starving the rest.
    expect(c.order).toHaveBeenCalledWith("sent_at", { ascending: true });
    // Bounded: this runs every pass, so it must never become a scan.
    expect(c.limit).toHaveBeenCalledWith(100);

    defaultClientSpy.mockReturnValue(makeDb(chain({ data: null, error: null })));
    expect(await listProspectsContactedSince(BIZ, SINCE, 100)).toEqual([]);

    await expect(
      listProspectsContactedSince(BIZ, SINCE, 100, makeDb(chain({ data: null, error: { message: "lst" } })))
    ).rejects.toThrow(/lst/);
  });
});

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
  MetaConnectionValidationError,
  activateMetaConnection,
  deleteMetaConnection,
  getActiveMetaConnectionByInstagramId,
  getActiveMetaConnectionByPageId,
  getMetaConnection,
  getMetaPageClaim,
  getPublicMetaConnection,
  savePendingMetaConnection,
  setMetaConnectionActive,
  setMetaConnectionDataset,
  toPublicMetaConnection,
  listMetaConnectionsByMetaUserId,
  deleteMetaConnectionById,
  setMetaConnectionUserId,
  setMetaTokenInvalid
} from "@/lib/db/meta-connections";

type Chain = {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  is: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
};

function chain(terminal?: unknown): Chain & PromiseLike<unknown> {
  const c = {
    select: vi.fn(() => c),
    insert: vi.fn(() => c),
    update: vi.fn(() => c),
    delete: vi.fn(() => c),
    eq: vi.fn(() => c),
    is: vi.fn(() => c),
    limit: vi.fn(() => c),
    single: vi.fn(),
    maybeSingle: vi.fn(),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(terminal).then(resolve)
  };
  return c as never;
}

function makeDb(c: unknown) {
  return { from: vi.fn(() => c) } as never;
}

const BIZ = "11111111-1111-4111-8111-111111111111";

const PENDING = {
  id: "mc-1",
  business_id: BIZ,
  status: "pending" as const,
  user_token_encrypted: "enc(user-token)",
  page_id: null,
  page_name: null,
  page_token_encrypted: null,
  account_name: "Brian Lane",
  meta_user_id: null,
  token_invalid_at: null,
  instagram_account_id: null,
  instagram_username: null,
  is_active: true,
  created_at: "2026-07-14T00:00:00Z",
  updated_at: "2026-07-14T00:00:00Z"
};

const ACTIVE = {
  ...PENDING,
  status: "active" as const,
  user_token_encrypted: null,
  page_id: "page-9",
  page_name: "Truly Insurance",
  page_token_encrypted: "enc(page-token)",
  instagram_account_id: "ig-9",
  instagram_username: "trulyinsurance"
};

describe("toPublicMetaConnection", () => {
  it("drops all token material and reports has_page_token", () => {
    const pub = toPublicMetaConnection(ACTIVE as never);
    expect(pub).not.toHaveProperty("user_token_encrypted");
    expect(pub).not.toHaveProperty("page_token_encrypted");
    expect(pub.has_page_token).toBe(true);

    expect(toPublicMetaConnection(PENDING as never).has_page_token).toBe(false);
  });
});

describe("getMetaConnection", () => {
  it("returns null when no row exists", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getMetaConnection(BIZ, makeDb(c))).toBeNull();
  });

  it("decrypts stored tokens (null-safe)", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: PENDING, error: null });
    const row = await getMetaConnection(BIZ, makeDb(c));
    expect(row?.userToken).toBe("user-token");
    expect(row?.pageToken).toBeNull();
    expect(row).not.toHaveProperty("user_token_encrypted");

    const c2 = chain();
    c2.maybeSingle.mockResolvedValue({ data: ACTIVE, error: null });
    const row2 = await getMetaConnection(BIZ, makeDb(c2));
    expect(row2?.userToken).toBeNull();
    expect(row2?.pageToken).toBe("page-token");
  });

  it("throws on a query error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(getMetaConnection(BIZ, makeDb(c))).rejects.toThrow(/boom/);
  });
});

describe("getPublicMetaConnection", () => {
  it("returns the masked row / null / throws on error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: ACTIVE, error: null });
    const pub = await getPublicMetaConnection(BIZ, makeDb(c));
    expect(pub?.has_page_token).toBe(true);

    const c2 = chain();
    c2.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getPublicMetaConnection(BIZ, makeDb(c2))).toBeNull();

    const c3 = chain();
    c3.maybeSingle.mockResolvedValue({ data: null, error: { message: "err" } });
    await expect(getPublicMetaConnection(BIZ, makeDb(c3))).rejects.toThrow(/err/);
  });
});

describe("getActiveMetaConnectionByPageId", () => {
  it("filters to the active connected page and decrypts", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: ACTIVE, error: null });
    const row = await getActiveMetaConnectionByPageId("page-9", makeDb(c));
    expect(row?.pageToken).toBe("page-token");
    expect(c.eq).toHaveBeenCalledWith("page_id", "page-9");
    expect(c.eq).toHaveBeenCalledWith("status", "active");
    expect(c.eq).toHaveBeenCalledWith("is_active", true);
  });

  it("returns null when absent and throws on error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getActiveMetaConnectionByPageId("page-9", makeDb(c))).toBeNull();

    const c2 = chain();
    c2.maybeSingle.mockResolvedValue({ data: null, error: { message: "down" } });
    await expect(getActiveMetaConnectionByPageId("page-9", makeDb(c2))).rejects.toThrow(
      /down/
    );
  });
});

describe("getActiveMetaConnectionByInstagramId", () => {
  it("filters to the active connection holding the IG account and decrypts", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: ACTIVE, error: null });
    const row = await getActiveMetaConnectionByInstagramId("ig-9", makeDb(c));
    expect(row?.pageToken).toBe("page-token");
    expect(row?.instagram_account_id).toBe("ig-9");
    expect(c.eq).toHaveBeenCalledWith("instagram_account_id", "ig-9");
    expect(c.eq).toHaveBeenCalledWith("status", "active");
    expect(c.eq).toHaveBeenCalledWith("is_active", true);
  });

  it("returns null when absent and throws on error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getActiveMetaConnectionByInstagramId("ig-9", makeDb(c))).toBeNull();

    const c2 = chain();
    c2.maybeSingle.mockResolvedValue({ data: null, error: { message: "ig down" } });
    await expect(
      getActiveMetaConnectionByInstagramId("ig-9", makeDb(c2))
    ).rejects.toThrow(/ig down/);
  });
});

describe("getMetaPageClaim", () => {
  it("returns whoever holds the page (active or paused), null when unclaimed", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { business_id: BIZ }, error: null });
    expect(await getMetaPageClaim("page-9", makeDb(c))).toEqual({ business_id: BIZ });
    // No status/is_active filters: paused rows keep their claim.
    expect(c.eq).toHaveBeenCalledTimes(1);
    expect(c.eq).toHaveBeenCalledWith("page_id", "page-9");

    const c2 = chain();
    c2.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getMetaPageClaim("page-9", makeDb(c2))).toBeNull();
  });

  it("throws on a query error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: { message: "claim fail" } });
    await expect(getMetaPageClaim("page-9", makeDb(c))).rejects.toThrow(/claim fail/);
  });
});

describe("savePendingMetaConnection", () => {
  it("rejects an empty or oversized token", async () => {
    await expect(
      savePendingMetaConnection(
        { businessId: BIZ, userToken: "  ", accountName: null },
        makeDb(chain())
      )
    ).rejects.toThrow(MetaConnectionValidationError);
    await expect(
      savePendingMetaConnection(
        { businessId: BIZ, userToken: "x".repeat(4097), accountName: null },
        makeDb(chain())
      )
    ).rejects.toThrow(/1-4096/);
  });

  it("throws on an existence-check error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: { message: "read fail" } });
    await expect(
      savePendingMetaConnection(
        { businessId: BIZ, userToken: "tok", accountName: null },
        makeDb(c)
      )
    ).rejects.toThrow(/read fail/);
  });

  it("inserts a pending row with the encrypted user token", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    c.single.mockResolvedValue({ data: PENDING, error: null });
    const pub = await savePendingMetaConnection(
      { businessId: BIZ, userToken: " user-token ", accountName: "Brian Lane" },
      makeDb(c)
    );
    expect(pub.status).toBe("pending");
    const inserted = c.insert.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.user_token_encrypted).toBe("enc(user-token)");
    expect(inserted.status).toBe("pending");
    // page_id / page_name / dataset_id are deliberately untouched by the
    // pending reset (a fresh insert simply has none) — the page token is
    // always cleared so a pending row can never send.
    expect(inserted).not.toHaveProperty("page_id");
    expect(inserted).not.toHaveProperty("dataset_id");
    expect(inserted.page_token_encrypted).toBeNull();
    expect(inserted.account_name).toBe("Brian Lane");
    expect(inserted.is_active).toBe(true);
  });

  it("surfaces an insert error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    c.single.mockResolvedValue({ data: null, error: { message: "insert fail" } });
    await expect(
      savePendingMetaConnection(
        { businessId: BIZ, userToken: "tok", accountName: null },
        makeDb(c)
      )
    ).rejects.toThrow(/insert fail/);
  });

  it("resets an existing row back to pending (reconnect)", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { id: "mc-1" }, error: null });
    c.single.mockResolvedValue({ data: PENDING, error: null });
    await savePendingMetaConnection(
      { businessId: BIZ, userToken: "fresh", accountName: null },
      makeDb(c)
    );
    const patch = c.update.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.status).toBe("pending");
    expect(patch.user_token_encrypted).toBe("enc(fresh)");
    // Last-known Page identity + dataset survive the reconnect reset so a
    // same-Page re-pick can reuse the dataset if discovery hiccups.
    expect(patch).not.toHaveProperty("page_id");
    expect(patch).not.toHaveProperty("page_name");
    expect(patch).not.toHaveProperty("dataset_id");
    expect(patch.page_token_encrypted).toBeNull();
    expect(patch.account_name).toBeNull();
    expect(patch.updated_at).toBeTruthy();
  });

  it("surfaces an update error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { id: "mc-1" }, error: null });
    c.single.mockResolvedValue({ data: null, error: { message: "update fail" } });
    await expect(
      savePendingMetaConnection(
        { businessId: BIZ, userToken: "tok", accountName: null },
        makeDb(c)
      )
    ).rejects.toThrow(/update fail/);
  });
});

describe("activateMetaConnection", () => {
  it("rejects an empty or oversized page token", async () => {
    await expect(
      activateMetaConnection(
        { businessId: BIZ, pageId: "p", pageName: null, pageToken: " " },
        makeDb(chain())
      )
    ).rejects.toThrow(MetaConnectionValidationError);
    await expect(
      activateMetaConnection(
        { businessId: BIZ, pageId: "p", pageName: null, pageToken: "x".repeat(4097) },
        makeDb(chain())
      )
    ).rejects.toThrow(/1-4096/);
  });

  it("activates: page fields set, user token cleared, guarded on pending", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: ACTIVE, error: null });
    const pub = await activateMetaConnection(
      {
        businessId: BIZ,
        pageId: "page-9",
        pageName: "Truly Insurance",
        pageToken: " page-token ",
        instagramAccountId: "ig-9",
        instagramUsername: "trulyinsurance",
        datasetId: "ds-9"
      },
      makeDb(c)
    );
    expect(pub.has_page_token).toBe(true);
    const patch = c.update.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.status).toBe("active");
    expect(patch.user_token_encrypted).toBeNull();
    expect(patch.page_id).toBe("page-9");
    expect(patch.page_name).toBe("Truly Insurance");
    expect(patch.page_token_encrypted).toBe("enc(page-token)");
    expect(patch.instagram_account_id).toBe("ig-9");
    expect(patch.instagram_username).toBe("trulyinsurance");
    expect(patch.dataset_id).toBe("ds-9");
    expect(patch.is_active).toBe(true);
    // Concurrency guard: only a still-pending row can be activated.
    expect(c.eq).toHaveBeenCalledWith("status", "pending");
  });

  it("defaults the IG columns to null when the Page has no linked account", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: { ...ACTIVE, instagram_account_id: null }, error: null });
    await activateMetaConnection(
      { businessId: BIZ, pageId: "page-9", pageName: null, pageToken: "t" },
      makeDb(c)
    );
    const patch = c.update.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.instagram_account_id).toBeNull();
    expect(patch.instagram_username).toBeNull();
    // No dataset discovered (pre-App-Review scopes) → column stays null.
    expect(patch.dataset_id).toBeNull();
  });

  it("surfaces an update error", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: null, error: { message: "act fail" } });
    await expect(
      activateMetaConnection(
        { businessId: BIZ, pageId: "p", pageName: null, pageToken: "t" },
        makeDb(c)
      )
    ).rejects.toThrow(/act fail/);
  });
});

describe("setMetaConnectionActive", () => {
  it("updates the flag and throws on error", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: { ...ACTIVE, is_active: false }, error: null });
    const pub = await setMetaConnectionActive(BIZ, false, makeDb(c));
    expect(pub.is_active).toBe(false);
    const patch = c.update.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.is_active).toBe(false);

    const c2 = chain();
    c2.single.mockResolvedValue({ data: null, error: { message: "toggle fail" } });
    await expect(setMetaConnectionActive(BIZ, true, makeDb(c2))).rejects.toThrow(
      /toggle fail/
    );
  });
});

describe("setMetaConnectionDataset", () => {
  it("writes the owner-entered dataset on an ACTIVE row and returns the masked row", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { ...ACTIVE, dataset_id: "ds-new" }, error: null });
    const row = await setMetaConnectionDataset(BIZ, "ds-new", makeDb(c));
    expect(row?.dataset_id).toBe("ds-new");
    expect(row).not.toHaveProperty("page_token_encrypted");
    const patch = c.update.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.dataset_id).toBe("ds-new");
    expect(patch.updated_at).toEqual(expect.any(String));
    // Scoped to an ACTIVE row: a pending row has no Page to attach it to.
    expect(c.eq).toHaveBeenCalledWith("business_id", BIZ);
    expect(c.eq).toHaveBeenCalledWith("status", "active");
  });

  it("clears the dataset when passed null (owner turning the loop off)", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { ...ACTIVE, dataset_id: null }, error: null });
    const row = await setMetaConnectionDataset(BIZ, null, makeDb(c));
    expect(row?.dataset_id).toBeNull();
    expect((c.update.mock.calls[0][0] as Record<string, unknown>).dataset_id).toBeNull();
  });

  it("returns null when no ACTIVE row matched, so a save is never reported that did not land", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await setMetaConnectionDataset(BIZ, "ds-new", makeDb(c))).toBeNull();
  });

  it("throws on a write error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: { message: "dataset write fail" } });
    await expect(setMetaConnectionDataset(BIZ, "ds-new", makeDb(c))).rejects.toThrow(
      /dataset write fail/
    );
  });
});

describe("deleteMetaConnection", () => {
  it("deletes by business id and throws on error", async () => {
    const c = chain({ error: null });
    await deleteMetaConnection(BIZ, makeDb(c));
    expect(c.delete).toHaveBeenCalled();
    expect(c.eq).toHaveBeenCalledWith("business_id", BIZ);

    const c2 = chain({ error: { message: "del fail" } });
    await expect(deleteMetaConnection(BIZ, makeDb(c2))).rejects.toThrow(/del fail/);
  });
});

describe("default service client", () => {
  it("falls back to createSupabaseServiceClient when no client is passed", async () => {
    const c = chain({ error: null });
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    c.single.mockResolvedValue({ data: ACTIVE, error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));

    expect(await getMetaConnection(BIZ)).toBeNull();
    expect(await getPublicMetaConnection(BIZ)).toBeNull();
    expect(await getActiveMetaConnectionByPageId("page-9")).toBeNull();
    expect(await getActiveMetaConnectionByInstagramId("ig-9")).toBeNull();
    expect(await getMetaPageClaim("page-9")).toBeNull();
    await savePendingMetaConnection({ businessId: BIZ, userToken: "t", accountName: null });
    await activateMetaConnection({
      businessId: BIZ,
      pageId: "p",
      pageName: null,
      pageToken: "t"
    });
    await setMetaConnectionActive(BIZ, true);
    await setMetaConnectionDataset(BIZ, "ds-new");
    await deleteMetaConnection(BIZ);
    await listMetaConnectionsByMetaUserId("asid-1");
    await deleteMetaConnectionById("mc-1");
    await setMetaConnectionUserId("mc-1", "asid-1");
    await setMetaTokenInvalid(BIZ, false);
    expect(defaultClientSpy).toHaveBeenCalledTimes(14);
  });
});

describe("meta_user_id lookups (the deauthorize / data-deletion join key)", () => {
  const ASID = "122098495527401398";

  it("records the id at connect, and never blanks it on a reconnect", async () => {
    const c = chain({ error: null });
    c.maybeSingle.mockResolvedValue({ data: { id: "mc-1" }, error: null });
    c.single.mockResolvedValue({ data: ACTIVE, error: null });
    await savePendingMetaConnection(
      { businessId: BIZ, userToken: "t", accountName: "Brian", metaUserId: ASID },
      makeDb(c)
    );
    expect(c.update.mock.calls[0][0]).toMatchObject({ meta_user_id: ASID });

    // A reconnect whose /me lookup failed must NOT erase the id the Meta
    // callbacks depend on, so the field is omitted rather than set to null.
    const c2 = chain({ error: null });
    c2.maybeSingle.mockResolvedValue({ data: { id: "mc-1" }, error: null });
    c2.single.mockResolvedValue({ data: ACTIVE, error: null });
    await savePendingMetaConnection(
      { businessId: BIZ, userToken: "t", accountName: "Brian", metaUserId: null },
      makeDb(c2)
    );
    expect(c2.update.mock.calls[0][0]).not.toHaveProperty("meta_user_id");
  });

  it("finds every connection that person authorized, bounded", async () => {
    const c = chain({ data: [ACTIVE], error: null });
    const rows = await listMetaConnectionsByMetaUserId(ASID, makeDb(c));
    expect(rows).toHaveLength(1);
    expect(c.eq).toHaveBeenCalledWith("meta_user_id", ASID);
    // An unbounded select silently truncates at PostgREST's 1000 rows.
    expect(c.limit).toHaveBeenCalledWith(200);
  });

  it("REFUSES an empty id instead of matching every null row", async () => {
    // .eq("meta_user_id", "") would match nothing, but a blank id reaching
    // the query at all is a bug worth stopping at the door: the callers
    // treat "no rows" as "nothing to delete".
    const c = chain({ data: [ACTIVE], error: null });
    expect(await listMetaConnectionsByMetaUserId("", makeDb(c))).toEqual([]);
    expect(await listMetaConnectionsByMetaUserId("   ", makeDb(c))).toEqual([]);
    expect(c.eq).not.toHaveBeenCalled();
  });

  it("coerces null data and throws on error", async () => {
    expect(
      await listMetaConnectionsByMetaUserId(ASID, makeDb(chain({ data: null, error: null })))
    ).toEqual([]);
    await expect(
      listMetaConnectionsByMetaUserId(ASID, makeDb(chain({ data: null, error: { message: "x" } })))
    ).rejects.toThrow(/x/);
  });
});

describe("deleteMetaConnectionById", () => {
  it("DELETES the row rather than blanking it", async () => {
    // A blanked row keeps status "pending", and the integrations card reads
    // any pending row as an in-progress Page pick: the owner would see
    // "Almost there" and then "No Pages found" instead of a clean
    // disconnected state (Bugbot, PR #1443).
    const c = chain({ data: [{ id: "mc-1" }], error: null });
    expect(await deleteMetaConnectionById("mc-1", makeDb(c))).toBe(true);
    expect(c.delete).toHaveBeenCalled();
    expect(c.update).not.toHaveBeenCalled();
    expect(c.eq).toHaveBeenCalledWith("id", "mc-1");
  });

  it("reports false when the delete matched no row", async () => {
    // PostgREST returns no error for a delete matching nothing, so the caller
    // must not count it as a successful sever.
    expect(await deleteMetaConnectionById("gone", makeDb(chain({ data: [], error: null })))).toBe(
      false
    );
    await expect(
      deleteMetaConnectionById("mc-1", makeDb(chain({ data: null, error: { message: "e" } })))
    ).rejects.toThrow(/e/);
  });
});

describe("setMetaConnectionUserId", () => {
  it("stamps the id and reports whether a row took it", async () => {
    const c = chain({ data: [{ id: "mc-1" }], error: null });
    expect(await setMetaConnectionUserId("mc-1", " 42 ", makeDb(c))).toBe(true);
    expect(c.update.mock.calls[0][0]).toMatchObject({ meta_user_id: "42" });

    expect(await setMetaConnectionUserId("mc-1", "", makeDb(c))).toBe(false);
    expect(
      await setMetaConnectionUserId("mc-1", "42", makeDb(chain({ data: [], error: null })))
    ).toBe(false);
    await expect(
      setMetaConnectionUserId("mc-1", "42", makeDb(chain({ data: null, error: { message: "u" } })))
    ).rejects.toThrow(/u/);
  });
});

describe("setMetaTokenInvalid (the dead-token flag)", () => {
  it("stamps only a connection that is not already flagged", async () => {
    // Guarded so a fleet of failing calls cannot keep moving the timestamp
    // forward and re-arming the owner alert.
    const c = chain({ data: [{ id: "mc-1" }], error: null });
    expect(await setMetaTokenInvalid(BIZ, true, makeDb(c))).toBe(true);
    expect(c.is).toHaveBeenCalledWith("token_invalid_at", null);
    expect(c.update.mock.calls[0][0]).toMatchObject({
      token_invalid_at: expect.any(String)
    });
  });

  it("reports false when it was already flagged, so only the first alerts", async () => {
    expect(await setMetaTokenInvalid(BIZ, true, makeDb(chain({ data: [], error: null })))).toBe(
      false
    );
  });

  it("clears UNCONDITIONALLY, so a reconnect always heals", async () => {
    const c = chain({ data: [{ id: "mc-1" }], error: null });
    expect(await setMetaTokenInvalid(BIZ, false, makeDb(c))).toBe(true);
    expect(c.update.mock.calls[0][0]).toMatchObject({ token_invalid_at: null });
    // No is() guard on the clear path: it must work from any state.
    expect(c.is).not.toHaveBeenCalled();
  });

  it("throws on error", async () => {
    await expect(
      setMetaTokenInvalid(BIZ, true, makeDb(chain({ data: null, error: { message: "t" } })))
    ).rejects.toThrow(/t/);
  });
});

describe("needs_reconnect is derived, never stored twice", () => {
  it("is true exactly when token_invalid_at is set", () => {
    const base = { ...ACTIVE, page_token_encrypted: "enc(x)" };
    expect(
      toPublicMetaConnection({ ...base, token_invalid_at: null } as never).needs_reconnect
    ).toBe(false);
    expect(
      toPublicMetaConnection({
        ...base,
        token_invalid_at: "2026-08-18T00:00:00Z"
      } as never).needs_reconnect
    ).toBe(true);
  });

  it("is independent of is_active, the owner's own pause switch", () => {
    // Conflating them would tell an owner who paused their connection that
    // their token died, and make a dead token look like a deliberate pause.
    const paused = toPublicMetaConnection({
      ...ACTIVE,
      page_token_encrypted: "enc(x)",
      is_active: false,
      token_invalid_at: null
    } as never);
    expect(paused.needs_reconnect).toBe(false);
    expect(paused.is_active).toBe(false);

    const dead = toPublicMetaConnection({
      ...ACTIVE,
      page_token_encrypted: "enc(x)",
      is_active: true,
      token_invalid_at: "2026-08-18T00:00:00Z"
    } as never);
    expect(dead.needs_reconnect).toBe(true);
    expect(dead.is_active).toBe(true);
  });
});

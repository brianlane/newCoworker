/**
 * Instagram posts DB access (src/lib/social/db.ts): success + error paths
 * for every helper and the guarded lifecycle transitions — mirrors the
 * email-campaigns db suite.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import {
  deleteSocialPost,
  getSocialPost,
  insertSocialPost,
  listDueScheduledPosts,
  listPublishingPosts,
  listSocialPosts,
  patchSocialPost,
  transitionSocialPost
} from "@/lib/social/db";

const BIZ = "11111111-1111-4111-8111-111111111111";
const POST = "33333333-3333-4333-8333-333333333333";

type Chain = Record<string, ReturnType<typeof vi.fn>> & PromiseLike<unknown>;

function chain(terminal?: unknown): Chain {
  const c: Record<string, unknown> = {};
  for (const m of ["select", "insert", "update", "delete", "eq", "neq", "lte", "order", "limit"]) {
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listSocialPosts / getSocialPost", () => {
  it("lists (explicit client) and gets (default client)", async () => {
    const c = chain({ data: [{ id: POST }], error: null });
    expect(await listSocialPosts(BIZ, makeDb(c))).toEqual([{ id: POST }]);

    const g = chain();
    g.maybeSingle.mockResolvedValue({ data: { id: POST }, error: null });
    defaultClientSpy.mockReturnValue(makeDb(g));
    expect(await getSocialPost(BIZ, POST)).toEqual({ id: POST });
  });

  it("null payloads coerce and errors throw", async () => {
    const empty = chain({ data: null, error: null });
    expect(await listSocialPosts(BIZ, makeDb(empty))).toEqual([]);
    const g = chain();
    g.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getSocialPost(BIZ, POST, makeDb(g))).toBeNull();

    await expect(
      listSocialPosts(BIZ, makeDb(chain({ data: null, error: { message: "l" } })))
    ).rejects.toThrow(/l/);
    const ge = chain();
    ge.maybeSingle.mockResolvedValue({ data: null, error: { message: "g" } });
    await expect(getSocialPost(BIZ, POST, makeDb(ge))).rejects.toThrow(/g/);
  });
});

describe("insert / patch / delete", () => {
  const row = { business_id: BIZ, caption: "c", media_url: "https://x.test/a.jpg" };

  it("inserts and returns the row; throws on error", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: { id: POST, ...row }, error: null });
    expect(await insertSocialPost(row, makeDb(c))).toMatchObject({ id: POST });

    const e = chain();
    e.single.mockResolvedValue({ data: null, error: { message: "ins" } });
    await expect(insertSocialPost(row, makeDb(e))).rejects.toThrow(/ins/);
  });

  it("patches with updated_at and deletes; throws on errors", async () => {
    const c = chain({ error: null });
    await patchSocialPost(BIZ, POST, { caption: "t" }, makeDb(c));
    expect(c.update).toHaveBeenCalledWith(
      expect.objectContaining({ caption: "t", updated_at: expect.any(String) })
    );
    await expect(
      patchSocialPost(BIZ, POST, {}, makeDb(chain({ error: { message: "p" } })))
    ).rejects.toThrow(/p/);

    const del = chain({ data: [{ id: POST }], error: null });
    expect(await deleteSocialPost(BIZ, POST, makeDb(del))).toBe(true);
    // The delete is status-guarded: a mid-publish post survives.
    expect(del.neq).toHaveBeenCalledWith("status", "publishing");
    const guarded = chain({ data: [], error: null });
    expect(await deleteSocialPost(BIZ, POST, makeDb(guarded))).toBe(false);
    await expect(
      deleteSocialPost(BIZ, POST, makeDb(chain({ data: null, error: { message: "d" } })))
    ).rejects.toThrow(/d/);
  });
});

describe("transitionSocialPost", () => {
  it("reports whether the guarded transition moved a row", async () => {
    const moved = chain({ data: [{ id: POST }], error: null });
    expect(
      await transitionSocialPost(BIZ, POST, "scheduled", { status: "publishing" }, makeDb(moved))
    ).toBe(true);
    expect(moved.eq).toHaveBeenCalledWith("status", "scheduled");

    const lost = chain({ data: [], error: null });
    expect(
      await transitionSocialPost(BIZ, POST, "scheduled", { status: "publishing" }, makeDb(lost))
    ).toBe(false);

    await expect(
      transitionSocialPost(
        BIZ,
        POST,
        "scheduled",
        { status: "publishing" },
        makeDb(chain({ data: null, error: { message: "t" } }))
      )
    ).rejects.toThrow(/t/);
  });
});

describe("due / in-flight scans", () => {
  it("filters by status (+ time for due) and coerces null data", async () => {
    const due = chain({ data: [{ id: POST }], error: null });
    expect(await listDueScheduledPosts("2026-07-18T00:00:00Z", makeDb(due))).toHaveLength(1);
    expect(due.eq).toHaveBeenCalledWith("status", "scheduled");
    expect(due.lte).toHaveBeenCalledWith("publish_at", "2026-07-18T00:00:00Z");

    const inFlight = chain({ data: null, error: null });
    expect(await listPublishingPosts(makeDb(inFlight))).toEqual([]);
    expect(inFlight.eq).toHaveBeenCalledWith("status", "publishing");

    const dueNull = chain({ data: null, error: null });
    expect(await listDueScheduledPosts("2026-07-18T00:00:00Z", makeDb(dueNull))).toEqual([]);

    await expect(
      listDueScheduledPosts("x", makeDb(chain({ data: null, error: { message: "due" } })))
    ).rejects.toThrow(/due/);
    await expect(
      listPublishingPosts(makeDb(chain({ data: null, error: { message: "st" } })))
    ).rejects.toThrow(/st/);
  });
});

describe("default-client paths", () => {
  it("every helper resolves the service client when none is injected", async () => {
    const listChain = chain({ data: [], error: null });
    defaultClientSpy.mockReturnValue(makeDb(listChain));
    await listSocialPosts(BIZ);
    await listDueScheduledPosts("2026-07-18T00:00:00Z");
    await listPublishingPosts();
    await patchSocialPost(BIZ, POST, { caption: "t" });
    await transitionSocialPost(BIZ, POST, "draft", { status: "cancelled" });
    await deleteSocialPost(BIZ, POST);

    const insChain = chain();
    insChain.single.mockResolvedValue({ data: { id: POST }, error: null });
    defaultClientSpy.mockReturnValue(makeDb(insChain));
    await insertSocialPost({ business_id: BIZ, caption: "", media_url: "https://x.test/a.jpg" });
    expect(defaultClientSpy).toHaveBeenCalled();
  });
});

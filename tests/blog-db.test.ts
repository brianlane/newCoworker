/**
 * Blog DB access (src/lib/blog/db.ts): success + error paths for every
 * helper, the guarded lifecycle transition, the single-row settings
 * defaults, and the public image URL builder — mirrors the social-db
 * suite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import {
  BLOG_CATEGORIES,
  blogImagePublicUrl,
  blogSlugExists,
  countPublishedPosts,
  DEFAULT_BLOG_SETTINGS,
  deleteBlogPost,
  getBlogPost,
  getBlogSettings,
  getLatestWeeklyDigestPost,
  getPostByDigestWeek,
  getPublishedPostBySlug,
  insertBlogPost,
  listActiveBlogSubscribers,
  listDueScheduledBlogPosts,
  listPostsAdmin,
  listPublishedCategories,
  listPublishedPosts,
  listRelatedPosts,
  patchBlogPost,
  transitionBlogPost,
  unsubscribeBlogSubscriberByToken,
  updateBlogSettings,
  upsertBlogSubscriber
} from "@/lib/blog/db";

const POST = "33333333-3333-4333-8333-333333333333";

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
    "lte",
    "is",
    "order",
    "limit",
    "range"
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

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("blogImagePublicUrl", () => {
  it("returns null for empty paths", () => {
    expect(blogImagePublicUrl(null)).toBeNull();
    expect(blogImagePublicUrl("")).toBeNull();
  });

  it("builds the public bucket URL, trimming a trailing slash off the base", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://proj.supabase.co/");
    expect(blogImagePublicUrl("cover.png")).toBe(
      "https://proj.supabase.co/storage/v1/object/public/blog-images/cover.png"
    );
  });

  it("tolerates a missing base env", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", undefined);
    expect(blogImagePublicUrl("cover.png")).toBe(
      "/storage/v1/object/public/blog-images/cover.png"
    );
  });
});

describe("public reads", () => {
  it("lists published posts (default client), with and without a category filter", async () => {
    const c = chain({ data: [{ id: POST }], error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));
    expect(await listPublishedPosts({ limit: 9, offset: 0 })).toEqual([{ id: POST }]);
    expect(c.eq).toHaveBeenCalledTimes(1);

    const filtered = chain({ data: null, error: null });
    expect(
      await listPublishedPosts({ category: "feature", limit: 9, offset: 9 }, makeDb(filtered))
    ).toEqual([]);
    expect(filtered.eq).toHaveBeenCalledWith("category", "feature");
    expect(filtered.range).toHaveBeenCalledWith(9, 17);
  });

  it("listPublishedPosts throws on error", async () => {
    const c = chain({ data: null, error: { message: "boom" } });
    await expect(listPublishedPosts({ limit: 9, offset: 0 }, makeDb(c))).rejects.toThrow(
      "listPublishedPosts: boom"
    );
  });

  it("counts published posts, with filter and null-count coercion", async () => {
    const c = chain({ count: 4, error: null });
    expect(await countPublishedPosts("tutorial", makeDb(c))).toBe(4);
    expect(c.eq).toHaveBeenCalledWith("category", "tutorial");

    const empty = chain({ count: null, error: null });
    expect(await countPublishedPosts(undefined, makeDb(empty))).toBe(0);

    const bad = chain({ count: null, error: { message: "boom" } });
    await expect(countPublishedPosts(undefined, makeDb(bad))).rejects.toThrow(
      "countPublishedPosts: boom"
    );
  });

  it("lists distinct published categories in canonical order", async () => {
    const c = chain({
      data: [{ category: "spotlight" }, { category: "feature" }, { category: "feature" }],
      error: null
    });
    expect(await listPublishedCategories(makeDb(c))).toEqual(["feature", "spotlight"]);

    const empty = chain({ data: null, error: null });
    expect(await listPublishedCategories(makeDb(empty))).toEqual([]);

    const bad = chain({ data: null, error: { message: "boom" } });
    await expect(listPublishedCategories(makeDb(bad))).rejects.toThrow(
      "listPublishedCategories: boom"
    );
  });

  it("gets a published post by slug (found, missing, error)", async () => {
    const found = chain();
    found.maybeSingle.mockResolvedValue({ data: { id: POST }, error: null });
    expect(await getPublishedPostBySlug("s", makeDb(found))).toEqual({ id: POST });

    const missing = chain();
    missing.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getPublishedPostBySlug("s", makeDb(missing))).toBeNull();

    const bad = chain();
    bad.maybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(getPublishedPostBySlug("s", makeDb(bad))).rejects.toThrow(
      "getPublishedPostBySlug: boom"
    );
  });

  it("lists related posts and throws on error", async () => {
    const c = chain({ data: [{ id: "r1" }], error: null });
    expect(await listRelatedPosts("feature", POST, 3, makeDb(c))).toEqual([{ id: "r1" }]);
    expect(c.neq).toHaveBeenCalledWith("id", POST);

    const empty = chain({ data: null, error: null });
    expect(await listRelatedPosts("feature", POST, 3, makeDb(empty))).toEqual([]);

    const bad = chain({ data: null, error: { message: "boom" } });
    await expect(listRelatedPosts("feature", POST, 3, makeDb(bad))).rejects.toThrow(
      "listRelatedPosts: boom"
    );
  });
});

describe("admin CRUD", () => {
  it("lists all posts and throws on error", async () => {
    const c = chain({ data: [{ id: POST }], error: null });
    expect(await listPostsAdmin(makeDb(c))).toEqual([{ id: POST }]);

    const empty = chain({ data: null, error: null });
    expect(await listPostsAdmin(makeDb(empty))).toEqual([]);

    const bad = chain({ data: null, error: { message: "boom" } });
    await expect(listPostsAdmin(makeDb(bad))).rejects.toThrow("listPostsAdmin: boom");
  });

  it("probes slug existence (taken, free, error)", async () => {
    const taken = chain();
    taken.maybeSingle.mockResolvedValue({ data: { id: POST }, error: null });
    expect(await blogSlugExists("s", makeDb(taken))).toBe(true);

    const free = chain();
    free.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await blogSlugExists("s", makeDb(free))).toBe(false);

    const bad = chain();
    bad.maybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(blogSlugExists("s", makeDb(bad))).rejects.toThrow("blogSlugExists: boom");
  });

  it("gets one post (found, missing, error)", async () => {
    const found = chain();
    found.maybeSingle.mockResolvedValue({ data: { id: POST }, error: null });
    expect(await getBlogPost(POST, makeDb(found))).toEqual({ id: POST });

    const missing = chain();
    missing.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getBlogPost(POST, makeDb(missing))).toBeNull();

    const bad = chain();
    bad.maybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(getBlogPost(POST, makeDb(bad))).rejects.toThrow("getBlogPost: boom");
  });

  it("inserts a post and throws on error", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: { id: POST }, error: null });
    expect(await insertBlogPost({ slug: "s", title: "T" }, makeDb(c))).toEqual({ id: POST });

    const bad = chain();
    bad.single.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(insertBlogPost({ slug: "s", title: "T" }, makeDb(bad))).rejects.toThrow(
      "insertBlogPost: boom"
    );
  });

  it("patches and deletes, throwing on error", async () => {
    const ok = chain({ error: null });
    await patchBlogPost(POST, { title: "New" }, makeDb(ok));
    expect(ok.update).toHaveBeenCalled();

    const badPatch = chain({ error: { message: "boom" } });
    await expect(patchBlogPost(POST, {}, makeDb(badPatch))).rejects.toThrow(
      "patchBlogPost: boom"
    );

    const del = chain({ error: null });
    await deleteBlogPost(POST, makeDb(del));
    expect(del.delete).toHaveBeenCalled();

    const badDel = chain({ error: { message: "boom" } });
    await expect(deleteBlogPost(POST, makeDb(badDel))).rejects.toThrow("deleteBlogPost: boom");
  });
});

describe("publish sweep helpers", () => {
  it("lists due scheduled posts and throws on error", async () => {
    const c = chain({ data: [{ id: POST }], error: null });
    expect(await listDueScheduledBlogPosts("2026-01-01T00:00:00Z", makeDb(c))).toEqual([
      { id: POST }
    ]);
    expect(c.lte).toHaveBeenCalledWith("scheduled_for", "2026-01-01T00:00:00Z");

    const empty = chain({ data: null, error: null });
    expect(await listDueScheduledBlogPosts("t", makeDb(empty))).toEqual([]);

    const bad = chain({ data: null, error: { message: "boom" } });
    await expect(listDueScheduledBlogPosts("t", makeDb(bad))).rejects.toThrow(
      "listDueScheduledBlogPosts: boom"
    );
  });

  it("guards lifecycle transitions (won, lost, error)", async () => {
    const won = chain({ data: [{ id: POST }], error: null });
    expect(await transitionBlogPost(POST, "scheduled", { status: "published" }, makeDb(won))).toBe(
      true
    );
    expect(won.eq).toHaveBeenCalledWith("status", "scheduled");

    const lost = chain({ data: [], error: null });
    expect(
      await transitionBlogPost(POST, "scheduled", { status: "published" }, makeDb(lost))
    ).toBe(false);

    const nullData = chain({ data: null, error: null });
    expect(
      await transitionBlogPost(POST, "scheduled", { status: "published" }, makeDb(nullData))
    ).toBe(false);

    const bad = chain({ data: null, error: { message: "boom" } });
    await expect(
      transitionBlogPost(POST, "scheduled", { status: "published" }, makeDb(bad))
    ).rejects.toThrow("transitionBlogPost: boom");
  });

  it("finds the latest weekly-digest post (found, missing, error)", async () => {
    const found = chain();
    found.maybeSingle.mockResolvedValue({ data: { id: POST }, error: null });
    expect(await getLatestWeeklyDigestPost(makeDb(found))).toEqual({ id: POST });
    expect(found.eq).toHaveBeenCalledWith("source", "weekly_digest");

    const missing = chain();
    missing.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getLatestWeeklyDigestPost(makeDb(missing))).toBeNull();

    const bad = chain();
    bad.maybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(getLatestWeeklyDigestPost(makeDb(bad))).rejects.toThrow(
      "getLatestWeeklyDigestPost: boom"
    );
  });

  it("finds a digest post by week (found, missing, error)", async () => {
    const found = chain();
    found.maybeSingle.mockResolvedValue({ data: { id: POST }, error: null });
    expect(await getPostByDigestWeek("2026-W30", makeDb(found))).toEqual({ id: POST });

    const missing = chain();
    missing.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getPostByDigestWeek("2026-W30", makeDb(missing))).toBeNull();

    const bad = chain();
    bad.maybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(getPostByDigestWeek("2026-W30", makeDb(bad))).rejects.toThrow(
      "getPostByDigestWeek: boom"
    );
  });
});

describe("settings", () => {
  it("returns defaults when the row is missing and maps the row when present", async () => {
    const missing = chain();
    missing.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getBlogSettings(makeDb(missing))).toEqual(DEFAULT_BLOG_SETTINGS);

    const present = chain();
    present.maybeSingle.mockResolvedValue({
      data: {
        digest_enabled: false,
        digest_as_draft: true,
        digest_include_image: false,
        instagram_business_id: "biz-1",
        instagram_publish_immediately: true,
        extra_column: "ignored"
      },
      error: null
    });
    expect(await getBlogSettings(makeDb(present))).toEqual({
      digest_enabled: false,
      digest_as_draft: true,
      digest_include_image: false,
      instagram_business_id: "biz-1",
      instagram_publish_immediately: true
    });

    const bad = chain();
    bad.maybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(getBlogSettings(makeDb(bad))).rejects.toThrow("getBlogSettings: boom");
  });

  it("upserts settings on the fixed row and throws on error", async () => {
    const ok = chain({ error: null });
    await updateBlogSettings({ digest_enabled: false }, makeDb(ok));
    expect(ok.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ id: true, digest_enabled: false }),
      { onConflict: "id" }
    );

    const bad = chain({ error: { message: "boom" } });
    await expect(updateBlogSettings({}, makeDb(bad))).rejects.toThrow(
      "updateBlogSettings: boom"
    );
  });
});

describe("subscribers", () => {
  it("upserts a subscriber (re-subscribe clears unsubscribed_at) and throws on error", async () => {
    const ok = chain({ error: null });
    await upsertBlogSubscriber("a@b.co", "es", "tok", makeDb(ok));
    expect(ok.upsert).toHaveBeenCalledWith(
      { email: "a@b.co", locale: "es", unsubscribe_token: "tok", unsubscribed_at: null },
      { onConflict: "email" }
    );

    const bad = chain({ error: { message: "boom" } });
    await expect(upsertBlogSubscriber("a@b.co", "en", "tok", makeDb(bad))).rejects.toThrow(
      "upsertBlogSubscriber: boom"
    );
  });

  it("unsubscribes by token (matched, unmatched, error)", async () => {
    const matched = chain({ data: [{ id: "s1" }], error: null });
    expect(await unsubscribeBlogSubscriberByToken("tok", makeDb(matched))).toBe(true);

    const unmatched = chain({ data: [], error: null });
    expect(await unsubscribeBlogSubscriberByToken("tok", makeDb(unmatched))).toBe(false);

    const bad = chain({ data: null, error: { message: "boom" } });
    await expect(unsubscribeBlogSubscriberByToken("tok", makeDb(bad))).rejects.toThrow(
      "unsubscribeBlogSubscriberByToken: boom"
    );
  });

  it("lists active subscribers and throws on error", async () => {
    const c = chain({ data: [{ email: "a@b.co" }], error: null });
    expect(await listActiveBlogSubscribers(makeDb(c))).toEqual([{ email: "a@b.co" }]);
    expect(c.is).toHaveBeenCalledWith("unsubscribed_at", null);

    const empty = chain({ data: null, error: null });
    expect(await listActiveBlogSubscribers(makeDb(empty))).toEqual([]);

    const bad = chain({ data: null, error: { message: "boom" } });
    await expect(listActiveBlogSubscribers(makeDb(bad))).rejects.toThrow(
      "listActiveBlogSubscribers: boom"
    );
  });
});

describe("constants", () => {
  it("exposes the category vocabulary", () => {
    expect(BLOG_CATEGORIES).toContain("platform-updates");
  });
});

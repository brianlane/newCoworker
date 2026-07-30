import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/blog/db", () => ({
  listPublishedPosts: vi.fn(),
  countPublishedPosts: vi.fn(),
  listPublishedCategories: vi.fn(),
  getPublishedPostBySlug: vi.fn(),
  listRelatedPosts: vi.fn()
}));

import {
  countPublishedPosts,
  getPublishedPostBySlug,
  listPublishedCategories,
  listPublishedPosts,
  listRelatedPosts
} from "@/lib/blog/db";
import {
  countPublishedPostsIsr,
  getPublishedPostBySlugIsr,
  listPublishedCategoriesIsr,
  listPublishedPostsIsr,
  listRelatedPostsIsr
} from "@/lib/blog/public-isr";

describe("blog public-isr soft fallback", () => {
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  });

  it("returns empty data when the service-role key is absent (CI build)", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    await expect(listPublishedPostsIsr({ limit: 10, offset: 0 })).resolves.toEqual([]);
    await expect(countPublishedPostsIsr()).resolves.toBe(0);
    await expect(listPublishedCategoriesIsr()).resolves.toEqual([]);
    await expect(getPublishedPostBySlugIsr("any")).resolves.toBeNull();
    await expect(listRelatedPostsIsr("feature", "id", 3)).resolves.toEqual([]);
    expect(listPublishedPosts).not.toHaveBeenCalled();
  });

  it("delegates to the real DB helpers when the service-role key is set", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
    vi.mocked(listPublishedPosts).mockResolvedValue([{ id: "1" } as never]);
    vi.mocked(countPublishedPosts).mockResolvedValue(4);
    vi.mocked(listPublishedCategories).mockResolvedValue(["feature"] as never);
    vi.mocked(getPublishedPostBySlug).mockResolvedValue({ id: "1", slug: "hi" } as never);
    vi.mocked(listRelatedPosts).mockResolvedValue([{ id: "2" } as never]);

    await expect(listPublishedPostsIsr({ limit: 10, offset: 0 })).resolves.toEqual([{ id: "1" }]);
    await expect(countPublishedPostsIsr("feature")).resolves.toBe(4);
    await expect(listPublishedCategoriesIsr()).resolves.toEqual(["feature"]);
    await expect(getPublishedPostBySlugIsr("hi")).resolves.toEqual({ id: "1", slug: "hi" });
    await expect(listRelatedPostsIsr("feature", "1", 3)).resolves.toEqual([{ id: "2" }]);
  });
});

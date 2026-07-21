/**
 * Blog slugs (src/lib/blog/slug.ts): normalization, diacritics folding,
 * length cap, and the uniqueness counter.
 */
import { describe, expect, it } from "vitest";
import { slugifyBlogTitle, uniqueBlogSlug } from "@/lib/blog/slug";

describe("slugifyBlogTitle", () => {
  it("lowercases, hyphenates, and trims punctuation", () => {
    expect(slugifyBlogTitle("Hello, World! It's Live")).toBe("hello-world-it-s-live");
  });

  it("folds diacritics to base letters", () => {
    expect(slugifyBlogTitle("Añadir traducción rápida")).toBe("anadir-traduccion-rapida");
  });

  it("caps at 80 chars without a trailing hyphen", () => {
    const slug = slugifyBlogTitle(`${"word ".repeat(30)}end`);
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("returns empty for symbol-only titles", () => {
    expect(slugifyBlogTitle("!!!")).toBe("");
  });
});

describe("uniqueBlogSlug", () => {
  it("returns the base slug when free", async () => {
    expect(await uniqueBlogSlug("My Post", async () => false)).toBe("my-post");
  });

  it("counts up past taken slugs", async () => {
    const taken = new Set(["my-post", "my-post-2"]);
    expect(await uniqueBlogSlug("My Post", async (s) => taken.has(s))).toBe("my-post-3");
  });

  it("falls back to 'post' for empty titles", async () => {
    expect(await uniqueBlogSlug("!!!", async () => false)).toBe("post");
  });
});

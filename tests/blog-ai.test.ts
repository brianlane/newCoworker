/**
 * Blog AI assist (src/lib/blog/ai.ts): draft/translate JSON contracts,
 * category fallback, image upload paths, and Gemini env resolution.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => ({}))
}));

import {
  draftBlogPostWithAi,
  generateBlogImageWithAi,
  translateBlogPostWithAi
} from "@/lib/blog/ai";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("draftBlogPostWithAi", () => {
  it("returns the drafted fields and passes the topic through", async () => {
    vi.stubEnv("GOOGLE_API_KEY", "g-key");
    vi.stubEnv("BLOG_DIGEST_TEXT_MODEL", "gemini-test");
    const generate = vi.fn().mockResolvedValue(
      JSON.stringify({
        title: "T",
        excerpt: "E",
        content: "## C",
        category: "tutorial"
      })
    );
    const draft = await draftBlogPostWithAi("write about booking", generate as never);
    expect(draft).toEqual({ title: "T", excerpt: "E", content: "## C", category: "tutorial" });
    const params = generate.mock.calls[0][0];
    expect(params.apiKey).toBe("g-key");
    expect(params.model).toBe("gemini-test");
    expect(params.userText).toBe("write about booking");
  });

  it("falls back to 'announcement' for an unknown category", async () => {
    vi.stubEnv("GOOGLE_API_KEY", undefined);
    vi.stubEnv("GEMINI_API_KEY", "alt-key");
    const generate = vi.fn().mockResolvedValue(
      JSON.stringify({ title: "T", excerpt: "E", content: "C", category: "not-a-category" })
    );
    const draft = await draftBlogPostWithAi("topic", generate as never);
    expect(draft.category).toBe("announcement");
    expect(generate.mock.calls[0][0].apiKey).toBe("alt-key");
  });

  it("throws when fields are missing", async () => {
    const generate = vi.fn().mockResolvedValue(JSON.stringify({ title: "only" }));
    await expect(draftBlogPostWithAi("topic", generate as never)).rejects.toThrow(
      "blog-ai: draft response missing fields"
    );
  });
});

describe("translateBlogPostWithAi", () => {
  const post = { title: "T", excerpt: "E", content: "## C" };

  it("returns the Spanish fields", async () => {
    const generate = vi.fn().mockResolvedValue(
      JSON.stringify({ title_es: "T-es", excerpt_es: "E-es", content_es: "## C-es" })
    );
    expect(await translateBlogPostWithAi(post, generate as never)).toEqual({
      title_es: "T-es",
      excerpt_es: "E-es",
      content_es: "## C-es"
    });
  });

  it("throws when fields are missing", async () => {
    const generate = vi.fn().mockResolvedValue(JSON.stringify({ title_es: "only" }));
    await expect(translateBlogPostWithAi(post, generate as never)).rejects.toThrow(
      "blog-ai: translation response missing fields"
    );
  });
});

describe("generateBlogImageWithAi", () => {
  const post = { title: "T", excerpt: "E" };

  function storageDb(uploadResult: { error: { message: string } | null }) {
    const upload = vi.fn().mockResolvedValue(uploadResult);
    const db = { storage: { from: vi.fn(() => ({ upload })) } };
    return { db: db as never, upload };
  }

  it("uploads a PNG and returns its path", async () => {
    const generate = vi
      .fn()
      .mockResolvedValue({ bytes: Buffer.from("img"), mimeType: "image/png", usage: null });
    const { db, upload } = storageDb({ error: null });
    const path = await generateBlogImageWithAi(post, db, generate as never);
    expect(path).toMatch(/\.png$/);
    expect(upload).toHaveBeenCalledWith(path, Buffer.from("img"), {
      contentType: "image/png"
    });
  });

  it("uses a .jpg extension for JPEG output", async () => {
    const generate = vi
      .fn()
      .mockResolvedValue({ bytes: Buffer.from("img"), mimeType: "image/jpeg", usage: null });
    const { db } = storageDb({ error: null });
    expect(await generateBlogImageWithAi(post, db, generate as never)).toMatch(/\.jpg$/);
  });

  it("throws when the upload fails", async () => {
    const generate = vi
      .fn()
      .mockResolvedValue({ bytes: Buffer.from("img"), mimeType: "image/png", usage: null });
    const { db } = storageDb({ error: { message: "bucket missing" } });
    await expect(generateBlogImageWithAi(post, db, generate as never)).rejects.toThrow(
      "blog-ai: image upload failed: bucket missing"
    );
  });

  it("honors the image model override", async () => {
    vi.stubEnv("BLOG_DIGEST_IMAGE_MODEL", "image-test");
    const generate = vi
      .fn()
      .mockResolvedValue({ bytes: Buffer.from("img"), mimeType: "image/png", usage: null });
    const { db } = storageDb({ error: null });
    await generateBlogImageWithAi(post, db, generate as never);
    expect(generate.mock.calls[0][0].model).toBe("image-test");
  });
});

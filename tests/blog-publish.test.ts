/**
 * Blog publish pipeline (src/lib/blog/publish.ts): locale copy selection,
 * the subscriber email fan-out (skip/degrade paths), the Instagram
 * cross-post toggle (draft vs immediate), and the guarded sweep.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => ({}))
}));

vi.mock("@/lib/blog/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/blog/db")>();
  return {
    ...actual,
    listDueScheduledBlogPosts: vi.fn(),
    transitionBlogPost: vi.fn()
  };
});

import {
  postCopyForLocale,
  processBlogPublishSweep,
  runBlogPublishSideEffects
} from "@/lib/blog/publish";
import {
  listDueScheduledBlogPosts,
  transitionBlogPost,
  DEFAULT_BLOG_SETTINGS,
  type BlogPostRow,
  type BlogSettingsRow,
  type BlogSubscriberRow
} from "@/lib/blog/db";

const listDueMock = vi.mocked(listDueScheduledBlogPosts);
const transitionMock = vi.mocked(transitionBlogPost);

const DB = {} as never;

function post(overrides: Partial<BlogPostRow> = {}): BlogPostRow {
  return {
    id: "post-1",
    slug: "big-feature",
    title: "Big Feature",
    excerpt: "Your coworker does a new thing.",
    content: "## Body",
    title_es: null,
    excerpt_es: null,
    content_es: null,
    category: "feature",
    author_name: "New Coworker Team",
    status: "published",
    published_at: "2026-07-20T15:00:00.000Z",
    scheduled_for: null,
    featured_image_path: null,
    featured_image_alt: null,
    source: "manual",
    digest_week: null,
    created_at: "2026-07-19T00:00:00.000Z",
    updated_at: "2026-07-19T00:00:00.000Z",
    ...overrides
  };
}

function subscriber(overrides: Partial<BlogSubscriberRow> = {}): BlogSubscriberRow {
  return {
    id: "sub-1",
    email: "reader@example.com",
    locale: "en",
    unsubscribe_token: "tok/1",
    created_at: "2026-07-01T00:00:00.000Z",
    unsubscribed_at: null,
    ...overrides
  };
}

function settings(overrides: Partial<BlogSettingsRow> = {}): BlogSettingsRow {
  return { ...DEFAULT_BLOG_SETTINGS, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://proj.supabase.co");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("postCopyForLocale", () => {
  const base = post({
    title_es: "Gran función",
    excerpt_es: "Tu coworker hace algo nuevo."
  });

  it("returns Spanish copy when translated", () => {
    expect(postCopyForLocale(base, "es")).toEqual({
      title: "Gran función",
      excerpt: "Tu coworker hace algo nuevo.",
      locale: "es"
    });
  });

  it("falls back to the English excerpt when only the title is translated", () => {
    const copy = postCopyForLocale(post({ title_es: "Gran función" }), "es");
    expect(copy).toEqual({
      title: "Gran función",
      excerpt: "Your coworker does a new thing.",
      locale: "es"
    });
  });

  it("returns English for untranslated posts and English subscribers", () => {
    expect(postCopyForLocale(post(), "es").locale).toBe("en");
    expect(postCopyForLocale(base, "en").locale).toBe("en");
  });
});

describe("runBlogPublishSideEffects", () => {
  it("skips email without RESEND_API_KEY and skips cross-post without a designated business", async () => {
    vi.stubEnv("RESEND_API_KEY", undefined);
    const sendEmail = vi.fn();
    const insertSocial = vi.fn();
    const result = await runBlogPublishSideEffects(post(), {
      client: DB,
      loadSettings: async () => settings(),
      loadSubscribers: async () => [subscriber()],
      sendEmail: sendEmail as never,
      insertSocial: insertSocial as never
    });
    expect(result).toEqual({ emailed: 0, emailErrors: 0, crossPosted: false });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(insertSocial).not.toHaveBeenCalled();
  });

  it("emails each subscriber in their locale, surviving per-recipient failures", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_key");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://www.newcoworker.com/");
    const sendEmail = vi
      .fn()
      .mockResolvedValueOnce("id-1")
      .mockRejectedValueOnce("smtp down")
      .mockRejectedValueOnce(new Error("hard bounce"));
    const result = await runBlogPublishSideEffects(
      post({ title_es: "Gran función", excerpt_es: "Algo nuevo." }),
      {
        client: DB,
        loadSettings: async () => settings(),
        loadSubscribers: async () => [
          subscriber({ locale: "es" }),
          subscriber({ id: "sub-2", email: "b@example.com", locale: "en" }),
          subscriber({ id: "sub-3", email: "c@example.com", locale: "en" })
        ],
        sendEmail: sendEmail as never,
        insertSocial: vi.fn() as never
      }
    );
    expect(result.emailed).toBe(1);
    expect(result.emailErrors).toBe(2);

    // Spanish subscriber got Spanish copy + a tokenized one-click
    // unsubscribe that carries the locale for the /es result page.
    const [, to, subject, opts] = sendEmail.mock.calls[0];
    expect(to).toBe("reader@example.com");
    expect(subject).toContain("Nuevo en el blog");
    expect((opts as { unsubscribeUrl: string }).unsubscribeUrl).toBe(
      "https://www.newcoworker.com/api/blog/unsubscribe?token=tok%2F1&locale=es"
    );
    // English subscribers get the unprefixed link.
    const enOpts = sendEmail.mock.calls[1][3] as { unsubscribeUrl: string };
    expect(enOpts.unsubscribeUrl).toBe(
      "https://www.newcoworker.com/api/blog/unsubscribe?token=tok%2F1"
    );
  });

  it("counts a subscriber-load failure as an email error (Error and non-Error)", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_key");
    const result = await runBlogPublishSideEffects(post(), {
      client: DB,
      loadSettings: async () => settings(),
      loadSubscribers: async () => {
        throw new Error("db down");
      },
      sendEmail: vi.fn() as never,
      insertSocial: vi.fn() as never
    });
    expect(result.emailErrors).toBe(1);
    expect(result.emailed).toBe(0);

    const stringThrow = await runBlogPublishSideEffects(post(), {
      client: DB,
      loadSettings: async () => settings(),
      loadSubscribers: async () => {
        throw "socket reset";
      },
      sendEmail: vi.fn() as never,
      insertSocial: vi.fn() as never
    });
    expect(stringThrow.emailErrors).toBe(1);
  });

  it("skips the cross-post when the post has no featured image", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const insertSocial = vi.fn();
    const result = await runBlogPublishSideEffects(post(), {
      client: DB,
      loadSettings: async () => settings({ instagram_business_id: "biz-1" }),
      loadSubscribers: async () => [],
      sendEmail: vi.fn() as never,
      insertSocial: insertSocial as never
    });
    expect(result.crossPosted).toBe(false);
    expect(insertSocial).not.toHaveBeenCalled();
  });

  it("cross-posts as a composer DRAFT by default, excerpt as the caption", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const insertSocial = vi.fn().mockResolvedValue({ id: "sp-1" });
    const longExcerpt = "x".repeat(3000);
    const result = await runBlogPublishSideEffects(
      post({ featured_image_path: "cover.png", excerpt: longExcerpt }),
      {
        client: DB,
        loadSettings: async () => settings({ instagram_business_id: "biz-1" }),
        loadSubscribers: async () => [],
        sendEmail: vi.fn() as never,
        insertSocial: insertSocial as never
      }
    );
    expect(result.crossPosted).toBe(true);
    expect(insertSocial).toHaveBeenCalledWith(
      {
        business_id: "biz-1",
        caption: "x".repeat(2200),
        media_url: "https://proj.supabase.co/storage/v1/object/public/blog-images/cover.png",
        status: "draft"
      },
      DB
    );
  });

  it("schedules the cross-post immediately when the toggle is on", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const insertSocial = vi.fn().mockResolvedValue({ id: "sp-1" });
    const now = () => new Date("2026-07-20T15:00:00.000Z");
    await runBlogPublishSideEffects(post({ featured_image_path: "cover.png" }), {
      client: DB,
      loadSettings: async () =>
        settings({ instagram_business_id: "biz-1", instagram_publish_immediately: true }),
      loadSubscribers: async () => [],
      sendEmail: vi.fn() as never,
      insertSocial: insertSocial as never,
      now
    });
    expect(insertSocial).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "scheduled",
        publish_at: "2026-07-20T15:00:00.000Z"
      }),
      DB
    );
  });

  it("degrades gracefully when the cross-post insert or settings load fails", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const failedInsert = await runBlogPublishSideEffects(
      post({ featured_image_path: "cover.png" }),
      {
        client: DB,
        loadSettings: async () => settings({ instagram_business_id: "biz-1" }),
        loadSubscribers: async () => [],
        sendEmail: vi.fn() as never,
        insertSocial: vi.fn().mockRejectedValue(new Error("meta down")) as never
      }
    );
    expect(failedInsert.crossPosted).toBe(false);

    const failedSettings = await runBlogPublishSideEffects(post(), {
      client: DB,
      loadSettings: async () => {
        throw "settings unavailable";
      },
      loadSubscribers: async () => [],
      sendEmail: vi.fn() as never,
      insertSocial: vi.fn() as never
    });
    expect(failedSettings.crossPosted).toBe(false);
  });
});

describe("processBlogPublishSweep", () => {
  it("publishes due posts and aggregates the fan-out", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_key");
    listDueMock.mockResolvedValue([
      post({ id: "p1", status: "scheduled", featured_image_path: "cover.png" })
    ]);
    transitionMock.mockResolvedValue(true);
    const sendEmail = vi.fn().mockResolvedValue("id-1");
    const insertSocial = vi.fn().mockResolvedValue({ id: "sp-1" });
    const now = () => new Date("2026-07-20T15:00:00.000Z");

    const result = await processBlogPublishSweep({
      client: DB,
      loadSettings: async () => settings({ instagram_business_id: "biz-1" }),
      loadSubscribers: async () => [subscriber()],
      sendEmail: sendEmail as never,
      insertSocial: insertSocial as never,
      now
    });

    expect(transitionMock).toHaveBeenCalledWith(
      "p1",
      "scheduled",
      { status: "published", published_at: "2026-07-20T15:00:00.000Z" },
      DB
    );
    expect(result).toEqual({
      published: 1,
      emailed: 1,
      emailErrors: 0,
      crossPosted: 1,
      errors: []
    });
  });

  it("publishes without a cross-post when no business is designated", async () => {
    vi.stubEnv("RESEND_API_KEY", undefined);
    listDueMock.mockResolvedValue([post({ id: "p1", status: "scheduled" })]);
    transitionMock.mockResolvedValue(true);
    const result = await processBlogPublishSweep({
      client: DB,
      loadSettings: async () => settings(),
      loadSubscribers: async () => [],
      sendEmail: vi.fn() as never,
      insertSocial: vi.fn() as never,
      now: () => new Date()
    });
    expect(result.published).toBe(1);
    expect(result.crossPosted).toBe(0);
  });

  it("skips posts whose claim was lost to a racing edit", async () => {
    listDueMock.mockResolvedValue([post({ id: "p1", status: "scheduled" })]);
    transitionMock.mockResolvedValue(false);
    const result = await processBlogPublishSweep({ client: DB, now: () => new Date() });
    expect(result.published).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("collects per-post errors (Error and non-Error) and keeps sweeping", async () => {
    listDueMock.mockResolvedValue([
      post({ id: "p1", status: "scheduled" }),
      post({ id: "p2", status: "scheduled" })
    ]);
    transitionMock.mockRejectedValueOnce(new Error("db timeout")).mockRejectedValueOnce("string bad");
    const result = await processBlogPublishSweep({ client: DB, now: () => new Date() });
    expect(result.errors).toEqual([
      { postId: "p1", message: "db timeout" },
      { postId: "p2", message: "string bad" }
    ]);
  });
});

/**
 * Weekly PR digest (src/lib/blog/weekly-digest.ts): the ISO week key, the
 * word cap, GitHub fetch + filtering, the features-only selection (labels
 * first, classifier fallback), digest composition with the 700-word
 * enforcement, image generation, and the end-to-end run outcomes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => ({}))
}));

import {
  classifyFeaturePrsWithGemini,
  composeDigestWithGemini,
  countWords,
  DIGEST_MAX_WORDS,
  digestGeminiApiKey,
  digestTextModel,
  fetchMergedPrsFromGithub,
  generateDigestImageToBucket,
  isNoisePr,
  isoWeekKey,
  runWeeklyDigest,
  selectFeaturePrs,
  truncateAtSectionBoundary,
  type MergedPr
} from "@/lib/blog/weekly-digest";
import { DEFAULT_BLOG_SETTINGS, type BlogSettingsRow } from "@/lib/blog/db";

const DB = {} as never;

function pr(overrides: Partial<MergedPr> = {}): MergedPr {
  return {
    number: 1,
    title: "Add a shiny feature",
    body: "Adds the thing.",
    labels: [],
    authorLogin: "brianlane",
    ...overrides
  };
}

function settings(overrides: Partial<BlogSettingsRow> = {}): BlogSettingsRow {
  return { ...DEFAULT_BLOG_SETTINGS, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isoWeekKey / countWords / truncateAtSectionBoundary", () => {
  it("computes ISO week keys, including Sunday and year-boundary weeks", () => {
    expect(isoWeekKey(new Date("2026-07-20T12:00:00Z"))).toBe("2026-W30");
    expect(isoWeekKey(new Date("2026-07-26T12:00:00Z"))).toBe("2026-W30");
    // Jan 1 2027 (a Friday) still belongs to 2026's last ISO week.
    expect(isoWeekKey(new Date("2027-01-01T12:00:00Z"))).toBe("2026-W53");
  });

  it("counts words, treating blank input as zero", () => {
    expect(countWords("one two  three")).toBe(3);
    expect(countWords("   ")).toBe(0);
  });

  it("returns content under the cap unchanged", () => {
    expect(truncateAtSectionBoundary("short body", 10)).toBe("short body");
  });

  it("drops trailing ## sections whole to get under the cap", () => {
    const content = `intro words here\n## One\n${"a ".repeat(6)}\n## Two\n${"b ".repeat(50)}`;
    const trimmed = truncateAtSectionBoundary(content, 12);
    expect(trimmed).toContain("## One");
    expect(trimmed).not.toContain("## Two");
  });

  it("hard-cuts when a single section is still over the cap", () => {
    const trimmed = truncateAtSectionBoundary("w ".repeat(30).trim(), 5);
    expect(countWords(trimmed)).toBe(5);
  });

  it("hard-cuts when even the first section alone is over the cap", () => {
    const content = `## A\n${"a ".repeat(10).trim()}\n## B\n${"b ".repeat(10).trim()}`;
    const trimmed = truncateAtSectionBoundary(content, 3);
    expect(countWords(trimmed)).toBe(3);
  });
});

describe("gemini env resolution", () => {
  it("prefers GOOGLE_API_KEY, falls back to GEMINI_API_KEY, then empty", () => {
    vi.stubEnv("GOOGLE_API_KEY", "g");
    expect(digestGeminiApiKey()).toBe("g");
    vi.unstubAllEnvs();
    vi.stubEnv("GEMINI_API_KEY", "alt");
    expect(digestGeminiApiKey()).toBe("alt");
    vi.unstubAllEnvs();
    expect(digestGeminiApiKey()).toBe("");
  });

  it("honors the text-model override and its default", () => {
    expect(digestTextModel()).toBe("gemini-3.5-flash");
    vi.stubEnv("BLOG_DIGEST_TEXT_MODEL", "gemini-test");
    expect(digestTextModel()).toBe("gemini-test");
  });
});

describe("fetchMergedPrsFromGithub", () => {
  const SINCE = "2026-07-13T00:00:00.000Z";
  const UNTIL = "2026-07-20T00:00:00.000Z";

  it("throws without repo/token configuration", async () => {
    await expect(fetchMergedPrsFromGithub(SINCE, UNTIL)).rejects.toThrow(
      "GITHUB_DIGEST_REPO / GITHUB_DIGEST_TOKEN not configured"
    );
  });

  it("throws on a non-OK response", async () => {
    vi.stubEnv("GITHUB_DIGEST_REPO", "owner/repo");
    vi.stubEnv("GITHUB_DIGEST_TOKEN", "gh-token");
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    await expect(fetchMergedPrsFromGithub(SINCE, UNTIL, fetchImpl as never)).rejects.toThrow(
      "GitHub list PRs failed (403)"
    );
  });

  it("filters to the merge window and maps fields (null body/user tolerated)", async () => {
    vi.stubEnv("GITHUB_DIGEST_REPO", "owner/repo");
    vi.stubEnv("GITHUB_DIGEST_TOKEN", "gh-token");
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          number: 1,
          title: "In window",
          body: "body",
          merged_at: "2026-07-15T10:00:00Z",
          labels: [{ name: "blog: feature" }],
          user: { login: "dev" },
          base: { ref: "main" }
        },
        {
          number: 2,
          title: "Unmerged",
          body: null,
          merged_at: null,
          labels: [],
          user: null,
          base: { ref: "main" }
        },
        {
          number: 3,
          title: "Too old",
          body: null,
          merged_at: "2026-07-01T10:00:00Z",
          labels: [],
          user: null,
          base: { ref: "main" }
        },
        {
          number: 4,
          title: "Null-ish fields",
          body: null,
          merged_at: "2026-07-16T10:00:00Z",
          labels: [],
          user: null,
          base: { ref: "main" }
        }
      ]
    });
    const prs = await fetchMergedPrsFromGithub(SINCE, UNTIL, fetchImpl as never);
    expect(prs).toEqual([
      {
        number: 1,
        title: "In window",
        body: "body",
        labels: ["blog: feature"],
        authorLogin: "dev"
      },
      { number: 4, title: "Null-ish fields", body: "", labels: [], authorLogin: "" }
    ]);
    // A short page is the last page — no second fetch.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain("repos/owner/repo/pulls");
    expect(url).toContain("page=1");
    expect(init.headers.Authorization).toBe("Bearer gh-token");
  });

  function fullPage(startNumber: number, mergedAt: string | null) {
    return Array.from({ length: 100 }, (_, i) => ({
      number: startNumber + i,
      title: `PR ${startNumber + i}`,
      body: null,
      merged_at: mergedAt,
      labels: [],
      user: null,
      base: { ref: "main" }
    }));
  }

  it("pages past a full first page so busy weeks are not undercounted", async () => {
    vi.stubEnv("GITHUB_DIGEST_REPO", "owner/repo");
    vi.stubEnv("GITHUB_DIGEST_TOKEN", "gh-token");
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => fullPage(1, "2026-07-15T10:00:00Z")
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => fullPage(101, "2026-07-16T10:00:00Z").slice(0, 20)
      });
    const prs = await fetchMergedPrsFromGithub(SINCE, UNTIL, fetchImpl as never);
    expect(prs).toHaveLength(120);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][0]).toContain("page=2");
  });

  it("stops paging once a full page has no in-window merges", async () => {
    vi.stubEnv("GITHUB_DIGEST_REPO", "owner/repo");
    vi.stubEnv("GITHUB_DIGEST_TOKEN", "gh-token");
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      // Full page, but everything merged before the window (or unmerged).
      json: async () => [
        ...fullPage(1, "2026-06-01T10:00:00Z").slice(0, 50),
        ...fullPage(51, null).slice(0, 50)
      ]
    });
    const prs = await fetchMergedPrsFromGithub(SINCE, UNTIL, fetchImpl as never);
    expect(prs).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("caps at the page limit even when every page stays recent", async () => {
    vi.stubEnv("GITHUB_DIGEST_REPO", "owner/repo");
    vi.stubEnv("GITHUB_DIGEST_TOKEN", "gh-token");
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => fullPage(1, "2026-07-15T10:00:00Z")
    });
    await fetchMergedPrsFromGithub(SINCE, UNTIL, fetchImpl as never);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });
});

describe("isNoisePr / selectFeaturePrs", () => {
  it("flags dependabot, blog: skip, and noise-titled PRs", () => {
    expect(isNoisePr(pr({ authorLogin: "dependabot[bot]" }))).toBe(true);
    expect(isNoisePr(pr({ labels: ["blog: skip"] }))).toBe(true);
    expect(isNoisePr(pr({ title: "docs: update readme" }))).toBe(true);
    expect(isNoisePr(pr({ title: "Bump axios from 1 to 2" }))).toBe(true);
    expect(isNoisePr(pr({ title: "One-shot: apply config" }))).toBe(true);
    expect(isNoisePr(pr({ title: "Revert something" }))).toBe(true);
    expect(isNoisePr(pr())).toBe(false);
  });

  it("includes labeled features without consulting the classifier", async () => {
    const classify = vi.fn();
    const features = await selectFeaturePrs([pr({ labels: ["blog: feature"] })], classify);
    expect(features).toHaveLength(1);
    expect(classify).not.toHaveBeenCalled();
  });

  it("classifies the unlabeled remainder and keeps only classified features", async () => {
    const classify = vi.fn(async (_prs: MergedPr[]) => new Set([2]));
    const features = await selectFeaturePrs(
      [
        pr({ number: 1, labels: ["blog: feature"] }),
        pr({ number: 2 }),
        pr({ number: 3 }),
        pr({ number: 4, authorLogin: "dependabot[bot]" })
      ],
      classify
    );
    expect(features.map((p) => p.number)).toEqual([1, 2]);
    expect((classify.mock.calls[0]?.[0] ?? []).map((p: MergedPr) => p.number)).toEqual([2, 3]);
  });

  it("drops unlabeled PRs when the classifier fails (Error and non-Error)", async () => {
    const errored = await selectFeaturePrs([pr({ number: 2 })], async () => {
      throw new Error("gemini down");
    });
    expect(errored).toEqual([]);

    const stringErrored = await selectFeaturePrs(
      [pr({ number: 1, labels: ["blog: feature"] }), pr({ number: 2 })],
      async () => {
        throw "nope";
      }
    );
    expect(stringErrored.map((p) => p.number)).toEqual([1]);
  });
});

describe("classifyFeaturePrsWithGemini", () => {
  it("parses feature numbers, filtering junk entries", async () => {
    const generate = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ featureNumbers: [2, "x", 5] }));
    const result = await classifyFeaturePrsWithGemini([pr({ number: 2 })], generate as never);
    expect([...result]).toEqual([2, 5]);
    expect(generate.mock.calls[0][0].responseMimeType).toBe("application/json");
  });

  it("treats a non-array payload as no features", async () => {
    const generate = vi.fn().mockResolvedValue(JSON.stringify({ featureNumbers: "none" }));
    expect(
      (await classifyFeaturePrsWithGemini([pr()], generate as never)).size
    ).toBe(0);
  });
});

describe("composeDigestWithGemini", () => {
  const draft = (content: string) =>
    JSON.stringify({ title: "Week", excerpt: "Shipped stuff.", content });

  it("returns the first draft when under the cap (bodyless PRs listed by title only)", async () => {
    const generate = vi.fn().mockResolvedValue(draft("short and sweet"));
    const result = await composeDigestWithGemini(
      [pr(), pr({ number: 2, title: "No body here", body: "" })],
      "2026-W29",
      generate as never
    );
    expect(result.content).toBe("short and sweet");
    expect(generate).toHaveBeenCalledTimes(1);
    const listing = generate.mock.calls[0][0].userText as string;
    expect(listing).toContain("- Add a shiny feature: Adds the thing.");
    expect(listing).toMatch(/- No body here$/m);
  });

  it("retries once when over the cap, accepting a compliant retry", async () => {
    const long = "w ".repeat(DIGEST_MAX_WORDS + 50).trim();
    const generate = vi
      .fn()
      .mockResolvedValueOnce(draft(long))
      .mockResolvedValueOnce(draft("tight now"));
    const result = await composeDigestWithGemini([pr()], "2026-W29", generate as never);
    expect(result.content).toBe("tight now");
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1][0].systemInstruction).toContain("too long");
  });

  it("truncates at a section boundary when the retry is still over", async () => {
    const section = (name: string, words: number) => `## ${name}\n${"w ".repeat(words).trim()}`;
    const long = `${section("A", 300)}\n${section("B", 300)}\n${section("C", 300)}`;
    const generate = vi.fn().mockResolvedValue(draft(long));
    const result = await composeDigestWithGemini([pr()], "2026-W29", generate as never);
    expect(countWords(result.content)).toBeLessThanOrEqual(DIGEST_MAX_WORDS);
    expect(result.content).toContain("## A");
    expect(result.content).not.toContain("## C");
  });

  it("throws when the draft is missing fields", async () => {
    const generate = vi.fn().mockResolvedValue(JSON.stringify({ title: "only" }));
    await expect(
      composeDigestWithGemini([pr()], "2026-W29", generate as never)
    ).rejects.toThrow("Gemini digest draft missing fields");
  });
});

describe("generateDigestImageToBucket", () => {
  const draft = { title: "Week", excerpt: "E", content: "C" };

  function storageDb(uploadResult: { error: { message: string } | null }) {
    const upload = vi.fn().mockResolvedValue(uploadResult);
    return { db: { storage: { from: vi.fn(() => ({ upload })) } } as never, upload };
  }

  it("uploads the image and returns the week-keyed path", async () => {
    const generate = vi
      .fn()
      .mockResolvedValue({ bytes: Buffer.from("img"), mimeType: "image/png", usage: null });
    const { db, upload } = storageDb({ error: null });
    expect(await generateDigestImageToBucket(draft, "2026-W29", db, generate as never)).toBe(
      "digest-2026-w29.png"
    );
    expect(upload).toHaveBeenCalledWith("digest-2026-w29.png", Buffer.from("img"), {
      contentType: "image/png",
      upsert: true
    });
  });

  it("uses .jpg for JPEG output", async () => {
    const generate = vi
      .fn()
      .mockResolvedValue({ bytes: Buffer.from("img"), mimeType: "image/jpeg", usage: null });
    const { db } = storageDb({ error: null });
    expect(await generateDigestImageToBucket(draft, "2026-W29", db, generate as never)).toBe(
      "digest-2026-w29.jpg"
    );
  });

  it("returns null on upload errors and on generation throws", async () => {
    const generate = vi
      .fn()
      .mockResolvedValue({ bytes: Buffer.from("img"), mimeType: "image/png", usage: null });
    const { db } = storageDb({ error: { message: "bucket gone" } });
    expect(await generateDigestImageToBucket(draft, "2026-W29", db, generate as never)).toBeNull();

    const throwing = vi.fn().mockRejectedValue("quota");
    const { db: okDb } = storageDb({ error: null });
    expect(
      await generateDigestImageToBucket(draft, "2026-W29", okDb, throwing as never)
    ).toBeNull();
  });
});

describe("runWeeklyDigest", () => {
  // A Monday-morning run: the digest keys the week that just ended (W29).
  const NOW = new Date("2026-07-20T15:00:00.000Z");
  const manyPrs = Array.from({ length: 11 }, (_, i) => pr({ number: i + 1 }));
  // Comfortably past the 150-word thin bar.
  const RICH_CONTENT = `## Section\n${"word ".repeat(200).trim()}`;

  function deps(overrides: Partial<Parameters<typeof runWeeklyDigest>[0]> = {}) {
    return {
      client: DB,
      loadSettings: async () => settings(),
      findExisting: vi.fn(async () => null),
      findLatestDigest: vi.fn(async () => null),
      insertPost: vi.fn(async (row: Record<string, unknown>) => ({ id: "post-1", ...row })),
      fetchMergedPrs: vi.fn(async () => manyPrs),
      classify: vi.fn(async () => new Set(manyPrs.map((p) => p.number))),
      compose: vi.fn(async () => ({ title: "Week", excerpt: "E", content: RICH_CONTENT })),
      generateImage: vi.fn(async () => "digest-2026-w29.png"),
      now: () => NOW,
      ...overrides
    };
  }

  it("returns 'disabled' when the toggle is off", async () => {
    const result = await runWeeklyDigest(
      deps({ loadSettings: async () => settings({ digest_enabled: false }) }) as never
    );
    expect(result.outcome).toBe("disabled");
    expect(result.weekKey).toBe("2026-W29");
  });

  it("is idempotent per week", async () => {
    const result = await runWeeklyDigest(
      deps({ findExisting: vi.fn(async () => ({ id: "existing" }) as never) }) as never
    );
    expect(result.outcome).toBe("already_exists");
  });

  it("skips quiet weeks (10 or fewer merged PRs)", async () => {
    const result = await runWeeklyDigest(
      deps({ fetchMergedPrs: vi.fn(async () => manyPrs.slice(0, 10)) }) as never
    );
    expect(result.outcome).toBe("below_threshold");
    expect(result.mergedCount).toBe(10);
  });

  it("skips when no PR survives the features-only filter", async () => {
    const result = await runWeeklyDigest(deps({ classify: vi.fn(async () => new Set<number>()) }) as never);
    expect(result.outcome).toBe("no_features");
    expect(result.mergedCount).toBe(11);
  });

  it("creates a scheduled post with an image by default", async () => {
    const insertPost = vi.fn(async (row: Record<string, unknown>) => ({ id: "post-1", ...row }));
    const fetchMergedPrs = vi.fn(async (_since: string, _until: string) => manyPrs);
    const d = deps({ insertPost: insertPost as never, fetchMergedPrs });
    const result = await runWeeklyDigest(d as never);
    expect(result).toEqual({
      outcome: "created",
      weekKey: "2026-W29",
      mergedCount: 11,
      featureCount: 11,
      postId: "post-1"
    });
    expect(insertPost).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "what-we-shipped-2026-w29",
        category: "platform-updates",
        source: "weekly_digest",
        digest_week: "2026-W29",
        featured_image_path: "digest-2026-w29.png",
        featured_image_alt: "Week",
        status: "scheduled",
        scheduled_for: NOW.toISOString()
      }),
      DB
    );
    // The window is the trailing 7 days.
    const [sinceIso, untilIso] = fetchMergedPrs.mock.calls[0] ?? [];
    expect(untilIso).toBe(NOW.toISOString());
    expect(sinceIso).toBe("2026-07-13T15:00:00.000Z");
  });

  it("anchors the PR window at the last digest post so skipped weeks roll forward", async () => {
    // Last digest posted 12 days ago (the run in between was skipped).
    const twelveDaysAgo = new Date(NOW.getTime() - 12 * 24 * 60 * 60 * 1000).toISOString();
    const fetchMergedPrs = vi.fn(async (_s: string, _u: string) => manyPrs);
    const d = deps({
      findLatestDigest: vi.fn(async () => ({ created_at: twelveDaysAgo }) as never),
      fetchMergedPrs
    });
    await runWeeklyDigest(d as never);
    expect(fetchMergedPrs.mock.calls[0]?.[0]).toBe(twelveDaysAgo);
  });

  it("caps the rollover window at DIGEST_MAX_WINDOW_DAYS", async () => {
    const fortyDaysAgo = new Date(NOW.getTime() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const fetchMergedPrs = vi.fn(async (_s: string, _u: string) => manyPrs);
    const d = deps({
      findLatestDigest: vi.fn(async () => ({ created_at: fortyDaysAgo }) as never),
      fetchMergedPrs
    });
    await runWeeklyDigest(d as never);
    const cap = new Date(NOW.getTime() - 28 * 24 * 60 * 60 * 1000).toISOString();
    expect(fetchMergedPrs.mock.calls[0]?.[0]).toBe(cap);
  });

  it("skips a composed digest under 150 words (too_thin) without image or insert", async () => {
    const thin = `## Tiny\n${"word ".repeat(100).trim()}`;
    const generateImage = vi.fn(async () => "unused.png");
    const insertPost = vi.fn();
    const d = deps({
      compose: vi.fn(async () => ({ title: "Week", excerpt: "E", content: thin })),
      generateImage,
      insertPost: insertPost as never
    });
    const result = await runWeeklyDigest(d as never);
    expect(result.outcome).toBe("too_thin");
    expect(result.featureCount).toBe(11);
    expect(generateImage).not.toHaveBeenCalled();
    expect(insertPost).not.toHaveBeenCalled();
  });

  it("treats an insert lost to a concurrent run as already_exists", async () => {
    const findExisting = vi
      .fn()
      .mockResolvedValueOnce(null) // pre-insert probe
      .mockResolvedValueOnce({ id: "winner" } as never); // post-race re-check
    const insertPost = vi
      .fn()
      .mockRejectedValue(new Error('duplicate key value violates unique constraint "uq_blog_posts_digest_week"'));
    const result = await runWeeklyDigest(
      deps({ findExisting, insertPost: insertPost as never }) as never
    );
    expect(result.outcome).toBe("already_exists");
    expect(result.mergedCount).toBe(11);
  });

  it("rethrows a genuine insert failure (no concurrent winner)", async () => {
    const findExisting = vi.fn().mockResolvedValue(null);
    const insertPost = vi.fn().mockRejectedValue(new Error("db down"));
    await expect(
      runWeeklyDigest(deps({ findExisting, insertPost: insertPost as never }) as never)
    ).rejects.toThrow("db down");
  });

  it("honors digest_as_draft and digest_include_image=false", async () => {
    const insertPost = vi.fn(async (row: Record<string, unknown>) => ({ id: "post-1", ...row }));
    const generateImage = vi.fn(async () => "unused.png");
    const d = deps({
      insertPost: insertPost as never,
      generateImage,
      loadSettings: async () =>
        settings({ digest_as_draft: true, digest_include_image: false })
    });
    const result = await runWeeklyDigest(d as never);
    expect(result.outcome).toBe("created");
    expect(generateImage).not.toHaveBeenCalled();
    expect(insertPost).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "draft",
        featured_image_path: null,
        featured_image_alt: null
      }),
      DB
    );
    const inserted = (insertPost.mock.calls[0]?.[0] ?? {}) as Record<string, unknown>;
    expect(inserted.scheduled_for).toBeUndefined();
  });
});

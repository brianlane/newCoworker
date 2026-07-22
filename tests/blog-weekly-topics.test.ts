/**
 * Weekly rotation (src/lib/blog/weekly-topics.ts): slot math, the three
 * category composers (grounding, dedupe, word-cap enforcement), and the
 * runWeeklyAuto dispatcher with every fallback-to-digest path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => ({}))
}));

import {
  composeTopicWithGemini,
  rotationCategoryForWeek,
  runWeeklyAuto,
  TOPIC_DEDUPE_TITLES,
  WEEKLY_ROTATION
} from "@/lib/blog/weekly-topics";
import { countWords, DIGEST_MAX_WORDS, type MergedPr } from "@/lib/blog/weekly-digest";
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

const RICH_CONTENT = `## Section\n${"word ".repeat(200).trim()}`;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("rotationCategoryForWeek", () => {
  it("maps ISO week numbers onto the 4-week cycle", () => {
    expect(rotationCategoryForWeek("2026-W28")).toBe("platform-updates"); // 28 % 4 = 0
    expect(rotationCategoryForWeek("2026-W29")).toBe("tutorial");
    expect(rotationCategoryForWeek("2026-W30")).toBe("business-tips");
    expect(rotationCategoryForWeek("2026-W31")).toBe("feature");
    expect(rotationCategoryForWeek("2026-W32")).toBe("platform-updates");
  });

  it("tolerates a malformed key by landing on the digest slot", () => {
    expect(rotationCategoryForWeek("garbage")).toBe(WEEKLY_ROTATION[0]);
  });
});

describe("composeTopicWithGemini", () => {
  const draft = (content: string) =>
    JSON.stringify({ title: "T", excerpt: "E", content });

  it("grounds tutorials in the provided feature material", async () => {
    const generate = vi.fn().mockResolvedValue(draft("short body"));
    await composeTopicWithGemini(
      "tutorial",
      [pr(), pr({ number: 2, title: "No body", body: "" })],
      [],
      generate as never
    );
    const params = generate.mock.calls[0][0];
    expect(params.systemInstruction).toContain("step-by-step tutorial");
    expect(params.userText).toContain("- Add a shiny feature: Adds the thing.");
    expect(params.userText).toMatch(/- No body$/m);
  });

  it("asks the deep-dive for the single most impactful feature", async () => {
    const generate = vi.fn().mockResolvedValue(draft("short body"));
    await composeTopicWithGemini("feature", [pr()], [], generate as never);
    expect(generate.mock.calls[0][0].systemInstruction).toContain("feature deep-dive");
  });

  it("feeds business-tips the recent titles for dedupe (and a first-post variant)", async () => {
    const generate = vi.fn().mockResolvedValue(draft("short body"));
    await composeTopicWithGemini(
      "business-tips",
      [],
      ["Never miss a call", "Faster follow-up"],
      generate as never
    );
    const withTitles = generate.mock.calls[0][0];
    expect(withTitles.systemInstruction).toContain("business-tips article");
    expect(withTitles.userText).toContain("- Never miss a call");

    await composeTopicWithGemini("business-tips", [], [], generate as never);
    expect(generate.mock.calls[1][0].userText).toContain("first business-tips post");
  });

  it("throws when the draft is missing fields", async () => {
    const generate = vi.fn().mockResolvedValue(JSON.stringify({ title: "only" }));
    await expect(
      composeTopicWithGemini("tutorial", [pr()], [], generate as never)
    ).rejects.toThrow("weekly-topics: tutorial draft missing fields");
  });

  it("retries once over the word cap, then truncates at a section boundary", async () => {
    const long = `## A\n${"w ".repeat(DIGEST_MAX_WORDS).trim()}\n## B\n${"w ".repeat(300).trim()}`;
    const generate = vi
      .fn()
      .mockResolvedValueOnce(draft(long))
      .mockResolvedValueOnce(draft(long));
    const result = await composeTopicWithGemini("feature", [pr()], [], generate as never);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1][0].systemInstruction).toContain("too long");
    expect(countWords(result.content)).toBeLessThanOrEqual(DIGEST_MAX_WORDS);
  });

  it("accepts a compliant retry", async () => {
    const long = `## A\n${"w ".repeat(DIGEST_MAX_WORDS + 50).trim()}`;
    const generate = vi
      .fn()
      .mockResolvedValueOnce(draft(long))
      .mockResolvedValueOnce(draft("tight now"));
    const result = await composeTopicWithGemini("tutorial", [pr()], [], generate as never);
    expect(result.content).toBe("tight now");
  });
});

describe("runWeeklyAuto", () => {
  // isoWeekKey(NOW - 7d) picks the rotation slot:
  const NOW_TUTORIAL = new Date("2026-07-20T15:00:00.000Z"); // -> 2026-W29 (29%4=1)
  const NOW_TIPS = new Date("2026-07-27T15:00:00.000Z"); // -> 2026-W30
  const NOW_FEATURE = new Date("2026-08-03T15:00:00.000Z"); // -> 2026-W31
  const NOW_DIGEST = new Date("2026-08-10T15:00:00.000Z"); // -> 2026-W32
  const manyPrs = Array.from({ length: 11 }, (_, i) => pr({ number: i + 1 }));

  function deps(overrides: Record<string, unknown> = {}) {
    return {
      client: DB,
      loadSettings: async () => settings(),
      findExisting: vi.fn(async () => null),
      findLatestDigest: vi.fn(async () => null),
      insertPost: vi.fn(async (row: Record<string, unknown>) => ({ id: "post-1", ...row })),
      fetchMergedPrs: vi.fn(async (_s: string, _u: string) => manyPrs),
      classify: vi.fn(async () => new Set(manyPrs.map((p) => p.number))),
      compose: vi.fn(async () => ({ title: "Digest", excerpt: "E", content: RICH_CONTENT })),
      composeTopic: vi.fn(async () => ({ title: "Topic", excerpt: "E", content: RICH_CONTENT })),
      listRecentTitles: vi.fn(async () => ["Old tips post"]),
      slugExists: vi.fn(async () => false),
      generateImage: vi.fn(async () => "img.png"),
      now: () => NOW_TUTORIAL,
      ...overrides
    };
  }

  it("delegates digest weeks to runWeeklyDigest (rotation platform-updates)", async () => {
    const d = deps({ now: () => NOW_DIGEST });
    const result = await runWeeklyAuto(d as never);
    expect(result.rotation).toBe("platform-updates");
    expect(result.fellBack).toBe(false);
    expect(result.outcome).toBe("created");
    expect(d.composeTopic).not.toHaveBeenCalled();
    expect(d.compose).toHaveBeenCalled(); // the digest composer ran
  });

  it("respects the master off-switch on topic weeks", async () => {
    const d = deps({ loadSettings: async () => settings({ digest_enabled: false }) });
    const result = await runWeeklyAuto(d as never);
    expect(result.outcome).toBe("disabled");
    expect(result.rotation).toBe("tutorial");
  });

  it("is idempotent per week on topic weeks", async () => {
    const d = deps({ findExisting: vi.fn(async () => ({ id: "existing" }) as never) });
    const result = await runWeeklyAuto(d as never);
    expect(result.outcome).toBe("already_exists");
  });

  it("falls back to the digest when the category toggle is off", async () => {
    const d = deps({
      loadSettings: async () => settings({ auto_tutorial_enabled: false })
    });
    const result = await runWeeklyAuto(d as never);
    expect(result.rotation).toBe("tutorial");
    expect(result.fellBack).toBe(true);
    expect(d.composeTopic).not.toHaveBeenCalled();
    expect(d.compose).toHaveBeenCalled();
  });

  it("covers the business-tips and feature toggles too", async () => {
    const tips = deps({
      now: () => NOW_TIPS,
      loadSettings: async () => settings({ auto_business_tips_enabled: false })
    });
    expect((await runWeeklyAuto(tips as never)).fellBack).toBe(true);

    const feature = deps({
      now: () => NOW_FEATURE,
      loadSettings: async () => settings({ auto_feature_enabled: false })
    });
    expect((await runWeeklyAuto(feature as never)).fellBack).toBe(true);
  });

  it("falls back to the digest when tutorial grounding is empty", async () => {
    const d = deps({ classify: vi.fn(async () => new Set<number>()) });
    const result = await runWeeklyAuto(d as never);
    expect(result.fellBack).toBe(true);
    expect(d.composeTopic).not.toHaveBeenCalled();
  });

  it("falls back to the digest when the topic composes too thin", async () => {
    const d = deps({
      composeTopic: vi.fn(async () => ({ title: "T", excerpt: "E", content: "tiny" }))
    });
    const result = await runWeeklyAuto(d as never);
    expect(result.fellBack).toBe(true);
    expect(d.compose).toHaveBeenCalled();
  });

  it("creates a scheduled tutorial post with a category-prefixed slug", async () => {
    const insertPost = vi.fn(async (row: Record<string, unknown>) => ({ id: "post-1", ...row }));
    const d = deps({ insertPost: insertPost as never });
    const result = await runWeeklyAuto(d as never);
    expect(result).toMatchObject({
      outcome: "created",
      rotation: "tutorial",
      fellBack: false,
      postId: "post-1",
      weekKey: "2026-W29",
      featureCount: 11
    });
    expect(insertPost).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "tutorial-topic",
        category: "tutorial",
        source: "weekly_digest",
        digest_week: "2026-W29",
        featured_image_path: "img.png",
        featured_image_alt: "Topic",
        status: "scheduled",
        scheduled_for: NOW_TUTORIAL.toISOString()
      }),
      DB
    );
    // Tutorials don't consult the dedupe titles.
    expect(d.listRecentTitles).not.toHaveBeenCalled();
  });

  it("business-tips weeks skip PR grounding and pass the dedupe titles", async () => {
    const composeTopic = vi.fn(async () => ({
      title: "Tips",
      excerpt: "E",
      content: RICH_CONTENT
    }));
    const fetchMergedPrs = vi.fn();
    const d = deps({ now: () => NOW_TIPS, composeTopic, fetchMergedPrs });
    const result = await runWeeklyAuto(d as never);
    expect(result.rotation).toBe("business-tips");
    expect(result.outcome).toBe("created");
    expect(fetchMergedPrs).not.toHaveBeenCalled();
    expect(d.listRecentTitles).toHaveBeenCalledWith(
      "business-tips",
      TOPIC_DEDUPE_TITLES,
      DB
    );
    expect(composeTopic).toHaveBeenCalledWith("business-tips", [], ["Old tips post"]);
  });

  it("honors draft mode and the image toggle on topic weeks", async () => {
    const insertPost = vi.fn(async (row: Record<string, unknown>) => ({ id: "post-1", ...row }));
    const generateImage = vi.fn();
    const d = deps({
      insertPost: insertPost as never,
      generateImage,
      loadSettings: async () =>
        settings({ digest_as_draft: true, digest_include_image: false })
    });
    await runWeeklyAuto(d as never);
    expect(generateImage).not.toHaveBeenCalled();
    expect(insertPost).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "draft",
        featured_image_path: null,
        featured_image_alt: null
      }),
      DB
    );
  });

  it("treats a lost insert race as already_exists and rethrows genuine failures", async () => {
    const raceD = deps({
      insertPost: vi.fn().mockRejectedValue(new Error("duplicate key")) as never,
      findExisting: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: "winner" } as never)
    });
    expect((await runWeeklyAuto(raceD as never)).outcome).toBe("already_exists");

    const failD = deps({
      insertPost: vi.fn().mockRejectedValue(new Error("db down")) as never
    });
    await expect(runWeeklyAuto(failD as never)).rejects.toThrow("db down");
  });
});

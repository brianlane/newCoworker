/**
 * Rotating-category composers for the weekly auto post: Tutorial,
 * Business Tips, and Feature deep-dive. Same contract as the PR digest —
 * Gemini JSON `{title, excerpt, content}`, the 700-word cap enforced with
 * one retry then a section-boundary truncation, excerpt doubling as the
 * Instagram caption — but grounded per category:
 *
 *   tutorial       — ONE recently shipped feature (the model may only use
 *                    the provided PR material; no invented UI steps).
 *   feature        — the single most impactful shipped feature, in depth.
 *   business-tips  — brand-voice advice for small-business owners; recent
 *                    business-tips titles are provided so topics never
 *                    repeat.
 */

import { logger } from "@/lib/logger";
import { geminiGenerateText } from "@/lib/gemini-generate-content";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  classifyFeaturePrsWithGemini,
  countWords,
  DIGEST_MAX_WINDOW_DAYS,
  DIGEST_MAX_WORDS,
  DIGEST_MIN_WORDS,
  digestGeminiApiKey,
  digestTextModel,
  fetchMergedPrsFromGithub,
  generateDigestImageToBucket,
  isoWeekKey,
  runWeeklyDigest,
  selectFeaturePrs,
  truncateAtSectionBoundary,
  type DigestDraft,
  type MergedPr,
  type WeeklyDigestDeps,
  type WeeklyDigestResult
} from "./weekly-digest";
import {
  blogSlugExists,
  getBlogSettings,
  getPostByDigestWeek,
  insertBlogPost,
  listRecentTitlesByCategory,
  type BlogPostRow,
  type BlogSettingsRow
} from "./db";
import { uniqueBlogSlug } from "./slug";

/** The rotation's non-digest categories. */
export type TopicCategory = "tutorial" | "business-tips" | "feature";

const BRAND_CONTEXT =
  "New Coworker is an AI coworker for small businesses: it answers calls and texts, " +
  "books appointments, and follows up with leads so owners never miss business. " +
  "Audience: busy small-business owners. Write in plain English a 12-year-old could " +
  "understand — short sentences, zero jargon, benefit first. Never call the product " +
  "an answering service.";

const SHARED_RULES =
  `The content body MUST be under ${DIGEST_MAX_WORDS} words, structured with '## ' ` +
  "section headings. The excerpt is 1-2 friendly sentences (it doubles as an " +
  "Instagram caption, so no links and no markdown). " +
  'Respond with JSON: {"title": string, "excerpt": string, "content": string} ' +
  "where content is markdown.";

function topicSystemInstruction(category: TopicCategory): string {
  if (category === "tutorial") {
    return (
      `You write a step-by-step tutorial for the New Coworker blog. ${BRAND_CONTEXT} ` +
      "Pick ONE feature from the shipped-features list the user provides and teach " +
      "owners how to get value from it: what it does, when to use it, and how to " +
      "get started. Ground every claim in the provided material — if the material " +
      "does not describe an exact button or menu, describe the outcome instead of " +
      "inventing UI steps. " +
      SHARED_RULES
    );
  }
  if (category === "feature") {
    return (
      `You write a feature deep-dive for the New Coworker blog. ${BRAND_CONTEXT} ` +
      "Pick the SINGLE most impactful feature from the shipped-features list the " +
      "user provides and explain it in depth: the problem it solves, who benefits, " +
      "and two or three concrete ways an owner would use it. Ground every claim in " +
      "the provided material; never invent capabilities. " +
      SHARED_RULES
    );
  }
  return (
    `You write a practical business-tips article for the New Coworker blog. ${BRAND_CONTEXT} ` +
    "Topic areas: never missing calls or leads, faster follow-up, booking more " +
    "appointments, delegating to an AI coworker, simple marketing habits. Give " +
    "specific, actionable advice an owner can apply this week. The user lists the " +
    "titles of recent business-tips posts — choose a topic that clearly differs " +
    "from all of them. " +
    SHARED_RULES
  );
}

function topicUserText(
  category: TopicCategory,
  features: MergedPr[],
  recentTitles: string[]
): string {
  if (category === "business-tips") {
    return recentTitles.length
      ? `Recent business-tips posts (do NOT repeat these topics):\n${recentTitles
          .map((t) => `- ${t}`)
          .join("\n")}`
      : "This is the first business-tips post — pick any strong topic.";
  }
  return `Recently shipped features:\n${features
    .map((p) => `- ${p.title}${p.body ? `: ${p.body.slice(0, 300).replace(/\s+/g, " ")}` : ""}`)
    .join("\n")}`;
}

/**
 * Compose one rotating-category post. Same 700-word enforcement as the
 * digest: prompt cap, one harder retry, then section-boundary truncation.
 */
export async function composeTopicWithGemini(
  category: TopicCategory,
  features: MergedPr[],
  recentTitles: string[],
  generateText: typeof geminiGenerateText = geminiGenerateText
): Promise<DigestDraft> {
  const userText = topicUserText(category, features, recentTitles);

  const generateOnce = async (nudge: string): Promise<DigestDraft> => {
    const raw = await generateText({
      apiKey: digestGeminiApiKey(),
      model: digestTextModel(),
      systemInstruction: topicSystemInstruction(category) + nudge,
      userText,
      responseMimeType: "application/json",
      thinkingLevel: "low",
      maxOutputTokens: 4096
    });
    const parsed = JSON.parse(raw) as Partial<DigestDraft>;
    if (!parsed.title || !parsed.excerpt || !parsed.content) {
      throw new Error(`weekly-topics: ${category} draft missing fields`);
    }
    return { title: parsed.title, excerpt: parsed.excerpt, content: parsed.content };
  };

  let draft = await generateOnce("");
  if (countWords(draft.content) > DIGEST_MAX_WORDS) {
    draft = await generateOnce(
      ` Your previous attempt was too long — keep the content body strictly under ${DIGEST_MAX_WORDS} words this time.`
    );
    if (countWords(draft.content) > DIGEST_MAX_WORDS) {
      draft = { ...draft, content: truncateAtSectionBoundary(draft.content, DIGEST_MAX_WORDS) };
    }
  }
  return draft;
}

// --------------------------------------------------------------------------
// The weekly rotation
// --------------------------------------------------------------------------

/** The 4-week cycle, indexed by ISO week number modulo 4. */
export const WEEKLY_ROTATION = [
  "platform-updates",
  "tutorial",
  "business-tips",
  "feature"
] as const;

export type RotationCategory = (typeof WEEKLY_ROTATION)[number];

/** Rotation slot for a week key like "2026-W30" (30 % 4 = 2 → business-tips). */
export function rotationCategoryForWeek(weekKey: string): RotationCategory {
  const week = Number.parseInt(weekKey.split("-W")[1] ?? "0", 10);
  return WEEKLY_ROTATION[week % WEEKLY_ROTATION.length];
}

function topicToggle(settings: BlogSettingsRow, category: TopicCategory): boolean {
  if (category === "tutorial") return settings.auto_tutorial_enabled;
  if (category === "business-tips") return settings.auto_business_tips_enabled;
  return settings.auto_feature_enabled;
}

/** How many recent same-category titles the dedupe prompt sees. */
export const TOPIC_DEDUPE_TITLES = 10;

export type WeeklyAutoDeps = WeeklyDigestDeps & {
  composeTopic?: typeof composeTopicWithGemini;
  listRecentTitles?: typeof listRecentTitlesByCategory;
  slugExists?: typeof blogSlugExists;
};

export type WeeklyAutoResult = WeeklyDigestResult & {
  /** The rotation slot this week landed on. */
  rotation: RotationCategory;
  /** True when a topic week fell back to the PR digest. */
  fellBack: boolean;
};

/**
 * The Monday cron's entry point: one post per week, category by rotation.
 * A topic week that is disabled, ungrounded (no feature PRs for tutorial /
 * deep-dive), or composes under DIGEST_MIN_WORDS falls back to the PR
 * digest, so `digest_enabled` remains the master off-switch and the
 * features of a skipped week keep rolling forward.
 */
export async function runWeeklyAuto(deps: WeeklyAutoDeps = {}): Promise<WeeklyAutoResult> {
  /* c8 ignore start -- production defaults; tests inject */
  const db = deps.client ?? (await createSupabaseServiceClient());
  const loadSettings = deps.loadSettings ?? getBlogSettings;
  const findExisting = deps.findExisting ?? getPostByDigestWeek;
  const insertPost = deps.insertPost ?? insertBlogPost;
  const fetchMergedPrs =
    deps.fetchMergedPrs ?? ((since, until) => fetchMergedPrsFromGithub(since, until));
  const classify = deps.classify ?? classifyFeaturePrsWithGemini;
  const composeTopic = deps.composeTopic ?? composeTopicWithGemini;
  const listRecentTitles = deps.listRecentTitles ?? listRecentTitlesByCategory;
  const slugExists = deps.slugExists ?? blogSlugExists;
  const generateImage =
    deps.generateImage ?? ((draft, week) => generateDigestImageToBucket(draft, week, db));
  const now = deps.now ?? (() => new Date());
  /* c8 ignore stop */

  const nowDate = now();
  const weekKey = isoWeekKey(new Date(nowDate.getTime() - 7 * 24 * 60 * 60 * 1000));
  const rotation = rotationCategoryForWeek(weekKey);

  const runDigest = async (fellBack: boolean): Promise<WeeklyAutoResult> => ({
    ...(await runWeeklyDigest(deps)),
    rotation,
    fellBack
  });

  if (rotation === "platform-updates") {
    return runDigest(false);
  }

  const base: Omit<WeeklyAutoResult, "outcome"> = {
    weekKey,
    rotation,
    fellBack: false,
    mergedCount: 0,
    featureCount: 0,
    postId: null
  };

  const settings = await loadSettings(db);
  if (!settings.digest_enabled) {
    // Master off-switch: no auto posts at all.
    return { ...base, outcome: "disabled" };
  }
  if (await findExisting(weekKey, db)) {
    return { ...base, outcome: "already_exists" };
  }
  if (!topicToggle(settings, rotation)) {
    logger.info("weekly-auto: rotation category disabled — falling back to the digest", {
      weekKey,
      rotation
    });
    return runDigest(true);
  }

  // Grounding: shipped features from the trailing rotation window for
  // tutorial / deep-dive; recent same-category titles for business-tips.
  let features: MergedPr[] = [];
  if (rotation !== "business-tips") {
    const untilIso = nowDate.toISOString();
    const sinceIso = new Date(
      nowDate.getTime() - DIGEST_MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();
    features = await selectFeaturePrs(await fetchMergedPrs(sinceIso, untilIso), classify);
    if (features.length === 0) {
      logger.info("weekly-auto: no feature grounding — falling back to the digest", {
        weekKey,
        rotation
      });
      return runDigest(true);
    }
  }
  const recentTitles =
    rotation === "business-tips"
      ? await listRecentTitles(rotation, TOPIC_DEDUPE_TITLES, db)
      : [];

  const draft = await composeTopic(rotation, features, recentTitles);
  if (countWords(draft.content) < DIGEST_MIN_WORDS) {
    logger.info("weekly-auto: composed topic too thin — falling back to the digest", {
      weekKey,
      rotation,
      words: countWords(draft.content)
    });
    return runDigest(true);
  }

  const imagePath = settings.digest_include_image ? await generateImage(draft, weekKey) : null;

  const slug = await uniqueBlogSlug(`${rotation} ${draft.title}`, (candidate) =>
    slugExists(candidate, db)
  );

  let post: BlogPostRow;
  try {
    post = await insertPost(
      {
        slug,
        title: draft.title,
        excerpt: draft.excerpt,
        content: draft.content,
        category: rotation,
        source: "weekly_digest",
        digest_week: weekKey,
        featured_image_path: imagePath,
        featured_image_alt: imagePath ? draft.title : null,
        // scheduled_for records the run instant on every auto post (draft
        // mode included) — same bookkeeping as the digest.
        status: settings.digest_as_draft ? ("draft" as const) : ("scheduled" as const),
        scheduled_for: nowDate.toISOString()
      },
      db
    );
  } catch (err) {
    if (await findExisting(weekKey, db)) {
      logger.info("weekly-auto: lost the insert race to a concurrent run", { weekKey });
      return { ...base, outcome: "already_exists" };
    }
    throw err;
  }

  logger.info("weekly-auto: topic post created", {
    postId: post.id,
    weekKey,
    rotation,
    asDraft: settings.digest_as_draft
  });

  return {
    ...base,
    featureCount: features.length,
    postId: post.id,
    outcome: "created"
  };
}

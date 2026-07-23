/**
 * Weekly PR-digest post — the engine behind the Monday blog-weekly-digest
 * cron (pg_cron → Edge → /api/internal/blog-weekly-digest → here).
 *
 * One run:
 *   1. Honor the admin toggles (`digest_enabled`) and the per-week
 *      idempotency key (`digest_week` unique).
 *   2. List PRs merged into main over the past 7 days (GitHub REST).
 *      The volume bar: MORE THAN 10 merged PRs, or the week is too quiet
 *      to be worth a post.
 *   3. Keep FEATURES ONLY — customers never read "we fixed bugs":
 *      - label `blog: skip` (or Dependabot / docs / test / chore / bump /
 *        one-shot titles) excludes a PR outright;
 *      - label `blog: feature` includes it;
 *      - the unlabeled remainder is classified by Gemini (JSON mode), and
 *        a classifier failure conservatively drops them.
 *   4. Gemini writes the post: plain English a 12-year-old could follow,
 *      UNDER 700 words — the cap is prompted, then verified in code
 *      (regenerate once, then truncate at a section boundary).
 *   5. Generate a 16:9 featured image (unless `digest_include_image` is
 *      off) into the public blog-images bucket.
 *   6. Insert the post `scheduled` for now — the 5-minute publish sweep
 *      takes it live with the full fan-out — or as a `draft` when
 *      `digest_as_draft` is on.
 *
 * Environment: GITHUB_DIGEST_TOKEN + GITHUB_DIGEST_REPO ("owner/name"),
 * GOOGLE_API_KEY (or GEMINI_API_KEY), optional BLOG_DIGEST_TEXT_MODEL /
 * BLOG_DIGEST_IMAGE_MODEL overrides.
 */

import { logger } from "@/lib/logger";
import { geminiGenerateText } from "@/lib/gemini-generate-content";
import { geminiGenerateImage } from "@/lib/gemini-generate-image";
import { stripEmDashesFromDraft } from "./copy";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  BLOG_IMAGES_BUCKET,
  getBlogSettings,
  getLatestWeeklyDigestPost,
  getPostByDigestWeek,
  insertBlogPost,
  type BlogPostRow
} from "./db";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** A week must merge MORE THAN this many PRs to earn a digest post. */
export const DIGEST_MIN_MERGED_PRS = 10;

/** Hard ceiling on the digest body, enforced after generation. */
export const DIGEST_MAX_WORDS = 700;

/**
 * A composed digest under this many words is too thin to publish — the run
 * skips, and because every run's PR window starts at the LAST digest post,
 * the skipped week's features roll into the next week's post.
 */
export const DIGEST_MIN_WORDS = 150;

/**
 * Ceiling on the rollover window: a long gap (digest disabled for a month,
 * repeated quiet weeks) never balloons into a mega-post covering months.
 */
export const DIGEST_MAX_WINDOW_DAYS = 28;

export const DEFAULT_DIGEST_TEXT_MODEL = "gemini-3.5-flash";
export const DEFAULT_DIGEST_IMAGE_MODEL = "gemini-3.1-flash-lite-image";

export type MergedPr = {
  number: number;
  title: string;
  body: string;
  labels: string[];
  authorLogin: string;
};

/** ISO-8601 week key, e.g. "2026-W30" (the digest_week idempotency key). */
export function isoWeekKey(date: Date): string {
  // Thursday of the current week decides the ISO year/week.
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function countWords(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length;
}

/**
 * Trim an over-long markdown body to the word cap by dropping trailing
 * `##` sections whole — a truncated post must still end cleanly.
 * Falls back to a hard word cut when there is only one section.
 */
export function truncateAtSectionBoundary(content: string, maxWords: number): string {
  if (countWords(content) <= maxWords) return content;
  const sections = content.split(/\n(?=## )/);
  while (sections.length > 1) {
    sections.pop();
    const joined = sections.join("\n");
    if (countWords(joined) <= maxWords) return joined.trimEnd();
  }
  return content.trim().split(/\s+/).slice(0, maxWords).join(" ");
}

// --------------------------------------------------------------------------
// GitHub
// --------------------------------------------------------------------------

type GithubPullResponse = Array<{
  number: number;
  title: string;
  body: string | null;
  merged_at: string | null;
  labels: Array<{ name: string }>;
  user: { login: string } | null;
  base: { ref: string };
}>;

export type FetchMergedPrs = (sinceIso: string, untilIso: string) => Promise<MergedPr[]>;

/** Page cap for the merged-PR listing: 5 x 100 comfortably covers the
 * busiest week to date (~60 merges) with a wide safety margin. */
export const GITHUB_PR_PAGE_LIMIT = 5;

/**
 * PRs merged into main inside the window. Pages through the closed-PR
 * listing (sorted by `updated` desc) so a busy week is never undercounted
 * by a single-page fetch; paging stops early once a whole page falls
 * outside the window (a closed PR's `updated_at` is >= its `merged_at`,
 * so anything merged in-window sits in the still-recent pages).
 */
export async function fetchMergedPrsFromGithub(
  sinceIso: string,
  untilIso: string,
  fetchImpl: typeof fetch = fetch
): Promise<MergedPr[]> {
  const repo = (process.env.GITHUB_DIGEST_REPO ?? "").trim();
  const token = (process.env.GITHUB_DIGEST_TOKEN ?? "").trim();
  if (!repo || !token) {
    throw new Error("weekly-digest: GITHUB_DIGEST_REPO / GITHUB_DIGEST_TOKEN not configured");
  }
  const merged: MergedPr[] = [];
  for (let page = 1; page <= GITHUB_PR_PAGE_LIMIT; page++) {
    const url =
      `https://api.github.com/repos/${repo}/pulls` +
      `?state=closed&base=main&sort=updated&direction=desc&per_page=100&page=${page}`;
    const response = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      }
    });
    if (!response.ok) {
      throw new Error(`weekly-digest: GitHub list PRs failed (${response.status})`);
    }
    const pulls = (await response.json()) as GithubPullResponse;
    for (const p of pulls) {
      if (p.merged_at !== null && p.merged_at >= sinceIso && p.merged_at < untilIso) {
        merged.push({
          number: p.number,
          title: p.title,
          body: p.body ?? "",
          labels: p.labels.map((l) => l.name),
          authorLogin: p.user?.login ?? ""
        });
      }
    }
    // Short page = last page; a page with zero in-window merges means the
    // rest of the (updated-desc) listing is older still.
    if (pulls.length < 100) break;
    const anyRecent = pulls.some((p) => p.merged_at !== null && p.merged_at >= sinceIso);
    if (!anyRecent) break;
  }
  return merged;
}

// --------------------------------------------------------------------------
// Feature filtering (labels first, classifier fallback)
// --------------------------------------------------------------------------

const NOISE_TITLE_RE = /^(docs?|tests?|ci|chore|bump|revert|one-shot|oneshot)\b/i;

export function isNoisePr(pr: MergedPr): boolean {
  if (pr.authorLogin.toLowerCase().startsWith("dependabot")) return true;
  if (pr.labels.includes("blog: skip")) return true;
  return NOISE_TITLE_RE.test(pr.title.trim());
}

export type ClassifyPrs = (prs: MergedPr[]) => Promise<Set<number>>;

/** Shared Gemini env resolution for the digest's text calls. */
export function digestGeminiApiKey(): string {
  return process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? "";
}

export function digestTextModel(): string {
  return process.env.BLOG_DIGEST_TEXT_MODEL ?? DEFAULT_DIGEST_TEXT_MODEL;
}

/**
 * One batched Gemini JSON call: which of these PRs are customer-visible
 * FEATURES (new capabilities or meaningful improvements an owner would
 * notice), not bug fixes / internal / ops work?
 */
export async function classifyFeaturePrsWithGemini(
  prs: MergedPr[],
  generateText: typeof geminiGenerateText = geminiGenerateText
): Promise<Set<number>> {
  const apiKey = digestGeminiApiKey();
  const listing = prs
    .map((p) => `#${p.number}: ${p.title}\n${p.body.slice(0, 300)}`)
    .join("\n---\n");
  const raw = await generateText({
    apiKey,
    model: digestTextModel(),
    systemInstruction:
      "You review a software team's merged pull requests and pick out only the " +
      "ones a CUSTOMER would care about: new features and meaningful improvements " +
      "they can see or use. Exclude bug fixes, refactors, tests, docs, CI, " +
      "dependency bumps, internal tooling, and operational work. " +
      'Respond with JSON: {"featureNumbers": [<pr numbers>]}.',
    userText: listing,
    responseMimeType: "application/json",
    thinkingLevel: "low",
    maxOutputTokens: 2048
  });
  const parsed = JSON.parse(raw) as { featureNumbers?: unknown };
  const numbers = Array.isArray(parsed.featureNumbers) ? parsed.featureNumbers : [];
  return new Set(numbers.filter((n): n is number => typeof n === "number"));
}

/**
 * Features only: `blog: skip` / noise excluded, `blog: feature` included,
 * the unlabeled remainder classified. A classifier failure drops the
 * unlabeled PRs (conservative — better a shorter digest than bug-fix copy).
 */
export async function selectFeaturePrs(
  prs: MergedPr[],
  classify: ClassifyPrs
): Promise<MergedPr[]> {
  const candidates = prs.filter((p) => !isNoisePr(p));
  const labeled = candidates.filter((p) => p.labels.includes("blog: feature"));
  const unlabeled = candidates.filter((p) => !p.labels.includes("blog: feature"));

  let classifiedNumbers = new Set<number>();
  if (unlabeled.length > 0) {
    try {
      classifiedNumbers = await classify(unlabeled);
    } catch (err) {
      logger.warn("weekly-digest: feature classification failed — dropping unlabeled PRs", {
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  return [...labeled, ...unlabeled.filter((p) => classifiedNumbers.has(p.number))];
}

// --------------------------------------------------------------------------
// Post composition
// --------------------------------------------------------------------------

export type DigestDraft = { title: string; excerpt: string; content: string };

export type ComposeDigest = (prs: MergedPr[], weekKey: string) => Promise<DigestDraft>;

const DIGEST_SYSTEM_INSTRUCTION =
  "You write the weekly 'what shipped' post for the New Coworker blog. " +
  "New Coworker is an AI coworker for small businesses: it answers calls and texts, " +
  "books appointments, and follows up with leads so owners never miss business. " +
  "Audience: busy small-business owners. Write in plain English a 12-year-old could " +
  "understand — short sentences, zero jargon, benefit first ('your coworker can now…'). " +
  "Cover ONLY the features provided; never mention bug fixes, internal work, or PR numbers. " +
  `The content body MUST be under ${DIGEST_MAX_WORDS} words. Group related features under ` +
  "'## ' section headings. The excerpt is 1-2 friendly sentences (it doubles as an " +
  "Instagram caption, so no links and no markdown). Never use em dashes; use commas " +
  "or periods instead. " +
  'Respond with JSON: {"title": string, "excerpt": string, "content": string} ' +
  "where content is markdown.";

export async function composeDigestWithGemini(
  prs: MergedPr[],
  weekKey: string,
  generateText: typeof geminiGenerateText = geminiGenerateText
): Promise<DigestDraft> {
  const apiKey = digestGeminiApiKey();
  const model = digestTextModel();
  const listing = prs
    .map((p) => `- ${p.title}${p.body ? `: ${p.body.slice(0, 400)}` : ""}`)
    .join("\n");

  const generateOnce = async (extraNudge: string): Promise<DigestDraft> => {
    const raw = await generateText({
      apiKey,
      model,
      systemInstruction: DIGEST_SYSTEM_INSTRUCTION + extraNudge,
      userText: `Week ${weekKey}. Features shipped this week:\n${listing}`,
      responseMimeType: "application/json",
      thinkingLevel: "low",
      maxOutputTokens: 4096
    });
    const parsed = JSON.parse(raw) as Partial<DigestDraft>;
    // House rule: no em dashes in blog copy, ever — enforced (not just
    // prompted), and BEFORE the emptiness check so a dash-only field
    // counts as missing.
    const cleaned = stripEmDashesFromDraft({
      title: parsed.title ?? "",
      excerpt: parsed.excerpt ?? "",
      content: parsed.content ?? ""
    });
    if (!cleaned.title.trim() || !cleaned.excerpt.trim() || !cleaned.content.trim()) {
      throw new Error("weekly-digest: Gemini digest draft missing fields");
    }
    return cleaned;
  };

  let draft = await generateOnce("");
  if (countWords(draft.content) > DIGEST_MAX_WORDS) {
    // One retry with a harder cap nudge, then trim at a section boundary.
    draft = await generateOnce(
      ` Your previous attempt was too long — keep the content body strictly under ${DIGEST_MAX_WORDS} words this time.`
    );
    if (countWords(draft.content) > DIGEST_MAX_WORDS) {
      draft = {
        ...draft,
        content: truncateAtSectionBoundary(draft.content, DIGEST_MAX_WORDS)
      };
    }
  }
  return draft;
}

export type GenerateDigestImage = (
  draft: DigestDraft,
  weekKey: string
) => Promise<string | null>;

/**
 * A 16:9 featured image for the digest, uploaded to the public blog-images
 * bucket. Best-effort: a generation/upload failure returns null and the
 * post ships without an image.
 */
export async function generateDigestImageToBucket(
  draft: DigestDraft,
  weekKey: string,
  db: SupabaseClient,
  generateImage: typeof geminiGenerateImage = geminiGenerateImage
): Promise<string | null> {
  try {
    const image = await generateImage({
      apiKey: digestGeminiApiKey(),
      model: process.env.BLOG_DIGEST_IMAGE_MODEL ?? DEFAULT_DIGEST_IMAGE_MODEL,
      prompt:
        "Modern, friendly blog hero illustration for a small-business software " +
        `update post titled "${draft.title}". Flat vector style, dark teal and ` +
        "green palette, no text, no logos.",
      aspectRatio: "16:9"
    });
    const ext = image.mimeType === "image/jpeg" ? "jpg" : "png";
    const path = `digest-${weekKey.toLowerCase()}.${ext}`;
    const { error } = await db.storage
      .from(BLOG_IMAGES_BUCKET)
      .upload(path, image.bytes, { contentType: image.mimeType, upsert: true });
    if (error) throw new Error(error.message);
    return path;
  } catch (err) {
    logger.warn("weekly-digest: featured image generation failed — posting without one", {
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

// --------------------------------------------------------------------------
// The run
// --------------------------------------------------------------------------

export type WeeklyDigestDeps = {
  client?: SupabaseClient;
  loadSettings?: typeof getBlogSettings;
  findExisting?: typeof getPostByDigestWeek;
  findLatestDigest?: typeof getLatestWeeklyDigestPost;
  insertPost?: typeof insertBlogPost;
  fetchMergedPrs?: FetchMergedPrs;
  classify?: ClassifyPrs;
  compose?: ComposeDigest;
  generateImage?: GenerateDigestImage;
  now?: () => Date;
};

export type WeeklyDigestResult = {
  outcome:
    | "created"
    | "disabled"
    | "already_exists"
    | "below_threshold"
    | "no_features"
    /** Composed under DIGEST_MIN_WORDS — skipped; rolls into next week. */
    | "too_thin";
  weekKey: string;
  mergedCount: number;
  featureCount: number;
  postId: string | null;
};

export async function runWeeklyDigest(deps: WeeklyDigestDeps = {}): Promise<WeeklyDigestResult> {
  /* c8 ignore start -- production defaults; tests inject */
  const db = deps.client ?? (await createSupabaseServiceClient());
  const loadSettings = deps.loadSettings ?? getBlogSettings;
  const findExisting = deps.findExisting ?? getPostByDigestWeek;
  const findLatestDigest = deps.findLatestDigest ?? getLatestWeeklyDigestPost;
  const insertPost = deps.insertPost ?? insertBlogPost;
  const fetchMergedPrs =
    deps.fetchMergedPrs ?? ((since, until) => fetchMergedPrsFromGithub(since, until));
  const classify = deps.classify ?? classifyFeaturePrsWithGemini;
  const compose = deps.compose ?? composeDigestWithGemini;
  const generateImage =
    deps.generateImage ?? ((draft, week) => generateDigestImageToBucket(draft, week, db));
  const now = deps.now ?? (() => new Date());
  /* c8 ignore stop */

  const nowDate = now();
  // The digest covers the week that just ENDED — key it by the ISO week of
  // (now − 7 days). Stable across retries any day of the current week: a
  // Monday run and a Wednesday re-run both key the same prior week, so the
  // digest_week idempotency probe actually catches the duplicate.
  const weekKey = isoWeekKey(new Date(nowDate.getTime() - 7 * 24 * 60 * 60 * 1000));
  const base: Omit<WeeklyDigestResult, "outcome"> = {
    weekKey,
    mergedCount: 0,
    featureCount: 0,
    postId: null
  };

  const settings = await loadSettings(db);
  if (!settings.digest_enabled) {
    return { ...base, outcome: "disabled" };
  }
  if (await findExisting(weekKey, db)) {
    return { ...base, outcome: "already_exists" };
  }

  // The window starts where the LAST digest post left off (its creation
  // instant), so a skipped week — quiet, feature-less, or too thin — rolls
  // its findings into the next post instead of being lost. Capped at
  // DIGEST_MAX_WINDOW_DAYS so a long gap can't balloon into a mega-post;
  // first-ever run falls back to the plain trailing week.
  const untilIso = nowDate.toISOString();
  const weekAgoMs = nowDate.getTime() - 7 * 24 * 60 * 60 * 1000;
  const windowFloorMs = nowDate.getTime() - DIGEST_MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const lastDigest = await findLatestDigest(db);
  // The anchor is the previous run's window END (`scheduled_for` — recorded
  // on every digest row, draft mode included, precisely for this). Falling
  // back to `created_at` (older rows / admin-cleared schedules) can miss
  // merges that landed during that run's compose window — acceptable
  // seconds-scale residual on a rare path.
  const anchorIso = lastDigest ? (lastDigest.scheduled_for ?? lastDigest.created_at) : null;
  const sinceMs = anchorIso ? Math.max(windowFloorMs, Date.parse(anchorIso)) : weekAgoMs;
  const sinceIso = new Date(sinceMs).toISOString();
  const merged = await fetchMergedPrs(sinceIso, untilIso);
  if (merged.length <= DIGEST_MIN_MERGED_PRS) {
    return { ...base, mergedCount: merged.length, outcome: "below_threshold" };
  }

  const features = await selectFeaturePrs(merged, classify);
  if (features.length === 0) {
    return { ...base, mergedCount: merged.length, outcome: "no_features" };
  }

  const draft = await compose(features, weekKey);
  // A thin week isn't worth a post — skip BEFORE spending on the image;
  // the anchored window above carries these features into next week.
  if (countWords(draft.content) < DIGEST_MIN_WORDS) {
    logger.info("weekly-digest: composed digest too thin — rolling into next week", {
      weekKey,
      words: countWords(draft.content),
      featureCount: features.length
    });
    return {
      ...base,
      mergedCount: merged.length,
      featureCount: features.length,
      outcome: "too_thin"
    };
  }
  const imagePath = settings.digest_include_image
    ? await generateImage(draft, weekKey)
    : null;

  let post: BlogPostRow;
  try {
    post = await insertPost(
      {
        slug: `what-we-shipped-${weekKey.toLowerCase()}`,
        title: draft.title,
        excerpt: draft.excerpt,
        content: draft.content,
        category: "platform-updates",
        source: "weekly_digest",
        digest_week: weekKey,
        featured_image_path: imagePath,
        featured_image_alt: imagePath ? draft.title : null,
        // `scheduled_for` doubles as the covered window's END (= untilIso):
        // the next run anchors on it, so merges landing DURING this run's
        // compose/image/insert are never skipped. Draft-mode rows carry it
        // too — the publish sweep only picks status "scheduled", so it is
        // inert there beyond prefilling the admin schedule picker.
        status: settings.digest_as_draft ? ("draft" as const) : ("scheduled" as const),
        scheduled_for: untilIso
      },
      db
    );
  } catch (err) {
    // Two overlapping runs can both pass the findExisting probe; the loser
    // hits the unique digest_week/slug constraint. That is the idempotency
    // working, not a failure — report it as already_exists.
    if (await findExisting(weekKey, db)) {
      logger.info("weekly-digest: lost the insert race to a concurrent run", { weekKey });
      return { ...base, mergedCount: merged.length, outcome: "already_exists" };
    }
    throw err;
  }

  logger.info("weekly-digest: post created", {
    postId: post.id,
    weekKey,
    mergedCount: merged.length,
    featureCount: features.length,
    asDraft: settings.digest_as_draft
  });

  return {
    weekKey,
    mergedCount: merged.length,
    featureCount: features.length,
    postId: post.id,
    outcome: "created"
  };
}

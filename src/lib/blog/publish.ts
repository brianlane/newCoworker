/**
 * Blog publish pipeline — the engine behind the 5-minute blog-publish-sweep
 * (pg_cron → Edge → /api/internal/blog-publish-sweep → here) and the admin
 * "Publish now" button.
 *
 * One publish:
 *   1. (Sweep only) promote a due `scheduled` post to `published` via a
 *      guarded transition — an admin edit racing the sweep wins cleanly.
 *   2. Fan out side effects, each independently best-effort:
 *      - Email every active blog subscriber (Resend), locale-aware copy
 *        with a tokenized one-click unsubscribe.
 *      - Cross-post to Instagram: insert a post into the designated
 *        business's Marketing composer (`social_posts`) with the featured
 *        image and the post's EXCERPT as the caption (no link — links
 *        aren't clickable in IG captions). Draft by default; the
 *        `instagram_publish_immediately` toggle schedules it now instead,
 *        and the existing social-post-sweep publishes it.
 *
 * Side-effect failures never un-publish the post — they are logged and
 * reported in the sweep summary.
 */

import { logger } from "@/lib/logger";
import { sendOwnerEmail } from "@/lib/email/client";
import { buildBlogNewPostEmail } from "@/lib/email/templates/blog-new-post";
import { insertSocialPost, SOCIAL_CAPTION_MAX_LENGTH } from "@/lib/social/db";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  blogImagePublicUrl,
  getBlogSettings,
  listActiveBlogSubscribers,
  listDueScheduledBlogPosts,
  transitionBlogPost,
  type BlogPostRow
} from "./db";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type BlogPublishDeps = {
  client?: SupabaseClient;
  /** Injectable collaborators (tests). */
  loadSettings?: typeof getBlogSettings;
  loadSubscribers?: typeof listActiveBlogSubscribers;
  sendEmail?: typeof sendOwnerEmail;
  insertSocial?: typeof insertSocialPost;
  now?: () => Date;
};

export type BlogPublishFanOut = {
  emailed: number;
  emailErrors: number;
  crossPosted: boolean;
};

function appBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

/**
 * The subscriber-facing copy for a locale: Spanish subscribers get the
 * translated fields when the post carries them, English otherwise.
 */
export function postCopyForLocale(
  post: Pick<BlogPostRow, "title" | "excerpt" | "title_es" | "excerpt_es">,
  locale: "en" | "es"
): { title: string; excerpt: string; locale: "en" | "es" } {
  if (locale === "es" && post.title_es) {
    return { title: post.title_es, excerpt: post.excerpt_es ?? post.excerpt, locale: "es" };
  }
  return { title: post.title, excerpt: post.excerpt, locale: "en" };
}

/**
 * Run the on-publish side effects for a post that JUST became published.
 * Never throws: each channel degrades independently with a logged warning.
 */
export async function runBlogPublishSideEffects(
  post: BlogPostRow,
  deps: BlogPublishDeps = {}
): Promise<BlogPublishFanOut> {
  /* c8 ignore start -- production defaults; tests inject */
  const db = deps.client ?? (await createSupabaseServiceClient());
  const loadSettings = deps.loadSettings ?? getBlogSettings;
  const loadSubscribers = deps.loadSubscribers ?? listActiveBlogSubscribers;
  const sendEmail = deps.sendEmail ?? sendOwnerEmail;
  const insertSocial = deps.insertSocial ?? insertSocialPost;
  const now = deps.now ?? (() => new Date());
  /* c8 ignore stop */

  const result: BlogPublishFanOut = { emailed: 0, emailErrors: 0, crossPosted: false };
  const siteUrl = appBaseUrl();

  // --- Subscriber email fan-out -------------------------------------------
  const resendKey = (process.env.RESEND_API_KEY ?? "").trim();
  if (!resendKey) {
    logger.warn("blog-publish: RESEND_API_KEY unset — skipping subscriber email", {
      postId: post.id
    });
  } else {
    let subscribers: Awaited<ReturnType<typeof loadSubscribers>> = [];
    try {
      subscribers = await loadSubscribers(db);
    } catch (err) {
      result.emailErrors += 1;
      logger.warn("blog-publish: loading subscribers failed", {
        postId: post.id,
        error: err instanceof Error ? err.message : String(err)
      });
    }
    for (const subscriber of subscribers) {
      try {
        const copy = postCopyForLocale(post, subscriber.locale);
        const email = buildBlogNewPostEmail({
          title: copy.title,
          excerpt: copy.excerpt,
          slug: post.slug,
          recipientEmail: subscriber.email,
          siteUrl,
          locale: copy.locale
        });
        await sendEmail(resendKey, subscriber.email, email.subject, {
          text: email.text,
          html: email.html,
          unsubscribeUrl: `${siteUrl}/api/blog/unsubscribe?token=${encodeURIComponent(
            subscriber.unsubscribe_token
          )}`
        });
        result.emailed += 1;
      } catch (err) {
        result.emailErrors += 1;
        logger.warn("blog-publish: subscriber email failed", {
          postId: post.id,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
  }

  // --- Instagram cross-post ------------------------------------------------
  try {
    const settings = await loadSettings(db);
    const mediaUrl = blogImagePublicUrl(post.featured_image_path);
    if (!settings.instagram_business_id) {
      logger.info("blog-publish: no Instagram cross-post business designated", {
        postId: post.id
      });
    } else if (!mediaUrl) {
      // Instagram feed posts require an image — a post without one skips.
      logger.info("blog-publish: post has no featured image — skipping cross-post", {
        postId: post.id
      });
    } else {
      const caption = post.excerpt.slice(0, SOCIAL_CAPTION_MAX_LENGTH);
      await insertSocial(
        {
          business_id: settings.instagram_business_id,
          caption,
          media_url: mediaUrl,
          ...(settings.instagram_publish_immediately
            ? { status: "scheduled" as const, publish_at: now().toISOString() }
            : { status: "draft" as const })
        },
        db
      );
      result.crossPosted = true;
    }
  } catch (err) {
    logger.warn("blog-publish: Instagram cross-post failed", {
      postId: post.id,
      error: err instanceof Error ? err.message : String(err)
    });
  }

  return result;
}

export type BlogSweepResult = {
  published: number;
  emailed: number;
  emailErrors: number;
  crossPosted: number;
  errors: Array<{ postId: string; message: string }>;
};

/**
 * One sweep pass: flip due scheduled posts to published (guarded — a racing
 * admin edit wins) and fan out the side effects for each winner.
 */
export async function processBlogPublishSweep(
  deps: BlogPublishDeps = {}
): Promise<BlogSweepResult> {
  /* c8 ignore start -- production defaults; tests inject */
  const db = deps.client ?? (await createSupabaseServiceClient());
  const now = deps.now ?? (() => new Date());
  /* c8 ignore stop */

  const result: BlogSweepResult = {
    published: 0,
    emailed: 0,
    emailErrors: 0,
    crossPosted: 0,
    errors: []
  };
  const nowIso = now().toISOString();

  for (const post of await listDueScheduledBlogPosts(nowIso, db)) {
    try {
      const claimed = await transitionBlogPost(
        post.id,
        "scheduled",
        { status: "published", published_at: nowIso },
        db
      );
      if (!claimed) continue;
      result.published += 1;

      const fanOut = await runBlogPublishSideEffects(
        { ...post, status: "published", published_at: nowIso },
        { ...deps, client: db, now }
      );
      result.emailed += fanOut.emailed;
      result.emailErrors += fanOut.emailErrors;
      if (fanOut.crossPosted) result.crossPosted += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("blog-publish-sweep: post pass failed", { postId: post.id, message });
      result.errors.push({ postId: post.id, message });
    }
  }

  return result;
}

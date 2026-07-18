/**
 * Instagram post publishing — the engine behind the per-minute
 * social-post-sweep (pg_cron → Edge → /api/internal/social-post-sweep →
 * here).
 *
 * One pass:
 *   1. Promote due scheduled posts to `publishing` (guarded transition —
 *      an owner cancel racing the promotion wins cleanly).
 *   2. Publish each through the Instagram Graph API two-step (media
 *      container → media_publish) with the tenant's meta_connections page
 *      token and linked IG professional account; stamp `published` +
 *      `ig_media_id`, or `failed` + a human-readable error.
 *   3. Dead-letter posts stuck in `publishing` past the stale window (a
 *      crash between promotion and outcome): marked failed, NOT retried —
 *      Meta may already hold the container, and a duplicate feed post is
 *      worse than the owner re-scheduling by hand.
 *
 * A missing/paused Meta connection (or a Page with no linked IG
 * professional account) fails the post with plain-words guidance instead
 * of throwing — config gaps are the owner's to fix, not transient errors.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getMetaConnection, type MetaConnectionRow } from "@/lib/db/meta-connections";
import {
  createInstagramMediaContainer,
  publishInstagramMedia
} from "@/lib/meta/client";
import { logger } from "@/lib/logger";
import {
  listDueScheduledPosts,
  listStalePublishingPosts,
  patchSocialPost,
  transitionSocialPost,
  type SocialPostRow
} from "./db";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** A publish stuck this long is a crashed sweep, not a slow Graph call. */
export const SOCIAL_PUBLISH_STALE_MINUTES = 15;

export type SocialSweepResult = {
  promoted: number;
  published: number;
  failed: number;
  /** Stuck `publishing` rows dead-lettered this pass. */
  staled: number;
  errors: Array<{ postId: string; message: string }>;
};

export type SocialSweepDeps = {
  client?: SupabaseClient;
  /** Injectable Graph calls (tests). */
  createContainer?: typeof createInstagramMediaContainer;
  publishMedia?: typeof publishInstagramMedia;
  loadConnection?: typeof getMetaConnection;
  now?: () => Date;
};

/**
 * Publish one promoted post. Returns the failure detail ("" = published).
 * Never throws — the outcome is stamped on the row either way.
 */
async function publishOne(
  db: SupabaseClient,
  post: SocialPostRow,
  deps: Required<Pick<SocialSweepDeps, "createContainer" | "publishMedia" | "loadConnection">>,
  nowIso: string
): Promise<string> {
  let failure = "";
  let igMediaId = "";
  try {
    const connection: MetaConnectionRow | null = await deps.loadConnection(
      post.business_id,
      db
    );
    if (!connection || connection.status !== "active" || !connection.is_active) {
      failure =
        "Facebook connection is missing or paused — reconnect on the Integrations page, then re-schedule.";
    } else if (!connection.instagram_account_id) {
      failure =
        "The connected Facebook Page has no linked Instagram professional account — link one in Meta Business Suite, reconnect, then re-schedule.";
    } else if (!connection.pageToken) {
      failure =
        "The Facebook connection is missing its page credential — reconnect on the Integrations page, then re-schedule.";
    } else {
      const creationId = await deps.createContainer(
        connection.instagram_account_id,
        connection.pageToken,
        post.media_url,
        post.caption
      );
      igMediaId = await deps.publishMedia(
        connection.instagram_account_id,
        connection.pageToken,
        creationId
      );
    }
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }

  if (failure) {
    await patchSocialPost(
      post.business_id,
      post.id,
      { status: "failed", error_detail: failure.slice(0, 500) },
      db
    );
    return failure;
  }
  await patchSocialPost(
    post.business_id,
    post.id,
    { status: "published", published_at: nowIso, ig_media_id: igMediaId, error_detail: null },
    db
  );
  return "";
}

/**
 * One sweep pass. Per-post errors are collected and the sweep continues;
 * promotion is a guarded transition so overlapping sweeps and owner
 * cancels always lose or win cleanly.
 */
export async function processSocialPostSweep(
  deps: SocialSweepDeps = {}
): Promise<SocialSweepResult> {
  /* c8 ignore start -- production defaults; tests inject */
  const db = deps.client ?? (await createSupabaseServiceClient());
  const createContainer = deps.createContainer ?? createInstagramMediaContainer;
  const publishMedia = deps.publishMedia ?? publishInstagramMedia;
  const loadConnection = deps.loadConnection ?? getMetaConnection;
  const now = deps.now ?? (() => new Date());
  /* c8 ignore stop */
  const graph = { createContainer, publishMedia, loadConnection };

  const result: SocialSweepResult = {
    promoted: 0,
    published: 0,
    failed: 0,
    staled: 0,
    errors: []
  };

  const nowIso = now().toISOString();

  // Dead-letter first: a crashed sweep's `publishing` rows are stamped
  // failed before this pass adds new ones, so the stale window is measured
  // against THEIR promotion time, not ours.
  const cutoffIso = new Date(
    now().getTime() - SOCIAL_PUBLISH_STALE_MINUTES * 60 * 1000
  ).toISOString();
  for (const post of await listStalePublishingPosts(cutoffIso, db)) {
    try {
      await patchSocialPost(
        post.business_id,
        post.id,
        {
          status: "failed",
          error_detail:
            "Publishing was interrupted — check Instagram for a duplicate before re-scheduling."
        },
        db
      );
      result.staled += 1;
    } catch (err) {
      result.errors.push({
        postId: post.id,
        message: err instanceof Error ? err.message : String(err)
      });
    }
  }

  for (const post of await listDueScheduledPosts(nowIso, db)) {
    try {
      // Claim first (single publisher): the guarded transition is the lock —
      // an overlapping sweep on a stale due-list loses it before any Graph
      // call, and an owner cancel that landed first wins.
      const claimed = await transitionSocialPost(
        post.business_id,
        post.id,
        "scheduled",
        { status: "publishing", started_at: nowIso },
        db
      );
      if (!claimed) continue;
      result.promoted += 1;

      const failure = await publishOne(db, post, graph, nowIso);
      if (failure) {
        result.failed += 1;
        result.errors.push({ postId: post.id, message: failure });
      } else {
        result.published += 1;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("social-post-sweep: post pass failed", { postId: post.id, message });
      result.errors.push({ postId: post.id, message });
    }
  }

  return result;
}

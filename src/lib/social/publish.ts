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
 *   3. Resolve posts stuck in `publishing` past the stale window (a crash
 *      between promotion and outcome). The container id was persisted
 *      BEFORE the publish call, so the sweep asks Meta for the container's
 *      status_code: PUBLISHED → the post is live, stamp `published`;
 *      anything else (or no container/connection) → `failed` with a
 *      duplicate-check warning. Never blind-retried — a duplicate feed
 *      post is worse than the owner re-scheduling by hand.
 *
 * A missing/paused Meta connection (or a Page with no linked IG
 * professional account) fails the post with plain-words guidance instead
 * of throwing — config gaps are the owner's to fix, not transient errors.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getMetaConnection, type MetaConnectionRow } from "@/lib/db/meta-connections";
import {
  createInstagramMediaContainer,
  getInstagramContainerStatus,
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
  containerStatus?: typeof getInstagramContainerStatus;
  loadConnection?: typeof getMetaConnection;
  now?: () => Date;
};

type GraphDeps = Required<
  Pick<
    SocialSweepDeps,
    "createContainer" | "publishMedia" | "containerStatus" | "loadConnection"
  >
>;

type PublishOutcome =
  | { kind: "published" }
  | { kind: "failed"; detail: string }
  /** A concurrent resolver settled the row first — count nothing. */
  | { kind: "lost" };

/**
 * Stamp a promoted post's outcome, guarded on it still being `publishing`:
 * overlapping sweeps (a pass outrunning the cron interval) can both try to
 * settle the same row, and last-write-wins could flip a live post back to
 * failed — the guard makes exactly one resolver win.
 */
async function stampOutcome(
  db: SupabaseClient,
  post: SocialPostRow,
  patch: Parameters<typeof transitionSocialPost>[3]
): Promise<boolean> {
  return transitionSocialPost(post.business_id, post.id, "publishing", patch, db);
}

/**
 * Publish one promoted post. Never throws for Graph/config problems — the
 * outcome is stamped on the row either way. A DB failure writing the
 * outcome DOES propagate: the row stays `publishing` with its container id
 * persisted, and the stale sweep resolves it truthfully next pass via the
 * container's status_code.
 */
async function publishOne(
  db: SupabaseClient,
  post: SocialPostRow,
  deps: GraphDeps,
  nowIso: string
): Promise<PublishOutcome> {
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
      // Persist the container BEFORE publishing: if anything after this
      // point is interrupted (crash, failed outcome write), the stale sweep
      // can ask Meta whether the container went live instead of guessing.
      await patchSocialPost(post.business_id, post.id, { ig_creation_id: creationId }, db);
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
    const won = await stampOutcome(db, post, {
      status: "failed",
      error_detail: failure.slice(0, 500)
    });
    return won ? { kind: "failed", detail: failure } : { kind: "lost" };
  }
  const won = await stampOutcome(db, post, {
    status: "published",
    published_at: nowIso,
    ig_media_id: igMediaId,
    error_detail: null
  });
  return won ? { kind: "published" } : { kind: "lost" };
}

/**
 * Resolve one stuck `publishing` row. When its container id is on file and
 * the connection can be reached, Meta's container status_code answers "did
 * this go live?" — PUBLISHED stamps `published`; anything else (or no
 * container/credentials) stamps `failed` with a duplicate-check warning.
 */
async function resolveStalePost(
  db: SupabaseClient,
  post: SocialPostRow,
  deps: GraphDeps,
  nowIso: string
): Promise<"published" | "failed" | "lost"> {
  if (post.ig_creation_id) {
    try {
      const connection = await deps.loadConnection(post.business_id, db);
      if (connection?.pageToken) {
        const status = await deps.containerStatus(post.ig_creation_id, connection.pageToken);
        if (status === "PUBLISHED") {
          const won = await stampOutcome(db, post, {
            status: "published",
            published_at: nowIso,
            error_detail: null
          });
          return won ? "published" : "lost";
        }
      }
    } catch (err) {
      // Fall through to the failed stamp — an unverifiable container is
      // treated as not-live, with the duplicate-check warning intact.
      logger.warn("social-post-sweep: stale container check failed", {
        postId: post.id,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  const won = await stampOutcome(db, post, {
    status: "failed",
    error_detail:
      "Publishing was interrupted — check Instagram for a duplicate before re-scheduling."
  });
  return won ? "failed" : "lost";
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
  const containerStatus = deps.containerStatus ?? getInstagramContainerStatus;
  const loadConnection = deps.loadConnection ?? getMetaConnection;
  const now = deps.now ?? (() => new Date());
  /* c8 ignore stop */
  const graph: GraphDeps = { createContainer, publishMedia, containerStatus, loadConnection };

  const result: SocialSweepResult = {
    promoted: 0,
    published: 0,
    failed: 0,
    staled: 0,
    errors: []
  };

  const nowIso = now().toISOString();

  // Resolve stuck rows first: a crashed sweep's `publishing` posts are
  // settled (published when Meta confirms the container went live, failed
  // otherwise) before this pass adds new ones, so the stale window is
  // measured against THEIR promotion time, not ours.
  const cutoffIso = new Date(
    now().getTime() - SOCIAL_PUBLISH_STALE_MINUTES * 60 * 1000
  ).toISOString();
  for (const post of await listStalePublishingPosts(cutoffIso, db)) {
    try {
      const outcome = await resolveStalePost(db, post, graph, nowIso);
      if (outcome === "published") result.published += 1;
      else if (outcome === "failed") result.staled += 1;
      // "lost": a concurrent resolver settled the row — nothing to count.
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

      const outcome = await publishOne(db, post, graph, nowIso);
      if (outcome.kind === "failed") {
        result.failed += 1;
        result.errors.push({ postId: post.id, message: outcome.detail });
      } else if (outcome.kind === "published") {
        result.published += 1;
      }
      // "lost": a concurrent resolver settled the row — nothing to count.
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("social-post-sweep: post pass failed", { postId: post.id, message });
      result.errors.push({ postId: post.id, message });
    }
  }

  return result;
}

/**
 * Instagram post publishing, the engine behind the per-minute
 * social-post-sweep (pg_cron → Edge → /api/internal/social-post-sweep →
 * here).
 *
 * One pass:
 *   1. Promote due scheduled posts to `publishing` (guarded transition,
 *      an owner cancel racing the promotion wins cleanly).
 *   2. Publish each through the Instagram Graph API two-step (media
 *      container → media_publish) with the tenant's meta_connections page
 *      token and linked IG professional account; stamp `published` +
 *      `ig_media_id`, or `failed` + a human-readable error.
 *   3. Resolve every in-flight `publishing` row older than a short grace
 *      period (one cron beat, the pass that claimed it has finished its
 *      attempt by then). The container id was persisted BEFORE the publish
 *      call, so the sweep asks Meta for the container's status_code:
 *      PUBLISHED → live, stamp `published`; FINISHED → publish it NOW (a
 *      container publishes at most once, so this can never duplicate) and
 *      stamp `published`; ERROR/EXPIRED → `failed` with an image hint;
 *      still preparing → wait, unless the stale window has passed. Rows
 *      that can't be verified at all (no container id, no connection)
 *      dead-letter at the stale window with a duplicate-check warning.
 *      Never blind-retried, a duplicate feed post is worse than the owner
 *      re-scheduling by hand.
 *
 * A missing/paused Meta connection (or a Page with no linked IG
 * professional account) fails the post with plain-words guidance instead
 * of throwing, config gaps are the owner's to fix, not transient errors.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getBusiness } from "@/lib/db/businesses";
import {
  MARKETING_AUTOMATION_UPGRADE_MESSAGE,
  marketingAutomationAllowedForTier
} from "@/lib/plans/marketing-automation";
import { getMetaConnection, type MetaConnectionRow } from "@/lib/db/meta-connections";
import {
  createInstagramMediaContainer,
  getInstagramContainerStatus,
  getInstagramMediaPermalink,
  getInstagramMediaState,
  publishInstagramMedia
} from "@/lib/meta/client";
import { GENERATED_IMAGES_BUCKET, normalizeImageRef } from "@/lib/image-tools/handlers";
import { logger } from "@/lib/logger";
import { reportMetaCallFailure } from "@/lib/meta/token-health";
import {
  listDueScheduledPosts,
  listPublishedPostsToRecheck,
  listPublishingPosts,
  patchSocialPost,
  transitionSocialPost,
  type SocialPostRow
} from "./db";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** A publish stuck this long is a crashed sweep, not a slow Graph call. */
export const SOCIAL_PUBLISH_STALE_MINUTES = 15;

/**
 * The deleted-post re-check: how far back it looks, how long a post rests
 * between looks, and how many posts one pass asks about.
 *
 * All three exist because this sweep runs EVERY MINUTE. Without the interval
 * it would spend a Graph call per live post per minute (~21,600 a day) to
 * catch an event that happens a handful of times a year. With it, each post
 * is asked about four times a day and a quiet fleet does zero Graph calls on
 * almost every beat.
 */
export const SOCIAL_RECHECK_WINDOW_DAYS = 45;
export const SOCIAL_RECHECK_INTERVAL_HOURS = 6;
export const SOCIAL_RECHECK_BATCH = 15;

/**
 * In-flight rows younger than this are left alone: the pass that claimed
 * them is still (or was just) working, and its per-post attempt is bounded
 * well under one cron beat. After the grace, container status makes any
 * touch safe, a container publishes at most once.
 */
export const SOCIAL_PUBLISH_RESUME_GRACE_MINUTES = 2;

/**
 * Container readiness polling: Meta downloads `image_url` asynchronously,
 * so a fresh container is often IN_PROGRESS, publishing then fails even
 * with a valid image. Poll status_code a few times before media_publish;
 * a container still preparing after the last check stays `publishing` and
 * the stale pass completes it (FINISHED → publish then, see below).
 */
export const CONTAINER_READY_ATTEMPTS = 4;
export const CONTAINER_READY_DELAY_MS = 4000;

/**
 * Signed-URL lifetime for UPLOADED post images. Meta downloads the image
 * while the container prepares, minutes, not hours, but a slow fetch
 * retried across a couple of sweep beats must not outlive the link.
 */
export const UPLOADED_MEDIA_SIGNED_URL_TTL_S = 60 * 60;

/**
 * The URL Meta downloads for a post: uploaded images (stored as a
 * `/api/dashboard/images/<biz>/<file>` ref in the private generated-images
 * bucket) are signed fresh at publish time, so a post scheduled weeks out
 * never carries a rotted link; plain https URLs pass through untouched.
 * Returns null when signing an uploaded ref fails.
 */
async function mediaUrlForMeta(db: SupabaseClient, post: SocialPostRow): Promise<string | null> {
  const ref = normalizeImageRef(post.business_id, post.media_url);
  if (!ref) return post.media_url;
  const { data, error } = await db.storage
    .from(GENERATED_IMAGES_BUCKET)
    .createSignedUrl(ref, UPLOADED_MEDIA_SIGNED_URL_TTL_S);
  if (error || !data?.signedUrl) {
    logger.warn("social-post-sweep: signing uploaded media failed", {
      postId: post.id,
      error: error?.message ?? "no url"
    });
    return null;
  }
  return data.signedUrl;
}

export type SocialSweepResult = {
  promoted: number;
  published: number;
  failed: number;
  /** Stuck `publishing` rows dead-lettered this pass. */
  staled: number;
  /**
   * Rows left `publishing` for a later pass to settle: containers still
   * preparing, ambiguous publish calls, and unverifiable-but-young rows.
   */
  unsettled: number;
  /** Published posts Meta now reports as gone (deleted on Instagram). */
  removed: number;
  errors: Array<{ postId: string; message: string }>;
};

export type SocialSweepDeps = {
  client?: SupabaseClient;
  /** Injectable Graph calls (tests). */
  createContainer?: typeof createInstagramMediaContainer;
  publishMedia?: typeof publishInstagramMedia;
  containerStatus?: typeof getInstagramContainerStatus;
  mediaPermalink?: typeof getInstagramMediaPermalink;
  mediaState?: typeof getInstagramMediaState;
  loadConnection?: typeof getMetaConnection;
  now?: () => Date;
  /** Injectable readiness-poll delay (tests run instantly). */
  sleep?: (ms: number) => Promise<void>;
};

type GraphDeps = Required<
  Pick<
    SocialSweepDeps,
    | "createContainer"
    | "publishMedia"
    | "containerStatus"
    | "mediaPermalink"
    | "loadConnection"
    | "sleep"
  >
>;

type PublishOutcome =
  | { kind: "published" }
  | { kind: "failed"; detail: string }
  /** A concurrent resolver settled the row first, count nothing. */
  | { kind: "lost" }
  /**
   * Row stays `publishing` for a later pass: the container is still
   * preparing, or the publish call's outcome is ambiguous (it threw AFTER
   * Meta may have published, only the container status can say, and
   * stamping failed here would invite a duplicate re-schedule).
   */
  | { kind: "unsettled" };

/**
 * Stamp a promoted post's outcome, guarded on it still being `publishing`:
 * overlapping sweeps (a pass outrunning the cron interval) can both try to
 * settle the same row, and last-write-wins could flip a live post back to
 * failed, the guard makes exactly one resolver win.
 */
async function stampOutcome(
  db: SupabaseClient,
  post: SocialPostRow,
  patch: Parameters<typeof transitionSocialPost>[3]
): Promise<boolean> {
  return transitionSocialPost(post.business_id, post.id, "publishing", patch, db);
}

/**
 * Publish one promoted post. Never throws for Graph/config problems, the
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
  let igPermalink: string | null = null;
  let unsettled = false;
  try {
    const connection: MetaConnectionRow | null = await deps.loadConnection(
      post.business_id,
      db
    );
    if (!connection || connection.status !== "active" || !connection.is_active) {
      failure =
        "Facebook connection is missing or paused, reconnect on the Integrations page, then re-schedule.";
    } else if (!connection.instagram_account_id) {
      failure =
        "The connected Facebook Page has no linked Instagram professional account, link one in Meta Business Suite, reconnect, then re-schedule.";
    } else if (!connection.pageToken) {
      failure =
        "The Facebook connection is missing its page credential, reconnect on the Integrations page, then re-schedule.";
    } else {
      const imageUrl = await mediaUrlForMeta(db, post);
      if (!imageUrl) {
        // Falls through to the shared failure stamping below.
        throw new Error(
          "The uploaded image could not be read from storage, re-upload it and re-schedule."
        );
      }
      const creationId = await deps.createContainer(
        connection.instagram_account_id,
        connection.pageToken,
        imageUrl,
        post.caption
      );
      // Persist the container BEFORE publishing: if anything after this
      // point is interrupted (crash, failed outcome write), the stale sweep
      // can ask Meta whether the container went live instead of guessing.
      await patchSocialPost(post.business_id, post.id, { ig_creation_id: creationId }, db);
      // Meta downloads the image asynchronously, publish only once the
      // container reports FINISHED, polling briefly.
      let status = "";
      for (let attempt = 0; attempt < CONTAINER_READY_ATTEMPTS; attempt++) {
        if (attempt > 0) await deps.sleep(CONTAINER_READY_DELAY_MS);
        status = await deps.containerStatus(creationId, connection.pageToken);
        if (status !== "IN_PROGRESS" && status !== "") break;
      }
      if (status === "ERROR" || status === "EXPIRED") {
        failure = `Instagram could not prepare the media (container ${status}), check that the image URL is a public JPEG/PNG, then re-schedule.`;
      } else if (status === "FINISHED" || status === "PUBLISHED") {
        // PUBLISHED without our publish call would mean another actor beat
        // us to it, either way the post is (about to be) live.
        if (status === "FINISHED") {
          try {
            igMediaId = await deps.publishMedia(
              connection.instagram_account_id,
              connection.pageToken,
              creationId
            );
            // Best-effort (never throws): the live post's public URL, so
            // the dashboard can link straight to it.
            igPermalink = await deps.mediaPermalink(igMediaId, connection.pageToken);
          } catch (err) {
            // AMBIGUOUS: the error may have surfaced after Meta published
            // (timeout, dropped response). Stamping failed here would invite
            // a duplicate re-schedule, leave the row `publishing` and let
            // in-flight resolution read the container's status_code, which
            // knows the truth.
            logger.warn(
              "social-post-sweep: publish call failed after container ready; deferring to container-status resolution",
              {
                postId: post.id,
                error: err instanceof Error ? err.message : String(err)
              }
            );
            unsettled = true;
          }
        }
      } else {
        // Still IN_PROGRESS after the poll budget: leave the row
        // `publishing`, a later pass completes the FINISHED container.
        unsettled = true;
      }
    }
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
    // Without this a 190 here only ever became error_detail text on the post
    // row: the owner read a raw Graph message and nothing flagged the
    // connection or told them their credential had died.
    await reportMetaCallFailure(post.business_id, err, { surface: "instagram_publish" });
  }
  if (unsettled) return { kind: "unsettled" };

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
    ig_permalink: igPermalink,
    error_detail: null
  });
  return won ? { kind: "published" } : { kind: "lost" };
}

/**
 * Resolve one in-flight `publishing` row (already past the resume grace).
 * When its container id is on file and the connection can be reached,
 * Meta's container status_code answers "did this go live?", PUBLISHED
 * stamps `published`; FINISHED (prepared but never published, e.g. a slow
 * image download outlived the original pass) is safely publishable NOW,
 * a container publishes at most once, so a racing resolver can't create a
 * duplicate; ERROR/EXPIRED stamps `failed` with an image hint. A container
 * still preparing keeps waiting until the STALE window, after which it (or
 * any unverifiable row) is dead-lettered.
 */
async function resolveInFlightPost(
  db: SupabaseClient,
  post: SocialPostRow,
  deps: GraphDeps,
  nowIso: string,
  pastStaleWindow: boolean,
  /**
   * False for a tier-blocked tenant: PUBLISHED still settles truthfully
   * (it already happened; recording it prevents a duplicate re-post after
   * an upgrade), but a FINISHED container is failed with the upgrade
   * message instead of published, because publishMedia would put NEW
   * content live for a tenant the gate refuses. The container expires
   * inside Meta's 24h window on its own.
   */
  allowPublish = true
): Promise<"published" | "failed" | "lost" | "waiting"> {
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
        if (status === "FINISHED" && !allowPublish) {
          const won = await stampOutcome(db, post, {
            status: "failed",
            error_detail: MARKETING_AUTOMATION_UPGRADE_MESSAGE.slice(0, 500)
          });
          return won ? "failed" : "lost";
        }
        if (status === "FINISHED" && connection.instagram_account_id) {
          let igMediaId = "";
          try {
            igMediaId = await deps.publishMedia(
              connection.instagram_account_id,
              connection.pageToken,
              post.ig_creation_id
            );
          } catch (err) {
            // AMBIGUOUS, same as the live path: the throw may have surfaced
            // after Meta published. Keep waiting, the next pass re-reads
            // status_code (PUBLISHED → stamp; FINISHED → retry), and a
            // never-publishing container expires within Meta's 24h window,
            // dead-lettering through the ERROR/EXPIRED path.
            logger.warn(
              "social-post-sweep: resolution publish call failed; will re-read container status next pass",
              {
                postId: post.id,
                error: err instanceof Error ? err.message : String(err)
              }
            );
            return "waiting";
          }
          const igPermalink = await deps.mediaPermalink(igMediaId, connection.pageToken);
          const won = await stampOutcome(db, post, {
            status: "published",
            published_at: nowIso,
            ig_media_id: igMediaId,
            ig_permalink: igPermalink,
            error_detail: null
          });
          return won ? "published" : "lost";
        }
        if (status === "ERROR" || status === "EXPIRED") {
          const won = await stampOutcome(db, post, {
            status: "failed",
            error_detail: `Instagram could not prepare the media (container ${status}), check that the image URL is a public JPEG/PNG, then re-schedule.`
          });
          return won ? "failed" : "lost";
        }
        // Still preparing: keep waiting inside the stale window.
        if (!pastStaleWindow) return "waiting";
        const won = await stampOutcome(db, post, {
          status: "failed",
          error_detail:
            "Instagram never finished preparing the media, check that the image URL is a public, reachable JPEG/PNG, then re-schedule."
        });
        return won ? "failed" : "lost";
      }
    } catch (err) {
      // Fall through to the stale rules, an unverifiable container is
      // treated as not-live, with the duplicate-check warning intact.
      logger.warn("social-post-sweep: in-flight container check failed", {
        postId: post.id,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  // Unverifiable (no container id, no connection, or the check threw):
  // give it until the stale window, then dead-letter.
  if (!pastStaleWindow) return "waiting";
  const won = await stampOutcome(db, post, {
    status: "failed",
    error_detail:
      "Publishing was interrupted, check Instagram for a duplicate before re-scheduling."
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
  const mediaPermalink = deps.mediaPermalink ?? getInstagramMediaPermalink;
  const mediaState = deps.mediaState ?? getInstagramMediaState;
  const loadConnection = deps.loadConnection ?? getMetaConnection;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  /* c8 ignore stop */
  const graph = {
    createContainer,
    publishMedia,
    containerStatus,
    mediaPermalink,
    mediaState,
    loadConnection,
    sleep
  } satisfies GraphDeps & { mediaState: typeof getInstagramMediaState };

  const result: SocialSweepResult = {
    promoted: 0,
    published: 0,
    failed: 0,
    staled: 0,
    unsettled: 0,
    removed: 0,
    errors: []
  };

  const nowIso = now().toISOString();

  // Resolve in-flight rows first, BEFORE promoting new posts, so rows this
  // pass claims aren't in the list. Anything younger than the resume grace
  // is skipped (its owning pass may still be working); past the grace the
  // container check settles it as soon as Meta finishes preparing, so a
  // slow image delays a post by ~one cron beat, not the whole stale window.
  const graceCutoffMs = now().getTime() - SOCIAL_PUBLISH_RESUME_GRACE_MINUTES * 60 * 1000;
  const staleCutoffMs = now().getTime() - SOCIAL_PUBLISH_STALE_MINUTES * 60 * 1000;
  for (const post of await listPublishingPosts(db)) {
    try {
      // A null business lookup is a transient blip, leave the row alone.
      const business = await getBusiness(post.business_id, db);
      if (!business) continue;
      // Downgrade-safe WITHOUT blind-failing: a `publishing` row may have
      // already had its publish call land (that is why this resolver
      // exists), and marking it failed invites the owner to re-post after
      // upgrading, a duplicate feed post, the worse outcome per the module
      // header. Resolve with Meta as the authority; allowPublish=false only
      // refuses the half that would put NEW content live.
      const tierAllowed = marketingAutomationAllowedForTier(business.tier);

      const startedMs = post.started_at ? Date.parse(post.started_at) : 0;
      if (startedMs > graceCutoffMs) continue;
      const outcome = await resolveInFlightPost(
        db,
        post,
        graph,
        nowIso,
        startedMs <= staleCutoffMs,
        tierAllowed
      );
      if (outcome === "published") result.published += 1;
      else if (outcome === "failed") result.staled += 1;
      else if (outcome === "waiting") result.unsettled += 1;
      // "lost": a concurrent resolver settled the row, nothing to count.
    } catch (err) {
      result.errors.push({
        postId: post.id,
        message: err instanceof Error ? err.message : String(err)
      });
    }
  }

  for (const post of await listDueScheduledPosts(nowIso, db)) {
    try {
      // A null lookup is a transient blip: leave the row for the next pass.
      const business = await getBusiness(post.business_id, db);
      if (!business) continue;
      if (!marketingAutomationAllowedForTier(business.tier)) {
        // Same head-of-line hole as the campaign sweep: a row left
        // `scheduled` stays permanently due and crowds the page. Fail it
        // with the upgrade message so the owner sees why, and re-posting
        // after an upgrade is a deliberate act on fresh content.
        const failed = await transitionSocialPost(
          post.business_id,
          post.id,
          "scheduled",
          {
            status: "failed",
            error_detail: MARKETING_AUTOMATION_UPGRADE_MESSAGE.slice(0, 500)
          },
          db
        );
        if (failed) result.failed += 1;
        continue;
      }

      // Claim first (single publisher): the guarded transition is the lock,
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
      } else if (outcome.kind === "unsettled") {
        result.unsettled += 1;
      }
      // "lost": a concurrent resolver settled the row, nothing to count.
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("social-post-sweep: post pass failed", { postId: post.id, message });
      result.errors.push({ postId: post.id, message });
    }
  }

  await recheckPublishedPosts(db, graph, result, now());

  return result;
}

/**
 * Notice posts the owner deleted on Instagram.
 *
 * Publishing is fire-and-forget today: the row is stamped `published` and
 * never looked at again, so a post deleted on Instagram still shows in the
 * dashboard as live, linking to a permalink that 404s.
 *
 * Marking is deliberately conservative. `getInstagramMediaState` answers
 * "missing" only for Meta's own unknown-object code; a timeout, a 5xx, a
 * rate limit, or an EXPIRED PAGE TOKEN all answer "unknown" and are left
 * alone. That asymmetry is the whole safety property: the cost of a missed
 * deletion is a stale row until the next pass, while the cost of a false
 * positive is telling a tenant their live posts were deleted.
 */
async function recheckPublishedPosts(
  db: SupabaseClient,
  graph: GraphDeps & { mediaState: typeof getInstagramMediaState },
  result: SocialSweepResult,
  now: Date
): Promise<void> {
  const nowIso = now.toISOString();
  const sinceIso = new Date(
    now.getTime() - SOCIAL_RECHECK_WINDOW_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  const checkedBeforeIso = new Date(
    now.getTime() - SOCIAL_RECHECK_INTERVAL_HOURS * 60 * 60 * 1000
  ).toISOString();
  let posts: SocialPostRow[];
  try {
    posts = await listPublishedPostsToRecheck(
      sinceIso,
      checkedBeforeIso,
      SOCIAL_RECHECK_BATCH,
      db
    );
  } catch (err) {
    // A failed listing must never fail the publish sweep that already ran.
    logger.warn("social-post-sweep: recheck listing failed", {
      message: err instanceof Error ? err.message : String(err)
    });
    return;
  }

  // One connection read per tenant per pass, not per post: a batch is
  // usually one tenant's backlog.
  const connections = new Map<string, MetaConnectionRow | null>();

  for (const post of posts) {
    try {
      if (!connections.has(post.business_id)) {
        connections.set(post.business_id, await graph.loadConnection(post.business_id, db));
      }
      const connection = connections.get(post.business_id) ?? null;
      // No usable connection is not evidence of deletion, it is evidence we
      // cannot ask. Disconnecting Meta must not wipe a tenant's post history.
      const askable = Boolean(connection?.pageToken) && connection?.is_active === true;
      const state = askable
        ? await graph.mediaState(post.ig_media_id!, connection!.pageToken!)
        : "unknown";
      // Stamp every post we looked at, including the ones we could not ask
      // about. Without it a disconnected tenant's stalest rows would refill
      // the batch on every cron beat and starve everyone else's.
      await patchSocialPost(
        post.business_id,
        post.id,
        state === "missing"
          ? {
              removed_at: nowIso,
              // The permalink is dead once the media is gone; keeping it
              // would hand the owner a link straight to a 404.
              ig_permalink: null,
              removed_check_at: nowIso
            }
          : { removed_check_at: nowIso },
        db
      );
      if (state !== "missing") continue;
      result.removed += 1;
      logger.info("social-post-sweep: post removed on instagram", {
        postId: post.id,
        businessId: post.business_id
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("social-post-sweep: recheck failed", { postId: post.id, message });
      result.errors.push({ postId: post.id, message });
    }
  }
}

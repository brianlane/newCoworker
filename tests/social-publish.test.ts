/**
 * Instagram post publishing engine (src/lib/social/publish.ts): guarded
 * promotion, the Graph two-step, connection-gap failures with plain-words
 * guidance, stale-publishing dead-lettering, and per-post error isolation.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => {
    throw new Error("default client must not be used in tests");
  })
}));
vi.mock("@/lib/social/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/social/db")>()),
  listDueScheduledPosts: vi.fn(),
  listPublishingPosts: vi.fn(),
  listPublishedPostsToRecheck: vi.fn(),
  patchSocialPost: vi.fn(),
  transitionSocialPost: vi.fn()
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn(async () => ({
    id: "11111111-1111-4111-8111-111111111111",
    name: "Test Co",
    tier: "standard"
  }))
}));

import {
  CONTAINER_READY_ATTEMPTS,
  CONTAINER_READY_DELAY_MS,
  processSocialPostSweep,
  SOCIAL_PUBLISH_RESUME_GRACE_MINUTES,
  SOCIAL_PUBLISH_STALE_MINUTES,
  SOCIAL_RECHECK_BATCH
} from "@/lib/social/publish";
import {
  listDueScheduledPosts,
  listPublishedPostsToRecheck,
  listPublishingPosts,
  patchSocialPost,
  transitionSocialPost,
  type SocialPostRow
} from "@/lib/social/db";
import type { MetaConnectionRow } from "@/lib/db/meta-connections";
import { getBusiness } from "@/lib/db/businesses";

const BIZ = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-07-18T18:00:00Z");

const listDue = vi.mocked(listDueScheduledPosts);
const listInFlight = vi.mocked(listPublishingPosts);
const listRecheck = vi.mocked(listPublishedPostsToRecheck);
const patch = vi.mocked(patchSocialPost);
const transition = vi.mocked(transitionSocialPost);

/** started_at older than the stale window (dead-letter territory). */
const STARTED_STALE = new Date(
  NOW.getTime() - (SOCIAL_PUBLISH_STALE_MINUTES + 1) * 60 * 1000
).toISOString();
/** started_at past the resume grace but inside the stale window. */
const STARTED_RESUMABLE = new Date(
  NOW.getTime() - (SOCIAL_PUBLISH_RESUME_GRACE_MINUTES + 1) * 60 * 1000
).toISOString();

const createContainer = vi.fn();
const publishMedia = vi.fn();
const containerStatus = vi.fn();
const mediaPermalink = vi.fn();
const mediaState = vi.fn();
const loadConnection = vi.fn();
const sleep = vi.fn(async () => {});

const PERMALINK = "https://www.instagram.com/p/TEST123/";

// The sweep only reads client/now from deps; the db mock is never dialed.
const db = {} as never;

function post(overrides: Partial<SocialPostRow> = {}): SocialPostRow {
  return {
    id: "p-1",
    business_id: BIZ,
    caption: "Spring special!",
    media_url: "https://cdn.test/photo.jpg",
    media_type: "image",
    status: "scheduled",
    publish_at: "2026-07-18T17:00:00Z",
    started_at: null,
    published_at: null,
    ig_creation_id: null,
    ig_media_id: null,
    ig_permalink: null,
    removed_at: null,
    removed_check_at: null,
    error_detail: null,
    created_at: "2026-07-17T00:00:00Z",
    updated_at: "2026-07-17T00:00:00Z",
    ...overrides
  };
}

function connection(overrides: Partial<MetaConnectionRow> = {}): MetaConnectionRow {
  return {
    id: "mc-1",
    business_id: BIZ,
    status: "active",
    page_id: "page-1",
    page_name: "Truly Insurance",
    account_name: "Owner",
    meta_user_id: null,
    token_invalid_at: null,
    instagram_account_id: "ig-1",
    instagram_username: "trulyinsurance",
    dataset_id: null,
    capi_enabled: true,
    is_active: true,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    userToken: null,
    pageToken: "page-tok",
    ...overrides
  };
}

function deps() {
  return {
    client: db,
    createContainer,
    publishMedia,
    containerStatus,
    mediaPermalink,
    mediaState,
    loadConnection,
    sleep,
    now: () => NOW
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getBusiness).mockResolvedValue({
    id: BIZ,
    name: "Test Co",
    tier: "standard"
  } as never);
  listDue.mockResolvedValue([]);
  listInFlight.mockResolvedValue([]);
  patch.mockResolvedValue(undefined);
  transition.mockResolvedValue(true);
  loadConnection.mockResolvedValue(connection());
  createContainer.mockResolvedValue("container-1");
  containerStatus.mockResolvedValue("FINISHED");
  publishMedia.mockResolvedValue("media-9");
  mediaPermalink.mockResolvedValue(PERMALINK);
  listRecheck.mockResolvedValue([]);
  mediaState.mockResolvedValue("exists");
});

describe("processSocialPostSweep — publish", () => {
  it("fails a blocked scheduled row instead of promoting it", async () => {
    // Was "skips promotion", which left the row permanently due and let it
    // crowd the LIMIT page ahead of every other tenant (see the Starter
    // describe block below for the settle-truthfully half).
    vi.mocked(getBusiness).mockResolvedValueOnce({
      id: BIZ,
      name: "Starter Co",
      tier: "starter"
    } as never);
    listDue.mockResolvedValue([post()]);
    const result = await processSocialPostSweep(deps());
    expect(result.promoted).toBe(0);
    expect(createContainer).not.toHaveBeenCalled();
    expect(transition).toHaveBeenCalledWith(
      BIZ,
      "p-1",
      "scheduled",
      expect.objectContaining({ status: "failed" }),
      db
    );
  });

  it("leaves an in-grace Starter row for its owning pass", async () => {
    // Was "fail immediately, even inside the resume grace". Blind-failing a
    // row whose publish call may have already landed invites a duplicate
    // re-post after upgrade; inside the grace the owning pass may still be
    // working, so the row is left alone and settled truthfully once the
    // grace lapses (see the Starter describe block below).
    vi.mocked(getBusiness).mockResolvedValue({
      id: BIZ,
      name: "Starter Co",
      tier: "starter"
    } as never);
    listInFlight.mockResolvedValue([
      post({
        id: "p-old",
        status: "publishing",
        started_at: new Date(NOW.getTime() - 30_000).toISOString(),
        ig_creation_id: "container-7"
      })
    ]);
    const result = await processSocialPostSweep(deps());
    expect(result.failed).toBe(0);
    expect(containerStatus).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalledWith(
      BIZ,
      "p-old",
      "publishing",
      expect.anything(),
      db
    );
  });

  it("does not count a lost Starter in-flight fail race", async () => {
    vi.mocked(getBusiness).mockResolvedValue({
      id: BIZ,
      name: "Starter Co",
      tier: "starter"
    } as never);
    listInFlight.mockResolvedValue([
      post({ id: "p-old", status: "publishing", started_at: STARTED_STALE })
    ]);
    transition.mockResolvedValue(false);
    const result = await processSocialPostSweep(deps());
    expect(result.failed).toBe(0);
  });

  it("leaves in-flight rows alone when business lookup returns null", async () => {
    vi.mocked(getBusiness).mockResolvedValue(null);
    listInFlight.mockResolvedValue([
      post({
        id: "p-old",
        status: "publishing",
        started_at: STARTED_STALE,
        ig_creation_id: "container-7"
      })
    ]);
    const result = await processSocialPostSweep(deps());
    expect(result.failed).toBe(0);
    expect(result.published).toBe(0);
    expect(transition).not.toHaveBeenCalled();
    expect(containerStatus).not.toHaveBeenCalled();
  });

  it("claims FIRST (single publisher), runs the Graph two-step, stamps published", async () => {
    listDue.mockResolvedValue([post()]);
    const result = await processSocialPostSweep(deps());
    expect(result).toMatchObject({ promoted: 1, published: 1, failed: 0, staled: 0 });
    // Claim precedes any Graph call — the guarded transition is the lock.
    expect(transition).toHaveBeenCalledWith(
      BIZ,
      "p-1",
      "scheduled",
      { status: "publishing", started_at: NOW.toISOString() },
      db
    );
    expect(transition.mock.invocationCallOrder[0]).toBeLessThan(
      createContainer.mock.invocationCallOrder[0]
    );
    expect(createContainer).toHaveBeenCalledWith(
      "ig-1",
      "page-tok",
      "https://cdn.test/photo.jpg",
      "Spring special!"
    );
    // The container id lands on the row BEFORE media_publish, so an
    // interrupted publish is always resolvable by the stale sweep.
    expect(patch).toHaveBeenCalledWith(BIZ, "p-1", { ig_creation_id: "container-1" }, db);
    expect(patch.mock.invocationCallOrder[0]).toBeLessThan(
      publishMedia.mock.invocationCallOrder[0]
    );
    // Readiness confirmed (FINISHED) before publishing; no wait needed.
    expect(containerStatus).toHaveBeenCalledWith("container-1", "page-tok");
    expect(sleep).not.toHaveBeenCalled();
    expect(publishMedia).toHaveBeenCalledWith("ig-1", "page-tok", "container-1");
    // The live post's permalink is fetched with the media id and stamped
    // alongside it, so the dashboard can link straight to the post.
    expect(mediaPermalink).toHaveBeenCalledWith("media-9", "page-tok");
    // The outcome stamp is a GUARDED transition from `publishing`, so a
    // concurrent resolver can never flip a settled row (Bugbot db659cb1).
    expect(transition).toHaveBeenCalledWith(
      BIZ,
      "p-1",
      "publishing",
      {
        status: "published",
        published_at: NOW.toISOString(),
        ig_media_id: "media-9",
        ig_permalink: PERMALINK,
        error_detail: null
      },
      db
    );
  });

  it("publishes with a null permalink when the permalink lookup returns nothing", async () => {
    listDue.mockResolvedValue([post()]);
    mediaPermalink.mockResolvedValue(null);
    const result = await processSocialPostSweep(deps());
    expect(result).toMatchObject({ published: 1, failed: 0 });
    expect(transition).toHaveBeenCalledWith(
      BIZ,
      "p-1",
      "publishing",
      expect.objectContaining({ status: "published", ig_permalink: null }),
      db
    );
  });

  it("signs an UPLOADED image ref at publish time and hands Meta the signed URL", async () => {
    const uploadedRef = `${BIZ}/22222222-2222-4222-8222-222222222222.jpg`;
    const createSignedUrl = vi.fn(async () => ({
      data: { signedUrl: "https://storage.test/signed.jpg" },
      error: null
    }));
    const storageDb = {
      storage: { from: vi.fn(() => ({ createSignedUrl })) }
    } as never;
    listDue.mockResolvedValue([post({ media_url: `/api/dashboard/images/${uploadedRef}` })]);
    const result = await processSocialPostSweep({ ...deps(), client: storageDb });
    expect(result).toMatchObject({ promoted: 1, published: 1, failed: 0 });
    expect(createSignedUrl).toHaveBeenCalledWith(uploadedRef, expect.any(Number));
    expect(createContainer).toHaveBeenCalledWith(
      "ig-1",
      "page-tok",
      "https://storage.test/signed.jpg",
      "Spring special!"
    );
  });

  it("fails (not throws) a post whose uploaded image cannot be signed", async () => {
    const uploadedRef = `${BIZ}/22222222-2222-4222-8222-222222222222.jpg`;
    // A storage error, and the no-error-no-URL shape, both dead-end the same way.
    for (const signResult of [
      { data: null, error: { message: "gone" } },
      { data: null, error: null }
    ]) {
      vi.clearAllMocks();
      listInFlight.mockResolvedValue([]);
      transition.mockResolvedValue(true);
      patch.mockResolvedValue(undefined);
      loadConnection.mockResolvedValue(connection());
      const createSignedUrl = vi.fn(async () => signResult);
      const storageDb = {
        storage: { from: vi.fn(() => ({ createSignedUrl })) }
      } as never;
      listDue.mockResolvedValue([post({ media_url: `/api/dashboard/images/${uploadedRef}` })]);
      const result = await processSocialPostSweep({ ...deps(), client: storageDb });
      expect(result).toMatchObject({ promoted: 1, published: 0, failed: 1 });
      expect(createContainer).not.toHaveBeenCalled();
      expect(transition).toHaveBeenCalledWith(
        BIZ,
        "p-1",
        "publishing",
        expect.objectContaining({
          status: "failed",
          error_detail: expect.stringContaining("could not be read from storage")
        }),
        storageDb
      );
    }
  });

  it("counts nothing when a concurrent resolver settled the row first (lost outcome stamp)", async () => {
    listDue.mockResolvedValue([post()]);
    // Claim wins; the outcome transition loses (row no longer `publishing`).
    transition.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const result = await processSocialPostSweep(deps());
    expect(result).toMatchObject({ promoted: 1, published: 0, failed: 0 });
    expect(result.errors).toEqual([]);
  });

  it("a lost FAILED stamp also counts nothing (concurrent resolver won)", async () => {
    listDue.mockResolvedValue([post()]);
    loadConnection.mockResolvedValue(null); // config-gap failure path
    transition.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const result = await processSocialPostSweep(deps());
    expect(result).toMatchObject({ promoted: 1, published: 0, failed: 0 });
    expect(result.errors).toEqual([]);
  });

  it("waits for a preparing container, publishing once it reports FINISHED", async () => {
    listDue.mockResolvedValue([post()]);
    containerStatus
      .mockResolvedValueOnce("IN_PROGRESS")
      .mockResolvedValueOnce("FINISHED");
    const result = await processSocialPostSweep(deps());
    expect(result).toMatchObject({ published: 1, unsettled: 0 });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(CONTAINER_READY_DELAY_MS);
    expect(publishMedia).toHaveBeenCalled();
  });

  it("leaves a still-preparing container as `publishing` for a later pass", async () => {
    listDue.mockResolvedValue([post()]);
    containerStatus.mockResolvedValue("IN_PROGRESS");
    const result = await processSocialPostSweep(deps());
    expect(result).toMatchObject({ promoted: 1, published: 0, failed: 0, unsettled: 1 });
    expect(containerStatus).toHaveBeenCalledTimes(CONTAINER_READY_ATTEMPTS);
    expect(sleep).toHaveBeenCalledTimes(CONTAINER_READY_ATTEMPTS - 1);
    expect(publishMedia).not.toHaveBeenCalled();
    // No outcome stamp: only the scheduled→publishing claim ran.
    expect(transition).toHaveBeenCalledTimes(1);
  });

  it("fails a container Meta could not prepare (ERROR / EXPIRED)", async () => {
    for (const status of ["ERROR", "EXPIRED"]) {
      vi.clearAllMocks();
      listDue.mockResolvedValue([post()]);
      listInFlight.mockResolvedValue([]);
      transition.mockResolvedValue(true);
      patch.mockResolvedValue(undefined);
      loadConnection.mockResolvedValue(connection());
      createContainer.mockResolvedValue("container-1");
      containerStatus.mockResolvedValue(status);
      const result = await processSocialPostSweep(deps());
      expect(result).toMatchObject({ failed: 1 });
      expect(result.errors[0].message).toContain(status);
      expect(publishMedia).not.toHaveBeenCalled();
    }
  });

  it("treats a container that reports PUBLISHED pre-publish as already live", async () => {
    listDue.mockResolvedValue([post()]);
    containerStatus.mockResolvedValue("PUBLISHED");
    const result = await processSocialPostSweep(deps());
    expect(result).toMatchObject({ published: 1 });
    expect(publishMedia).not.toHaveBeenCalled();
  });

  it("a lost claim (owner cancel / overlapping sweep) skips the post untouched", async () => {
    listDue.mockResolvedValue([post()]);
    transition.mockResolvedValue(false);
    const result = await processSocialPostSweep(deps());
    expect(result).toMatchObject({ promoted: 0, published: 0, failed: 0 });
    expect(createContainer).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });

  it("fails with owner guidance when the connection is missing, paused, IG-less, or token-less", async () => {
    const cases: Array<[MetaConnectionRow | null, RegExp]> = [
      [null, /connection is missing or paused/],
      [connection({ is_active: false }), /connection is missing or paused/],
      [connection({ status: "pending" }), /connection is missing or paused/],
      [connection({ instagram_account_id: null }), /no linked Instagram professional account/],
      [connection({ pageToken: null }), /missing its page credential/]
    ];
    for (const [conn, message] of cases) {
      vi.clearAllMocks();
      listDue.mockResolvedValue([post()]);
      listInFlight.mockResolvedValue([]);
      transition.mockResolvedValue(true);
      patch.mockResolvedValue(undefined);
      loadConnection.mockResolvedValue(conn);
      const result = await processSocialPostSweep(deps());
      expect(result).toMatchObject({ promoted: 1, published: 0, failed: 1 });
      expect(result.errors[0].message).toMatch(message);
      expect(transition).toHaveBeenCalledWith(
        BIZ,
        "p-1",
        "publishing",
        expect.objectContaining({ status: "failed", error_detail: expect.stringMatching(message) }),
        db
      );
      expect(createContainer).not.toHaveBeenCalled();
    }
  });

  it("stamps a Graph failure (truncated) and keeps sweeping the rest", async () => {
    listDue.mockResolvedValue([post(), post({ id: "p-2" })]);
    createContainer
      .mockRejectedValueOnce(new Error(`boom ${"x".repeat(600)}`))
      .mockResolvedValueOnce("container-2");
    const result = await processSocialPostSweep(deps());
    expect(result).toMatchObject({ promoted: 2, published: 1, failed: 1 });
    const failedStamp = transition.mock.calls.find(
      (c) => (c[3] as { status?: string }).status === "failed"
    );
    expect((failedStamp?.[3] as { error_detail: string }).error_detail).toHaveLength(500);
  });

  it("a non-Error container-creation throw stamps failed (string branch)", async () => {
    listDue.mockResolvedValue([post()]);
    createContainer.mockRejectedValue("string-throw");
    const result = await processSocialPostSweep(deps());
    expect(result).toMatchObject({ failed: 1 });
    expect(result.errors[0].message).toBe("string-throw");
  });

  it("an ambiguous publish-call failure leaves the row unsettled — never stamps failed", async () => {
    // media_publish threw AFTER the container was ready: Meta may already
    // have published (Bugbot 220ce8d1). The row must stay `publishing` for
    // container-status resolution — a failed stamp would invite a duplicate
    // re-schedule. Both Error and non-Error throws.
    for (const thrown of [new Error("publish timeout"), "publish string throw"]) {
      vi.clearAllMocks();
      listDue.mockResolvedValue([post()]);
      listInFlight.mockResolvedValue([]);
      transition.mockResolvedValue(true);
      patch.mockResolvedValue(undefined);
      loadConnection.mockResolvedValue(connection());
      createContainer.mockResolvedValue("container-1");
      containerStatus.mockResolvedValue("FINISHED");
      publishMedia.mockRejectedValue(thrown);
      const result = await processSocialPostSweep(deps());
      expect(result).toMatchObject({ promoted: 1, published: 0, failed: 0, unsettled: 1 });
      // Only the scheduled→publishing claim ran; no outcome stamp.
      expect(transition).toHaveBeenCalledTimes(1);
    }
  });

  it("isolates a published-stamp crash to its post; the row stays resolvable", async () => {
    listDue.mockResolvedValue([post(), post({ id: "p-2" })]);
    // Post 1: claim wins, the PUBLISHED stamp transition blows up — the
    // row stays `publishing` with its container id, for the stale sweep's
    // container-status check to settle. Post 2 sails through.
    transition
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValue(true);
    const result = await processSocialPostSweep(deps());
    expect(result.published).toBe(1);
    expect(result.errors.some((e) => e.postId === "p-1" && /db down/.test(e.message))).toBe(true);
  });

  it("a failed container-persist write fails the post before any publish call", async () => {
    listDue.mockResolvedValue([post()]);
    patch.mockRejectedValueOnce(new Error("persist down")).mockResolvedValue(undefined);
    const result = await processSocialPostSweep(deps());
    expect(result.failed).toBe(1);
    expect(publishMedia).not.toHaveBeenCalled();
  });

  it("stringifies a non-Error crash from the claim itself", async () => {
    listDue.mockResolvedValue([post()]);
    transition.mockRejectedValueOnce("claim exploded");
    const result = await processSocialPostSweep(deps());
    expect(result.errors[0]).toMatchObject({ postId: "p-1", message: "claim exploded" });
  });
});

describe("processSocialPostSweep — in-flight resolution", () => {
  /** An in-flight `publishing` row; started_at picks the resolution regime. */
  function inFlight(overrides: Partial<SocialPostRow> = {}): SocialPostRow {
    return post({ id: "p-old", status: "publishing", started_at: STARTED_STALE, ...overrides });
  }

  it("leaves rows inside the resume grace untouched (their pass may still be working)", async () => {
    listInFlight.mockResolvedValue([
      inFlight({ started_at: new Date(NOW.getTime() - 30_000).toISOString() }),
      // Defensive: a publishing row with no started_at resolves immediately.
      inFlight({ id: "p-nostart", started_at: null, ig_creation_id: "container-7" })
    ]);
    containerStatus.mockResolvedValue("PUBLISHED");
    const result = await processSocialPostSweep(deps());
    // Only the no-start row was resolved; the fresh row wasn't touched.
    expect(result).toMatchObject({ published: 1, staled: 0 });
    expect(transition).toHaveBeenCalledTimes(1);
  });

  it("marks a container-less stuck row failed with a duplicate-check warning, before promoting", async () => {
    listInFlight.mockResolvedValue([inFlight()]);
    const result = await processSocialPostSweep(deps());
    expect(result).toMatchObject({ staled: 1, promoted: 0, published: 0 });
    expect(listInFlight).toHaveBeenCalledWith(db);
    expect(containerStatus).not.toHaveBeenCalled();
    expect(transition).toHaveBeenCalledWith(
      BIZ,
      "p-old",
      "publishing",
      expect.objectContaining({
        status: "failed",
        error_detail: expect.stringMatching(/duplicate/)
      }),
      db
    );
  });

  it("waits (not fails) on an unverifiable row still inside the stale window", async () => {
    listInFlight.mockResolvedValue([inFlight({ started_at: STARTED_RESUMABLE })]);
    const result = await processSocialPostSweep(deps());
    expect(result).toMatchObject({ staled: 0, unsettled: 1 });
    expect(transition).not.toHaveBeenCalled();
  });

  it("stamps published when Meta confirms the persisted container went live", async () => {
    listInFlight.mockResolvedValue([inFlight({ ig_creation_id: "container-7" })]);
    containerStatus.mockResolvedValue("PUBLISHED");
    const result = await processSocialPostSweep(deps());
    expect(result).toMatchObject({ staled: 0, published: 1 });
    expect(containerStatus).toHaveBeenCalledWith("container-7", "page-tok");
    // Guarded from `publishing`: a concurrent resolver can't be overwritten.
    expect(transition).toHaveBeenCalledWith(
      BIZ,
      "p-old",
      "publishing",
      { status: "published", published_at: NOW.toISOString(), error_detail: null },
      db
    );
  });

  it("keeps waiting when the resolution publish call itself throws (ambiguous — even past stale)", async () => {
    // Same ambiguity rule as the live path: the throw may have surfaced
    // after Meta published, so never dead-letter on it — the next pass
    // re-reads status_code, and a dead container expires to ERROR/EXPIRED.
    for (const thrown of [new Error("publish timeout"), "publish string throw"]) {
      vi.clearAllMocks();
      listDue.mockResolvedValue([]);
      listInFlight.mockResolvedValue([inFlight({ ig_creation_id: "container-7" })]); // past stale
      transition.mockResolvedValue(true);
      loadConnection.mockResolvedValue(connection());
      containerStatus.mockResolvedValue("FINISHED");
      publishMedia.mockRejectedValue(thrown);
      const result = await processSocialPostSweep(deps());
      expect(result).toMatchObject({ staled: 0, published: 0, unsettled: 1 });
      expect(transition).not.toHaveBeenCalled();
    }
  });

  it("completes a FINISHED container one cron beat later — no 15-minute wait, no duplicate risk", async () => {
    listInFlight.mockResolvedValue([
      inFlight({ started_at: STARTED_RESUMABLE, ig_creation_id: "container-7" })
    ]);
    containerStatus.mockResolvedValue("FINISHED");
    const result = await processSocialPostSweep(deps());
    expect(result).toMatchObject({ staled: 0, published: 1 });
    expect(publishMedia).toHaveBeenCalledWith("ig-1", "page-tok", "container-7");
    expect(transition).toHaveBeenCalledWith(
      BIZ,
      "p-old",
      "publishing",
      {
        status: "published",
        published_at: NOW.toISOString(),
        ig_media_id: "media-9",
        ig_permalink: PERMALINK,
        error_detail: null
      },
      db
    );
  });

  it("keeps waiting on a still-preparing container inside the stale window, then fails it past it", async () => {
    // Inside the window: IN_PROGRESS → wait.
    listInFlight.mockResolvedValue([
      inFlight({ started_at: STARTED_RESUMABLE, ig_creation_id: "container-7" })
    ]);
    containerStatus.mockResolvedValue("IN_PROGRESS");
    const waiting = await processSocialPostSweep(deps());
    expect(waiting).toMatchObject({ staled: 0, published: 0, unsettled: 1 });
    expect(transition).not.toHaveBeenCalled();

    // Past the window: same status → dead-letter with a preparing message.
    vi.clearAllMocks();
    listDue.mockResolvedValue([]);
    listInFlight.mockResolvedValue([inFlight({ ig_creation_id: "container-7" })]);
    transition.mockResolvedValue(true);
    loadConnection.mockResolvedValue(connection());
    containerStatus.mockResolvedValue("IN_PROGRESS");
    const failed = await processSocialPostSweep(deps());
    expect(failed).toMatchObject({ staled: 1, unsettled: 0 });
    expect(transition).toHaveBeenCalledWith(
      BIZ,
      "p-old",
      "publishing",
      expect.objectContaining({
        status: "failed",
        error_detail: expect.stringMatching(/never finished preparing/)
      }),
      db
    );
  });

  it("fails a container Meta reports ERROR/EXPIRED as soon as the grace passes", async () => {
    listInFlight.mockResolvedValue([
      inFlight({ started_at: STARTED_RESUMABLE, ig_creation_id: "container-7" })
    ]);
    containerStatus.mockResolvedValue("ERROR");
    const result = await processSocialPostSweep(deps());
    expect(result).toMatchObject({ staled: 1 });
    expect(transition).toHaveBeenCalledWith(
      BIZ,
      "p-old",
      "publishing",
      expect.objectContaining({ error_detail: expect.stringMatching(/ERROR/) }),
      db
    );
  });

  it("cannot complete a FINISHED container without a linked IG account — stale rules apply", async () => {
    listInFlight.mockResolvedValue([inFlight({ ig_creation_id: "container-7" })]);
    containerStatus.mockResolvedValue("FINISHED");
    loadConnection.mockResolvedValue(connection({ instagram_account_id: null }));
    const result = await processSocialPostSweep(deps());
    expect(result).toMatchObject({ staled: 1, published: 0 });
    expect(publishMedia).not.toHaveBeenCalled();
  });

  it("counts nothing when a concurrent sweep settles the stuck row first", async () => {
    listInFlight.mockResolvedValue([inFlight({ ig_creation_id: "container-7" })]);
    containerStatus.mockResolvedValue("PUBLISHED");
    transition.mockResolvedValue(false); // published stamp loses
    const result = await processSocialPostSweep(deps());
    expect(result).toMatchObject({ staled: 0, published: 0 });
    expect(result.errors).toEqual([]);

    // Same for the FINISHED-completion stamp.
    vi.clearAllMocks();
    listDue.mockResolvedValue([]);
    listInFlight.mockResolvedValue([inFlight({ ig_creation_id: "container-7" })]);
    loadConnection.mockResolvedValue(connection());
    containerStatus.mockResolvedValue("FINISHED");
    publishMedia.mockResolvedValue("media-9");
    transition.mockResolvedValue(false);
    const lostFinished = await processSocialPostSweep(deps());
    expect(lostFinished).toMatchObject({ staled: 0, published: 0 });
    expect(lostFinished.errors).toEqual([]);

    // Same for a lost ERROR-container stamp.
    vi.clearAllMocks();
    listDue.mockResolvedValue([]);
    listInFlight.mockResolvedValue([inFlight({ ig_creation_id: "container-7" })]);
    loadConnection.mockResolvedValue(connection());
    containerStatus.mockResolvedValue("ERROR");
    transition.mockResolvedValue(false);
    const lostError = await processSocialPostSweep(deps());
    expect(lostError).toMatchObject({ staled: 0, published: 0 });
    expect(lostError.errors).toEqual([]);

    // Same for a lost preparing-timeout stamp.
    vi.clearAllMocks();
    listDue.mockResolvedValue([]);
    listInFlight.mockResolvedValue([inFlight({ ig_creation_id: "container-7" })]);
    loadConnection.mockResolvedValue(connection());
    containerStatus.mockResolvedValue("IN_PROGRESS");
    transition.mockResolvedValue(false);
    const lostPreparing = await processSocialPostSweep(deps());
    expect(lostPreparing).toMatchObject({ staled: 0, published: 0 });
    expect(lostPreparing.errors).toEqual([]);

    // Same for a lost FAILED stamp on a container-less stuck row.
    vi.clearAllMocks();
    listDue.mockResolvedValue([]);
    listInFlight.mockResolvedValue([inFlight()]);
    transition.mockResolvedValue(false);
    const lostFailed = await processSocialPostSweep(deps());
    expect(lostFailed).toMatchObject({ staled: 0, published: 0 });
    expect(lostFailed.errors).toEqual([]);
  });

  it("fails a stuck row whose container never published, or can't be verified", async () => {
    // No usable connection to verify with.
    listInFlight.mockResolvedValue([inFlight({ ig_creation_id: "container-7" })]);
    loadConnection.mockResolvedValue(null);
    expect((await processSocialPostSweep(deps())).staled).toBe(1);

    // The status check itself throws (Error and non-Error) — warn + failed.
    for (const thrown of [new Error("graph down"), "graph string throw"]) {
      vi.clearAllMocks();
      listDue.mockResolvedValue([]);
      listInFlight.mockResolvedValue([inFlight({ ig_creation_id: "container-7" })]);
      transition.mockResolvedValue(true);
      loadConnection.mockResolvedValue(connection());
      containerStatus.mockRejectedValue(thrown);
      const result = await processSocialPostSweep(deps());
      expect(result.staled).toBe(1);
      expect(transition).toHaveBeenCalledWith(
        BIZ,
        "p-old",
        "publishing",
        expect.objectContaining({ status: "failed" }),
        db
      );
    }
  });

  it("collects a resolution stamp failure and keeps going", async () => {
    listInFlight.mockResolvedValue([inFlight()]);
    transition.mockRejectedValueOnce("stamp failed");
    const result = await processSocialPostSweep(deps());
    expect(result.staled).toBe(0);
    expect(result.errors[0]).toMatchObject({ postId: "p-old", message: "stamp failed" });
  });

  it("keeps an Error-instance resolution failure's message", async () => {
    listInFlight.mockResolvedValue([inFlight()]);
    transition.mockRejectedValueOnce(new Error("stamp error"));
    const result = await processSocialPostSweep(deps());
    expect(result.errors[0]).toMatchObject({ postId: "p-old", message: "stamp error" });
  });
});

/**
 * The tier abort blind-failed `publishing` rows before asking Meta. A row in
 * `publishing` may have already had its publish call land (that is the whole
 * reason resolveInFlightPost exists), so marking it failed invites the owner
 * to re-post after upgrading: a duplicate feed post, which this module's own
 * comments call the worse outcome. Settle truthfully instead, and only
 * refuse the half that would put NEW content live.
 */
describe("processSocialPostSweep — Starter in-flight rows settle truthfully", () => {
  it("stamps published when Meta says the post already went live", async () => {
    vi.mocked(getBusiness).mockResolvedValue({
      id: BIZ,
      name: "Starter Co",
      tier: "starter"
    } as never);
    listInFlight.mockResolvedValue([
      post({ id: "p-live", status: "publishing", started_at: STARTED_STALE, ig_creation_id: "c-1" })
    ]);
    containerStatus.mockResolvedValue("PUBLISHED");
    const result = await processSocialPostSweep(deps());
    expect(result.published).toBe(1);
    expect(publishMedia).not.toHaveBeenCalled();
    expect(transition).toHaveBeenCalledWith(
      BIZ,
      "p-live",
      "publishing",
      expect.objectContaining({ status: "published" }),
      db
    );
  });

  it("fails a merely-prepared container without publishing it", async () => {
    vi.mocked(getBusiness).mockResolvedValue({
      id: BIZ,
      name: "Starter Co",
      tier: "starter"
    } as never);
    listInFlight.mockResolvedValue([
      post({ id: "p-fin", status: "publishing", started_at: STARTED_STALE, ig_creation_id: "c-2" })
    ]);
    containerStatus.mockResolvedValue("FINISHED");
    const result = await processSocialPostSweep(deps());
    // The one thing a gated tenant must never get: a NEW publish.
    expect(publishMedia).not.toHaveBeenCalled();
    expect(result.staled).toBe(1);
    expect(transition).toHaveBeenCalledWith(
      BIZ,
      "p-fin",
      "publishing",
      expect.objectContaining({
        status: "failed",
        error_detail: expect.stringMatching(/Standard/)
      }),
      db
    );
  });

  it("does not count a blocked FINISHED settle it lost to a concurrent resolver", async () => {
    vi.mocked(getBusiness).mockResolvedValue({
      id: BIZ,
      name: "Starter Co",
      tier: "starter"
    } as never);
    listInFlight.mockResolvedValue([
      post({ id: "p-fin2", status: "publishing", started_at: STARTED_STALE, ig_creation_id: "c-3" })
    ]);
    containerStatus.mockResolvedValue("FINISHED");
    transition.mockResolvedValue(false);
    const result = await processSocialPostSweep(deps());
    expect(result.staled).toBe(0);
    expect(publishMedia).not.toHaveBeenCalled();
  });

  it("leaves a blocked scheduled row alone on a null business lookup", async () => {
    vi.mocked(getBusiness).mockResolvedValueOnce(null);
    listDue.mockResolvedValue([post()]);
    const result = await processSocialPostSweep(deps());
    expect(result.promoted).toBe(0);
    expect(transition).not.toHaveBeenCalled();
  });

  it("does not count a blocked scheduled fail it lost to a concurrent cancel", async () => {
    vi.mocked(getBusiness).mockResolvedValueOnce({
      id: BIZ,
      name: "Starter Co",
      tier: "starter"
    } as never);
    listDue.mockResolvedValue([post()]);
    transition.mockResolvedValue(false);
    const result = await processSocialPostSweep(deps());
    expect(result.failed).toBe(0);
  });

  it("fails a blocked scheduled row with the upgrade message instead of leaving it due", async () => {
    vi.mocked(getBusiness).mockResolvedValueOnce({
      id: BIZ,
      name: "Starter Co",
      tier: "starter"
    } as never);
    listDue.mockResolvedValue([post()]);
    const result = await processSocialPostSweep(deps());
    expect(result.promoted).toBe(0);
    expect(createContainer).not.toHaveBeenCalled();
    expect(transition).toHaveBeenCalledWith(
      BIZ,
      "p-1",
      "scheduled",
      expect.objectContaining({
        status: "failed",
        error_detail: expect.stringMatching(/Standard/)
      }),
      db
    );
  });
});

describe("processSocialPostSweep — deleted-post re-check", () => {
  /** A live published row, the shape the re-check pass reads. */
  function live(overrides: Partial<SocialPostRow> = {}): SocialPostRow {
    return post({
      status: "published",
      ig_media_id: "media-9",
      ig_permalink: PERMALINK,
      published_at: "2026-07-18T17:05:00Z",
      ...overrides
    });
  }

  const STAMP = { removed_check_at: NOW.toISOString() };

  it("asks only about rested posts, stalest first, and inside the window", async () => {
    await processSocialPostSweep(deps());
    const [sinceIso, checkedBeforeIso, limit] = listRecheck.mock.calls[0];
    // 45 days back, and rested 6 hours since the last look. NOW is 18:00Z.
    expect(sinceIso).toBe("2026-06-03T18:00:00.000Z");
    expect(checkedBeforeIso).toBe("2026-07-18T12:00:00.000Z");
    expect(limit).toBe(SOCIAL_RECHECK_BATCH);
  });

  it("marks a post the owner deleted on Instagram, and drops its dead permalink", async () => {
    listRecheck.mockResolvedValue([live()]);
    mediaState.mockResolvedValue("missing");

    const result = await processSocialPostSweep(deps());
    expect(result.removed).toBe(1);
    expect(patch).toHaveBeenCalledWith(
      BIZ,
      "p-1",
      { removed_at: NOW.toISOString(), ig_permalink: null, ...STAMP },
      db
    );
  });

  it("leaves a live post alone, but records that it looked", async () => {
    listRecheck.mockResolvedValue([live()]);
    mediaState.mockResolvedValue("exists");

    const result = await processSocialPostSweep(deps());
    expect(result.removed).toBe(0);
    expect(patch).toHaveBeenCalledWith(BIZ, "p-1", STAMP, db);
  });

  it("NEVER marks removed on an inconclusive answer (timeout, 5xx, expired token)", async () => {
    // The safety property: a deleted post and an expired page token both
    // surface as HTTP 400, so anything short of Meta's unknown-object code
    // must leave the row alone. A false positive tells a tenant their live
    // posts were deleted.
    listRecheck.mockResolvedValue([live()]);
    mediaState.mockResolvedValue("unknown");

    const result = await processSocialPostSweep(deps());
    expect(result.removed).toBe(0);
    expect(patch).toHaveBeenCalledWith(BIZ, "p-1", STAMP, db);
  });

  it("does not ask (or mark) when the connection is gone or paused", async () => {
    // Disconnecting Meta is not evidence a post was deleted. The row is
    // still stamped, so it rotates to the back of the queue instead of
    // refilling the batch every single minute.
    listRecheck.mockResolvedValue([live()]);
    loadConnection.mockResolvedValue(null);
    expect((await processSocialPostSweep(deps())).removed).toBe(0);
    expect(mediaState).not.toHaveBeenCalled();
    expect(patch).toHaveBeenCalledWith(BIZ, "p-1", STAMP, db);

    loadConnection.mockResolvedValue(connection({ is_active: false }));
    expect((await processSocialPostSweep(deps())).removed).toBe(0);
    expect(mediaState).not.toHaveBeenCalled();

    loadConnection.mockResolvedValue(connection({ pageToken: "" }));
    expect((await processSocialPostSweep(deps())).removed).toBe(0);
    expect(mediaState).not.toHaveBeenCalled();
  });

  it("reads the tenant's connection once per pass, not once per post", async () => {
    listRecheck.mockResolvedValue([live(), live({ id: "p-2" }), live({ id: "p-3" })]);
    mediaState.mockResolvedValue("exists");

    await processSocialPostSweep(deps());
    expect(loadConnection).toHaveBeenCalledTimes(1);
    expect(mediaState).toHaveBeenCalledTimes(3);
  });

  it("records a per-post error and keeps sweeping the rest", async () => {
    listRecheck.mockResolvedValue([live(), live({ id: "p-2" })]);
    mediaState.mockRejectedValueOnce(new Error("graph blew up"));
    mediaState.mockResolvedValueOnce("missing");

    const result = await processSocialPostSweep(deps());
    expect(result.removed).toBe(1);
    expect(result.errors).toEqual([{ postId: "p-1", message: "graph blew up" }]);
  });

  it("stringifies a non-Error throw rather than losing it", async () => {
    listRecheck.mockResolvedValue([live()]);
    mediaState.mockRejectedValue("just a string");
    const result = await processSocialPostSweep(deps());
    expect(result.errors).toEqual([{ postId: "p-1", message: "just a string" }]);
  });

  it("survives a failed listing without failing the publish sweep that already ran", async () => {
    listRecheck.mockRejectedValue(new Error("db down"));
    const result = await processSocialPostSweep(deps());
    expect(result.removed).toBe(0);
    expect(result.errors).toEqual([]);
    expect(mediaState).not.toHaveBeenCalled();

    listRecheck.mockRejectedValue("db down, no Error");
    expect((await processSocialPostSweep(deps())).errors).toEqual([]);
  });
});

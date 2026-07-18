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
  listStalePublishingPosts: vi.fn(),
  patchSocialPost: vi.fn(),
  transitionSocialPost: vi.fn()
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import {
  CONTAINER_READY_ATTEMPTS,
  CONTAINER_READY_DELAY_MS,
  processSocialPostSweep,
  SOCIAL_PUBLISH_STALE_MINUTES
} from "@/lib/social/publish";
import {
  listDueScheduledPosts,
  listStalePublishingPosts,
  patchSocialPost,
  transitionSocialPost,
  type SocialPostRow
} from "@/lib/social/db";
import type { MetaConnectionRow } from "@/lib/db/meta-connections";

const BIZ = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-07-18T18:00:00Z");

const listDue = vi.mocked(listDueScheduledPosts);
const listStale = vi.mocked(listStalePublishingPosts);
const patch = vi.mocked(patchSocialPost);
const transition = vi.mocked(transitionSocialPost);

const createContainer = vi.fn();
const publishMedia = vi.fn();
const containerStatus = vi.fn();
const loadConnection = vi.fn();
const sleep = vi.fn(async () => {});

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
    instagram_account_id: "ig-1",
    instagram_username: "trulyinsurance",
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
    loadConnection,
    sleep,
    now: () => NOW
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listDue.mockResolvedValue([]);
  listStale.mockResolvedValue([]);
  patch.mockResolvedValue(undefined);
  transition.mockResolvedValue(true);
  loadConnection.mockResolvedValue(connection());
  createContainer.mockResolvedValue("container-1");
  containerStatus.mockResolvedValue("FINISHED");
  publishMedia.mockResolvedValue("media-9");
});

describe("processSocialPostSweep — publish", () => {
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
        error_detail: null
      },
      db
    );
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
    expect(result).toMatchObject({ published: 1, stillPreparing: 0 });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(CONTAINER_READY_DELAY_MS);
    expect(publishMedia).toHaveBeenCalled();
  });

  it("leaves a still-preparing container as `publishing` for a later pass", async () => {
    listDue.mockResolvedValue([post()]);
    containerStatus.mockResolvedValue("IN_PROGRESS");
    const result = await processSocialPostSweep(deps());
    expect(result).toMatchObject({ promoted: 1, published: 0, failed: 0, stillPreparing: 1 });
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
      listStale.mockResolvedValue([]);
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
      listStale.mockResolvedValue([]);
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

  it("a non-Error Graph throw and a publish-step failure both stamp failed", async () => {
    listDue.mockResolvedValue([post()]);
    publishMedia.mockRejectedValue("string-throw");
    const result = await processSocialPostSweep(deps());
    expect(result).toMatchObject({ failed: 1 });
    expect(result.errors[0].message).toBe("string-throw");
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

describe("processSocialPostSweep — stale resolution", () => {
  it("marks a container-less stuck row failed with a duplicate-check warning, before promoting", async () => {
    listStale.mockResolvedValue([post({ id: "p-old", status: "publishing" })]);
    const result = await processSocialPostSweep(deps());
    expect(result).toMatchObject({ staled: 1, promoted: 0, published: 0 });
    expect(listStale).toHaveBeenCalledWith(
      new Date(NOW.getTime() - SOCIAL_PUBLISH_STALE_MINUTES * 60 * 1000).toISOString(),
      db
    );
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

  it("stamps published when Meta confirms the persisted container went live", async () => {
    listStale.mockResolvedValue([
      post({ id: "p-old", status: "publishing", ig_creation_id: "container-7" })
    ]);
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

  it("completes a FINISHED container that never reached media_publish — no duplicate risk", async () => {
    listStale.mockResolvedValue([
      post({ id: "p-old", status: "publishing", ig_creation_id: "container-7" })
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
        error_detail: null
      },
      db
    );
  });

  it("cannot complete a FINISHED container without a linked IG account — fails honestly", async () => {
    listStale.mockResolvedValue([
      post({ id: "p-old", status: "publishing", ig_creation_id: "container-7" })
    ]);
    containerStatus.mockResolvedValue("FINISHED");
    loadConnection.mockResolvedValue(connection({ instagram_account_id: null }));
    const result = await processSocialPostSweep(deps());
    expect(result).toMatchObject({ staled: 1, published: 0 });
    expect(publishMedia).not.toHaveBeenCalled();
  });

  it("counts nothing when a concurrent sweep settles the stuck row first", async () => {
    listStale.mockResolvedValue([
      post({ id: "p-old", status: "publishing", ig_creation_id: "container-7" })
    ]);
    containerStatus.mockResolvedValue("PUBLISHED");
    transition.mockResolvedValue(false); // published stamp loses
    const result = await processSocialPostSweep(deps());
    expect(result).toMatchObject({ staled: 0, published: 0 });
    expect(result.errors).toEqual([]);

    // Same for the FINISHED-completion stamp.
    vi.clearAllMocks();
    listDue.mockResolvedValue([]);
    listStale.mockResolvedValue([
      post({ id: "p-old", status: "publishing", ig_creation_id: "container-7" })
    ]);
    loadConnection.mockResolvedValue(connection());
    containerStatus.mockResolvedValue("FINISHED");
    publishMedia.mockResolvedValue("media-9");
    transition.mockResolvedValue(false);
    const lostFinished = await processSocialPostSweep(deps());
    expect(lostFinished).toMatchObject({ staled: 0, published: 0 });
    expect(lostFinished.errors).toEqual([]);

    // Same for a lost FAILED stamp on a container-less stuck row.
    vi.clearAllMocks();
    listDue.mockResolvedValue([]);
    listStale.mockResolvedValue([post({ id: "p-old", status: "publishing" })]);
    transition.mockResolvedValue(false);
    const lostFailed = await processSocialPostSweep(deps());
    expect(lostFailed).toMatchObject({ staled: 0, published: 0 });
    expect(lostFailed.errors).toEqual([]);
  });

  it("fails a stuck row whose container never published, or can't be verified", async () => {
    // Not-published container status.
    listStale.mockResolvedValue([
      post({ id: "p-old", status: "publishing", ig_creation_id: "container-7" })
    ]);
    containerStatus.mockResolvedValue("ERROR");
    expect((await processSocialPostSweep(deps())).staled).toBe(1);

    // No usable connection to verify with.
    vi.clearAllMocks();
    listDue.mockResolvedValue([]);
    listStale.mockResolvedValue([
      post({ id: "p-old", status: "publishing", ig_creation_id: "container-7" })
    ]);
    patch.mockResolvedValue(undefined);
    loadConnection.mockResolvedValue(null);
    expect((await processSocialPostSweep(deps())).staled).toBe(1);

    // The status check itself throws (Error and non-Error) — warn + failed.
    for (const thrown of [new Error("graph down"), "graph string throw"]) {
      vi.clearAllMocks();
      listDue.mockResolvedValue([]);
      listStale.mockResolvedValue([
        post({ id: "p-old", status: "publishing", ig_creation_id: "container-7" })
      ]);
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
    listStale.mockResolvedValue([post({ id: "p-old", status: "publishing" })]);
    transition.mockRejectedValueOnce("stamp failed");
    const result = await processSocialPostSweep(deps());
    expect(result.staled).toBe(0);
    expect(result.errors[0]).toMatchObject({ postId: "p-old", message: "stamp failed" });
  });

  it("keeps an Error-instance resolution failure's message", async () => {
    listStale.mockResolvedValue([post({ id: "p-old", status: "publishing" })]);
    transition.mockRejectedValueOnce(new Error("stamp error"));
    const result = await processSocialPostSweep(deps());
    expect(result.errors[0]).toMatchObject({ postId: "p-old", message: "stamp error" });
  });
});

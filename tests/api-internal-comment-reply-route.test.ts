/**
 * The internal Instagram comment-reply bridge
 * (/api/internal/comment-reply), which is how the Deno AiFlow
 * worker answers a comment without holding a page token.
 *
 * The load-bearing behavior here is the FAILURE taxonomy. Instagram allows
 * exactly one private reply per comment, inside a 7-day window, so a refusal
 * usually cannot succeed on a retry: this route decides which outcomes the
 * worker retries ("send_failed") and which it reports as a skip
 * ("refused"). Getting that backwards either burns the retry budget for
 * nothing or, worse, posts a duplicate reply on a tenant's post.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cron-auth", () => ({ assertCronAuth: vi.fn() }));
vi.mock("@/lib/db/meta-connections", () => ({ getMetaConnection: vi.fn() }));
vi.mock("@/lib/meta/token-health", () => ({
  reportMetaCallFailure: vi.fn(async () => false),
  clearMetaTokenInvalid: vi.fn(async () => undefined)
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
vi.mock("@/lib/meta/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/meta/client")>("@/lib/meta/client");
  return {
    ...actual,
    replyToInstagramComment: vi.fn(),
    replyToFacebookComment: vi.fn(),
    sendInstagramPrivateReply: vi.fn()
  };
});

import { POST } from "@/app/api/internal/comment-reply/route";
import { assertCronAuth } from "@/lib/cron-auth";
import { getMetaConnection } from "@/lib/db/meta-connections";
import {
  MetaApiError,
  replyToFacebookComment,
  replyToInstagramComment,
  sendInstagramPrivateReply
} from "@/lib/meta/client";

const BIZ = "11111111-1111-4111-8111-111111111111";
const publicReply = vi.mocked(replyToInstagramComment);
const fbReply = vi.mocked(replyToFacebookComment);
const privateReply = vi.mocked(sendInstagramPrivateReply);

function req(body: unknown) {
  return new Request("https://x/api/internal/comment-reply", {
    method: "POST",
    body: JSON.stringify(body)
  });
}

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: "conn-1",
    business_id: BIZ,
    page_id: "page-7",
    is_active: true,
    pageToken: "page-tok",
    ...overrides
  } as never;
}

/** A Meta refusal carrying the given code, as graphRequest would throw it. */
function metaError(metaCode?: number, status = 400): MetaApiError {
  return new MetaApiError("request_failed", "Meta said no", status, metaCode);
}

const body = { businessId: BIZ, commentId: "c-9", text: "Thanks!", mode: "public" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(assertCronAuth).mockReturnValue(true);
  vi.mocked(getMetaConnection).mockResolvedValue(connection());
  publicReply.mockResolvedValue({ commentId: "reply-1" });
  fbReply.mockResolvedValue({ commentId: "fb-reply-1" });
  privateReply.mockResolvedValue({ messageId: "m-1" });
});

describe("POST /api/internal/comment-reply", () => {
  it("refuses a bad bearer before touching anything", async () => {
    vi.mocked(assertCronAuth).mockReturnValue(false);
    const res = await POST(req(body));
    expect(res.status).toBe(403);
    expect(vi.mocked(getMetaConnection)).not.toHaveBeenCalled();
  });

  it("validates the body", async () => {
    expect((await POST(req({ ...body, businessId: "nope" }))).status).not.toBe(200);
    expect((await POST(req({ ...body, text: "" }))).status).not.toBe(200);
    expect((await POST(req({ ...body, mode: "shout" }))).status).not.toBe(200);
    expect(publicReply).not.toHaveBeenCalled();
  });

  it("posts a public reply with the tenant's page token", async () => {
    const res = await POST(req(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { ok: true, mode: "public", id: "reply-1" } });
    expect(publicReply).toHaveBeenCalledWith("c-9", "page-tok", "Thanks!");
    expect(privateReply).not.toHaveBeenCalled();
  });

  it("routes a Facebook public reply to the /comments edge, not /replies", async () => {
    // Same idea, different noun: Instagram replies live on
    // /{comment_id}/replies and Facebook's on /{comment_id}/comments.
    const res = await POST(req({ ...body, platform: "facebook" }));
    expect(await res.json()).toMatchObject({ data: { ok: true, id: "fb-reply-1" } });
    expect(fbReply).toHaveBeenCalledWith("c-9", "page-tok", "Thanks!");
    expect(publicReply).not.toHaveBeenCalled();
  });

  it("defaults to Instagram when an older worker sends no platform", async () => {
    // The worker deploys separately from Next.js, so a request predating the
    // field must not fail or silently post to the wrong network.
    await POST(req(body));
    expect(publicReply).toHaveBeenCalled();
    expect(fbReply).not.toHaveBeenCalled();
  });

  it("uses the SAME private-reply call on both surfaces", async () => {
    // Private replies are the Messenger Send API on the Page node either way.
    await POST(req({ ...body, mode: "private", platform: "facebook" }));
    expect(privateReply).toHaveBeenCalledWith("page-7", "page-tok", "c-9", "Thanks!");
  });

  it("routes a private reply through the PAGE node", async () => {
    const res = await POST(req({ ...body, mode: "private" }));
    expect(await res.json()).toMatchObject({ data: { ok: true, mode: "private", id: "m-1" } });
    expect(privateReply).toHaveBeenCalledWith("page-7", "page-tok", "c-9", "Thanks!");
    expect(publicReply).not.toHaveBeenCalled();
  });

  it("skips when Instagram is not connected, or the connection is paused", async () => {
    vi.mocked(getMetaConnection).mockResolvedValue(null);
    expect(await (await POST(req(body))).json()).toMatchObject({
      data: { ok: false, reason: "not_connected" }
    });

    vi.mocked(getMetaConnection).mockResolvedValue(connection({ pageToken: null }));
    expect(await (await POST(req(body))).json()).toMatchObject({
      data: { ok: false, reason: "not_connected" }
    });

    vi.mocked(getMetaConnection).mockResolvedValue(connection({ is_active: false }));
    expect(await (await POST(req(body))).json()).toMatchObject({
      data: { ok: false, reason: "connection_inactive" }
    });
    expect(publicReply).not.toHaveBeenCalled();
  });

  it("needs a page id for a private reply, but not for a public one", async () => {
    vi.mocked(getMetaConnection).mockResolvedValue(connection({ page_id: null }));
    expect(await (await POST(req({ ...body, mode: "private" }))).json()).toMatchObject({
      data: { ok: false, reason: "no_page_id" }
    });
    expect(privateReply).not.toHaveBeenCalled();

    // The public reply is addressed by comment id, so it works regardless.
    expect(await (await POST(req(body))).json()).toMatchObject({ data: { ok: true } });
  });

  it("calls a MISSING APP PERMISSION its own thing, not a dead token", async () => {
    // The failure mode this prevents: reporting it as a dead token would send
    // an owner to redo an OAuth flow that was never the problem, and
    // reporting it as "refused" would show them a raw Graph error for
    // something they cannot fix. The gap is in OUR App Review approvals.
    for (const code of [10, 200, 299]) {
      fbReply.mockRejectedValueOnce(metaError(code));
      const payload = (await (await POST(req({ ...body, platform: "facebook" }))).json()) as {
        data: { reason: string; detail?: string };
      };
      expect(payload.data.reason).toBe("permission_not_granted");
      expect(payload.data.detail).toBe("Meta said no");
    }
    // And it must NOT be escalated as a broken connection.
    const { reportMetaCallFailure } = await import("@/lib/meta/token-health");
    expect(vi.mocked(reportMetaCallFailure)).not.toHaveBeenCalled();
  });

  it("detects it from Meta's answer, so approval makes it work with no deploy", async () => {
    // Deliberately not a hardcoded scope list: the day App Review grants
    // pages_manage_engagement, the same call simply succeeds.
    fbReply.mockResolvedValue({ commentId: "fb-reply-1" });
    const res = await POST(req({ ...body, platform: "facebook" }));
    expect(await res.json()).toMatchObject({ data: { ok: true } });
  });

  it("calls a permanent refusal `refused`, so the worker skips instead of retrying", async () => {
    // Already replied, past the 7-day window, comment deleted, permission
    // missing: all HTTP 400s that can never succeed on a retry.
    // 10/200/299 are handled above as permission_not_granted.
    for (const code of [100, 190, undefined]) {
      publicReply.mockRejectedValueOnce(metaError(code));
      const payload = (await (await POST(req(body))).json()) as {
        data: { reason: string; detail?: string };
      };
      expect(payload.data.reason).toBe("refused");
      // Meta's own words reach the owner's actions_taken line.
      expect(payload.data.detail).toBe("Meta said no");
    }
  });

  it("calls a throttle or a platform blip `send_failed`, so the worker retries", async () => {
    for (const code of [1, 2, 4, 17, 32, 341, 613]) {
      publicReply.mockRejectedValueOnce(metaError(code));
      const payload = (await (await POST(req(body))).json()) as { data: { reason: string } };
      expect(payload.data.reason).toBe("send_failed");
    }
  });

  it("treats a 5xx and a network error as retryable", async () => {
    publicReply.mockRejectedValueOnce(metaError(undefined, 503));
    expect(await (await POST(req(body))).json()).toMatchObject({
      data: { reason: "send_failed" }
    });

    publicReply.mockRejectedValueOnce(
      new MetaApiError("upstream_timeout", "Meta said no", undefined)
    );
    expect(await (await POST(req(body))).json()).toMatchObject({
      data: { reason: "send_failed" }
    });

    publicReply.mockRejectedValueOnce(
      new MetaApiError("upstream_unreachable", "Meta said no", undefined)
    );
    expect(await (await POST(req(body))).json()).toMatchObject({
      data: { reason: "send_failed" }
    });
  });

  it("never answers 5xx for a Meta refusal", async () => {
    // An HTTP error here would make the worker retry every refusal, which is
    // exactly the duplicate-reply case the taxonomy exists to prevent.
    publicReply.mockRejectedValueOnce(metaError(100));
    expect((await POST(req(body))).status).toBe(200);
  });
});

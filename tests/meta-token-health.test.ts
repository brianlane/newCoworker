/**
 * The "this tenant's Meta credential is dead" signal
 * (src/lib/meta/token-health.ts and isMetaTokenDead).
 *
 * Two properties carry this feature, and both are pinned here:
 *
 *   - it fires ONLY on Meta's own token code. Acting on it flags a paying
 *     customer's integration as broken and asks them to redo their OAuth, so
 *     a timeout or an ordinary 4xx must never trigger it.
 *   - it tells the owner ONCE. Every Meta call for that tenant is failing at
 *     the same time, and the failure mode of getting this wrong is texting
 *     someone repeatedly that their integration is broken.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
vi.mock("@/lib/db/meta-connections", () => ({ setMetaTokenInvalid: vi.fn() }));
vi.mock("@/lib/db/system-logs", () => ({ recordSystemLog: vi.fn() }));
vi.mock("@/lib/notifications/dispatch", () => ({ dispatchUrgentNotification: vi.fn() }));

import {
  META_TOKEN_ALERT_EVENT,
  clearMetaTokenInvalid,
  reportMetaCallFailure
} from "@/lib/meta/token-health";
import { setMetaTokenInvalid } from "@/lib/db/meta-connections";
import { recordSystemLog } from "@/lib/db/system-logs";
import { dispatchUrgentNotification } from "@/lib/notifications/dispatch";
import { MetaApiError, isMetaTokenDead } from "@/lib/meta/client";

const BIZ = "11111111-1111-4111-8111-111111111111";
const setInvalid = vi.mocked(setMetaTokenInvalid);
const log = vi.mocked(recordSystemLog);
const dispatch = vi.mocked(dispatchUrgentNotification);

/** A 190 the way graphRequest actually throws it. */
const DEAD_TOKEN = new MetaApiError("request_failed", "Session has expired", 400, 190);

beforeEach(() => {
  vi.clearAllMocks();
  setInvalid.mockResolvedValue(true);
  log.mockResolvedValue(undefined);
  dispatch.mockResolvedValue({ results: [] } as never);
});

describe("isMetaTokenDead", () => {
  it("matches Meta's token code and nothing else", () => {
    expect(isMetaTokenDead(DEAD_TOKEN)).toBe(true);
  });

  it("REFUSES to match anything that is not code 190", () => {
    // Every one of these is a real failure we see, and flagging any of them
    // would tell a working customer their integration died.
    for (const err of [
      new MetaApiError("request_failed", "gone", 400, 100), // deleted object
      new MetaApiError("request_failed", "rate limited", 400, 4),
      new MetaApiError("request_failed", "no permission", 400, 10),
      new MetaApiError("request_failed", "server error", 500),
      new MetaApiError("upstream_timeout", "timed out"),
      new MetaApiError("upstream_unreachable", "ECONNREFUSED"),
      new Error("something else"),
      "a string",
      null,
      undefined
    ]) {
      expect(isMetaTokenDead(err)).toBe(false);
    }
  });
});

describe("reportMetaCallFailure", () => {
  it("flags the connection and tells the owner, once", async () => {
    expect(await reportMetaCallFailure(BIZ, DEAD_TOKEN, { surface: "lead_fetch" })).toBe(true);
    expect(setInvalid).toHaveBeenCalledWith(BIZ, true);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BIZ,
        kind: "meta_connection_broken",
        summary: expect.stringContaining("Facebook")
      })
    );
  });

  it("does NOT re-alert once the connection is already flagged", async () => {
    // setMetaTokenInvalid reports false when the row was already stamped.
    // Every other failing call in the same outage is the same news.
    setInvalid.mockResolvedValue(false);
    expect(await reportMetaCallFailure(BIZ, DEAD_TOKEN, { surface: "capi_upload" })).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("does nothing at all for a failure that is not a dead token", async () => {
    for (const err of [
      new MetaApiError("upstream_timeout", "timed out"),
      new MetaApiError("request_failed", "gone", 400, 100),
      new Error("boom")
    ]) {
      expect(await reportMetaCallFailure(BIZ, err, { surface: "x" })).toBe(false);
    }
    expect(setInvalid).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("writes the marker log BEFORE dispatching", async () => {
    // At-most-once beats at-least-once: a crash mid-send must not be able to
    // produce a second "your integration is broken" text.
    const order: string[] = [];
    log.mockImplementation(async () => {
      order.push("log");
    });
    dispatch.mockImplementation(async () => {
      order.push("dispatch");
      return { results: [] } as never;
    });
    await reportMetaCallFailure(BIZ, DEAD_TOKEN, { surface: "lead_fetch" });
    expect(order).toEqual(["log", "dispatch"]);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: META_TOKEN_ALERT_EVENT, level: "warn" })
    );
  });

  it("carries the surface through, so the log says what was failing", async () => {
    await reportMetaCallFailure(BIZ, DEAD_TOKEN, { surface: "instagram_publish" });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { surface: "instagram_publish" } })
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { reason: "meta_token_expired", surface: "instagram_publish" }
      })
    );
  });

  it("NEVER throws: it runs inside catch blocks handling the real failure", async () => {
    setInvalid.mockRejectedValue(new Error("db down"));
    await expect(
      reportMetaCallFailure(BIZ, DEAD_TOKEN, { surface: "x" })
    ).resolves.toBe(false);

    // A non-Error throw must not escape either.
    setInvalid.mockRejectedValue("db down, no Error");
    await expect(
      reportMetaCallFailure(BIZ, DEAD_TOKEN, { surface: "x" })
    ).resolves.toBe(false);

    setInvalid.mockResolvedValue(true);
    dispatch.mockRejectedValue(new Error("dispatch down"));
    await expect(
      reportMetaCallFailure(BIZ, DEAD_TOKEN, { surface: "x" })
    ).resolves.toBe(false);
  });

  it("never puts the alert on a specific contact", async () => {
    // contactE164 would engage the per-contact flood cooldown and the
    // contact-owner redirect. A dead connection is business-level news.
    await reportMetaCallFailure(BIZ, DEAD_TOKEN, { surface: "x" });
    expect(dispatch.mock.calls[0][0]).not.toHaveProperty("contactE164");
  });
});

describe("clearMetaTokenInvalid", () => {
  it("clears the flag and swallows its own failures", async () => {
    await clearMetaTokenInvalid(BIZ);
    expect(setInvalid).toHaveBeenCalledWith(BIZ, false);

    setInvalid.mockRejectedValue(new Error("db down"));
    await expect(clearMetaTokenInvalid(BIZ)).resolves.toBeUndefined();
    setInvalid.mockRejectedValue("db down, no Error");
    await expect(clearMetaTokenInvalid(BIZ)).resolves.toBeUndefined();
  });
});

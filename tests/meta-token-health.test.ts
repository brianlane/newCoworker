/**
 * The "this tenant's Meta credential is dead" signal
 * (src/lib/meta/token-health.ts and isMetaTokenDead).
 *
 * Two properties carry this feature, and both are pinned here:
 *
 *   - it fires ONLY on Meta's own token code. Acting on it flags a paying
 *     customer's integration as broken and asks them to redo their OAuth, so
 *     a timeout or an ordinary 4xx must never trigger it.
 *   - the shared needs_reauth loop emails once on the flip (and once more
 *     after a day). This module no longer sends a one-shot meta_connection_broken
 *     email of its own.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
vi.mock("@/lib/db/meta-connections", () => ({
  setMetaTokenInvalid: vi.fn(),
  getMetaConnection: vi.fn()
}));
vi.mock("@/lib/connections/reauth", () => ({
  markConnectionNeedsReauth: vi.fn()
}));

import {
  clearMetaTokenInvalid,
  reportMetaCallFailure
} from "@/lib/meta/token-health";
import { getMetaConnection, setMetaTokenInvalid } from "@/lib/db/meta-connections";
import { markConnectionNeedsReauth } from "@/lib/connections/reauth";
import { MetaApiError, isMetaTokenDead } from "@/lib/meta/client";

const BIZ = "11111111-1111-4111-8111-111111111111";
const CONN = "aaaaaaaa-1111-4111-8111-111111111111";
const setInvalid = vi.mocked(setMetaTokenInvalid);
const getConn = vi.mocked(getMetaConnection);
const mark = vi.mocked(markConnectionNeedsReauth);

/** A 190 the way graphRequest actually throws it. */
const DEAD_TOKEN = new MetaApiError("request_failed", "Session has expired", 400, 190);

beforeEach(() => {
  vi.clearAllMocks();
  setInvalid.mockResolvedValue(true);
  getConn.mockResolvedValue({ id: CONN, business_id: BIZ } as never);
  mark.mockResolvedValue({ flipped: true, emailed: true });
});

describe("isMetaTokenDead", () => {
  it("matches Meta's token code and nothing else", () => {
    expect(isMetaTokenDead(DEAD_TOKEN)).toBe(true);
  });

  it("REFUSES to match anything that is not code 190", () => {
    for (const err of [
      new MetaApiError("request_failed", "gone", 400, 100),
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
  it("flags the connection through the shared needs_reauth loop", async () => {
    expect(await reportMetaCallFailure(BIZ, DEAD_TOKEN, { surface: "lead_fetch" })).toBe(true);
    expect(setInvalid).toHaveBeenCalledWith(BIZ, true);
    expect(mark).toHaveBeenCalledWith("meta_connections", CONN);
  });

  it("does nothing when there is no Meta row to flag", async () => {
    getConn.mockResolvedValue(null);
    expect(await reportMetaCallFailure(BIZ, DEAD_TOKEN, { surface: "x" })).toBe(false);
    expect(mark).not.toHaveBeenCalled();
  });
    mark.mockResolvedValue({ flipped: false, emailed: false });
    expect(await reportMetaCallFailure(BIZ, DEAD_TOKEN, { surface: "capi_upload" })).toBe(false);
    expect(mark).toHaveBeenCalled();
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
    expect(mark).not.toHaveBeenCalled();
  });

  it("NEVER throws: it runs inside catch blocks handling the real failure", async () => {
    setInvalid.mockRejectedValue(new Error("db down"));
    await expect(
      reportMetaCallFailure(BIZ, DEAD_TOKEN, { surface: "x" })
    ).resolves.toBe(false);

    setInvalid.mockRejectedValue("db down, no Error");
    await expect(
      reportMetaCallFailure(BIZ, DEAD_TOKEN, { surface: "x" })
    ).resolves.toBe(false);

    setInvalid.mockResolvedValue(true);
    mark.mockRejectedValue(new Error("mark down"));
    await expect(
      reportMetaCallFailure(BIZ, DEAD_TOKEN, { surface: "x" })
    ).resolves.toBe(false);
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

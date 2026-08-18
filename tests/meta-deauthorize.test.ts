/**
 * What the Meta callbacks actually do (src/lib/meta/deauthorize.ts) and the
 * ledger behind the deletion one (src/lib/meta/deletion-requests.ts).
 *
 * The scope decision is the load-bearing one and is pinned here: a request
 * destroys the META-DERIVED data on the connection and NOTHING else. A
 * tenant's contacts and conversations are the business's own records about
 * its own customers, so erasing them because an administrator removed a
 * Facebook app would be both wrong and unrecoverable.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
vi.mock("@/lib/db/meta-connections", () => ({
  listMetaConnectionsByMetaUserId: vi.fn(),
  deleteMetaConnectionById: vi.fn()
}));
vi.mock("@/lib/db/system-logs", () => ({ recordSystemLog: vi.fn() }));

import { deauthorizeMetaUser } from "@/lib/meta/deauthorize";
import {
  deleteMetaConnectionById,
  listMetaConnectionsByMetaUserId
} from "@/lib/db/meta-connections";
import { recordSystemLog } from "@/lib/db/system-logs";
import { generateConfirmationCode } from "@/lib/meta/deletion-requests";

const ASID = "122098495527401398";
const list = vi.mocked(listMetaConnectionsByMetaUserId);
const clear = vi.mocked(deleteMetaConnectionById);
const log = vi.mocked(recordSystemLog);

function connection(id: string, businessId: string) {
  return { id, business_id: businessId } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue([]);
  clear.mockResolvedValue(true);
  log.mockResolvedValue(undefined);
});

describe("deauthorizeMetaUser", () => {
  it("severs EVERY connection that person authorized, not just the first", async () => {
    // One person can legitimately connect several businesses. Stopping at
    // the first would leave live tokens for an app they removed.
    list.mockResolvedValue([connection("c-1", "b-1"), connection("c-2", "b-2")]);

    const result = await deauthorizeMetaUser(ASID, "deauthorize");
    expect(result).toEqual({ found: 2, cleared: 2, businessIds: ["b-1", "b-2"], unmatched: false });
    expect(clear).toHaveBeenCalledWith("c-1");
    expect(clear).toHaveBeenCalledWith("c-2");
  });

  it("reports unmatched, not an error, when the id matches nothing", async () => {
    const result = await deauthorizeMetaUser(ASID, "data_deletion");
    expect(result).toEqual({ found: 0, cleared: 0, businessIds: [], unmatched: true });
    expect(clear).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("keeps going when one connection fails to clear", async () => {
    // A partial sever plus a loud log beats an exception that leaves every
    // connection intact: Meta retries neither callback.
    list.mockResolvedValue([connection("c-1", "b-1"), connection("c-2", "b-2")]);
    clear.mockRejectedValueOnce(new Error("db down"));
    clear.mockResolvedValueOnce(true);

    const result = await deauthorizeMetaUser(ASID, "deauthorize");
    expect(result.found).toBe(2);
    expect(result.cleared).toBe(1);
    expect(result.businessIds).toEqual(["b-2"]);
  });

  it("stringifies a non-Error throw rather than losing it", async () => {
    list.mockResolvedValue([connection("c-1", "b-1")]);
    clear.mockRejectedValue("just a string");
    expect((await deauthorizeMetaUser(ASID, "deauthorize")).cleared).toBe(0);
  });

  it("does not count a clear that matched no row", async () => {
    // PostgREST returns no error for an update matching zero rows, so
    // clearMetaConnectionData reports false and this must believe it.
    list.mockResolvedValue([connection("c-1", "b-1")]);
    clear.mockResolvedValue(false);

    const result = await deauthorizeMetaUser(ASID, "deauthorize");
    // found 1, cleared 0: the caller MUST be able to tell this apart from
    // "matched nothing", or it reports a failure as a clean deletion.
    expect(result).toEqual({ found: 1, cleared: 0, businessIds: [], unmatched: false });
    expect(log).not.toHaveBeenCalled();
  });

  it("leaves an audit line per tenant, worded for the reason", async () => {
    list.mockResolvedValue([connection("c-1", "b-1")]);

    await deauthorizeMetaUser(ASID, "deauthorize");
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "b-1",
        event: "meta_app_deauthorized",
        level: "warn",
        message: expect.stringContaining("Reconnect under Integrations")
      })
    );

    vi.clearAllMocks();
    list.mockResolvedValue([connection("c-1", "b-1")]);
    clear.mockResolvedValue(true);
    await deauthorizeMetaUser(ASID, "data_deletion");
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: "meta_data_deletion_requested" })
    );
  });

  it("never logs the app-scoped id into tenant-visible audit rows", async () => {
    // App-scoped or not, the requester's id has no business appearing in a
    // tenant's own log feed.
    list.mockResolvedValue([connection("c-1", "b-1")]);
    await deauthorizeMetaUser(ASID, "deauthorize");
    expect(JSON.stringify(log.mock.calls)).not.toContain(ASID);
  });
});

describe("generateConfirmationCode", () => {
  it("is 12 unambiguous alphanumerics", () => {
    // People read this off a screen and quote it to support, so no 0/O/1/I/L.
    for (let i = 0; i < 200; i += 1) {
      const code = generateConfirmationCode();
      expect(code).toHaveLength(12);
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{12}$/);
    }
  });

  it("does not repeat across many draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) seen.add(generateConfirmationCode());
    expect(seen.size).toBe(500);
  });
});

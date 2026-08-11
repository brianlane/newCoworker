/**
 * organize.ts error paths, exercised END TO END through the real
 * `@/lib/nango/workspace` module against a mocked Nango client.
 *
 * Why this file exists separately from email-organize.test.ts: that file mocks
 * the workspace module, so it can only prove organize.ts branches correctly on
 * a status somebody handed it. It cannot prove a status ever ARRIVES. It used
 * to assert exactly that gap, resolving `{ status: 403 }` from a proxy mock
 * while the real Nango client rejects on any non-2xx, which left every
 * `res.status >= 400` branch in organize.ts unreachable in production and every
 * assertion about them vacuous.
 *
 * So here the only mock below the function under test is the Nango client
 * itself, rejecting the way axios really does. Everything between (the status
 * normalization, the branch, the detail string) is the real code.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockProxy = vi.hoisted(() => vi.fn());
const mockGetConn = vi.hoisted(() => vi.fn());
const mockGetByNangoIds = vi.hoisted(() => vi.fn());

vi.mock("@/lib/nango/server", () => ({
  getNangoClient: () => ({ proxy: mockProxy })
}));
vi.mock("@/lib/db/workspace-oauth-connections", () => ({
  getWorkspaceOAuthConnection: mockGetConn,
  getWorkspaceOAuthConnectionByNangoIds: mockGetByNangoIds
}));
vi.mock("@/lib/db/email-log", () => ({
  organizeTenantEmailLog: vi.fn(),
  softDeleteEmailLogEntry: vi.fn()
}));

import { organizeMessage } from "@/lib/email/organize";

const BIZ = "00000000-0000-4000-8000-000000000001";
const CONN = "00000000-0000-4000-8000-000000000003";

/** Exactly what axios rejects with: no validateStatus override in Nango. */
function axiosError(status: number, data: unknown = {}) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status, data }
  });
}

function conn(providerConfigKey: string, connectionId: string) {
  return { id: CONN, connection_id: connectionId, provider_config_key: providerConfigKey };
}

describe("organizeMessage surfaces provider failures as structured details", () => {
  beforeEach(() => {
    mockProxy.mockReset();
    mockGetConn.mockReset();
    mockGetByNangoIds.mockReset();
    mockGetByNangoIds.mockResolvedValue({ connection_id: "nango-1", provider_config_key: "google-mail" });
  });

  it("reports a scope-denied Gmail modify as gmail_modify_failed:403", async () => {
    mockGetConn.mockResolvedValue(conn("google-mail", "nango-1"));
    mockProxy.mockRejectedValue(
      axiosError(403, { error: { code: 403, message: "Insufficient Permission" } })
    );

    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "msg-1",
        actions: { markRead: true }
      })
    ).resolves.toEqual({ ok: false, detail: "gmail_modify_failed:403" });
  });

  it("reports a failed Gmail trash as gmail_trash_failed:500", async () => {
    mockGetConn.mockResolvedValue(conn("google-mail", "nango-1"));
    mockProxy.mockRejectedValue(axiosError(500));

    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "msg-1",
        actions: { trash: true }
      })
    ).resolves.toEqual({ ok: false, detail: "gmail_trash_failed:500" });
  });

  it("reports a failed Gmail label list as gmail_labels_list_failed:429", async () => {
    mockGetConn.mockResolvedValue(conn("google-mail", "nango-1"));
    mockProxy.mockRejectedValue(axiosError(429));

    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "msg-1",
        actions: { addLabels: ["Sales"] }
      })
    ).resolves.toEqual({ ok: false, detail: "gmail_labels_list_failed:429" });
  });

  it("reports a failed Gmail label create with the label name and status", async () => {
    mockGetConn.mockResolvedValue(conn("google-mail", "nango-1"));
    mockProxy
      .mockResolvedValueOnce({ status: 200, data: { labels: [] } })
      .mockRejectedValueOnce(axiosError(400));

    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "msg-1",
        actions: { addLabels: ["Sales"] }
      })
    ).resolves.toEqual({ ok: false, detail: "gmail_label_create_failed:Sales:400" });
  });

  it("turns an Outlook 403 into the reconnect hint rather than a raw failure", async () => {
    mockGetByNangoIds.mockResolvedValue({ connection_id: "nango-ol", provider_config_key: "outlook" });
    mockGetConn.mockResolvedValue(conn("outlook", "nango-ol"));
    mockProxy.mockRejectedValue(axiosError(403));

    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "AAMk",
        actions: { markRead: true }
      })
    ).resolves.toEqual({ ok: false, detail: "outlook_reconnect_required" });
  });

  it("reports a rate-limited Outlook patch as outlook_patch_failed:429", async () => {
    mockGetByNangoIds.mockResolvedValue({ connection_id: "nango-ol", provider_config_key: "outlook" });
    mockGetConn.mockResolvedValue(conn("outlook", "nango-ol"));
    mockProxy.mockRejectedValue(axiosError(429));

    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "AAMk",
        actions: { markRead: true }
      })
    ).resolves.toEqual({ ok: false, detail: "outlook_patch_failed:429" });
  });

  it("reports a failed Outlook categories read without patching a blank merge base", async () => {
    mockGetByNangoIds.mockResolvedValue({ connection_id: "nango-ol", provider_config_key: "outlook" });
    mockGetConn.mockResolvedValue(conn("outlook", "nango-ol"));
    mockProxy.mockRejectedValue(axiosError(500));

    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "AAMk",
        actions: { addLabels: ["Z"] }
      })
    ).resolves.toEqual({ ok: false, detail: "outlook_categories_get_failed:500" });
    // Fail closed: exactly one call, the GET. No PATCH followed it.
    expect(mockProxy).toHaveBeenCalledTimes(1);
  });

  it("falls through to the folder scan when the well-known folder 404s", async () => {
    mockGetByNangoIds.mockResolvedValue({ connection_id: "nango-ol", provider_config_key: "outlook" });
    mockGetConn.mockResolvedValue(conn("outlook", "nango-ol"));
    // A mailbox with no Archive folder yet answers 404 on the well-known
    // lookup. Before the status normalization that 404 threw straight out of
    // organizeMessage, so the scan below it could never run.
    mockProxy
      .mockRejectedValueOnce(axiosError(404))
      .mockResolvedValueOnce({
        status: 200,
        data: { value: [{ id: "folder-archive", displayName: "Archive" }] }
      })
      .mockResolvedValueOnce({ status: 200, data: {} });

    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "AAMk",
        actions: { archive: true }
      })
    ).resolves.toEqual({ ok: true, provider: "microsoft" });
    expect(mockProxy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        endpoint: "/v1.0/me/messages/AAMk/move",
        data: { destinationId: "folder-archive" }
      })
    );
  });

  it("lets a transport failure with no response keep throwing", async () => {
    mockGetConn.mockResolvedValue(conn("google-mail", "nango-1"));
    mockProxy.mockRejectedValue(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));

    // No status to report, so this stays an exception for the route to catch
    // rather than becoming a detail string that invents a reason.
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "msg-1",
        actions: { markRead: true }
      })
    ).rejects.toThrow("socket hang up");
  });
});

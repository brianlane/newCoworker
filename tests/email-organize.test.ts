/**
 * Unit tests for src/lib/email/organize.ts (100% coverage target).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const nangoProxy = vi.hoisted(() => vi.fn());
const getConn = vi.hoisted(() => vi.fn());
const organizeTenant = vi.hoisted(() => vi.fn());

vi.mock("@/lib/nango/workspace", () => ({
  nangoProxyForBusiness: nangoProxy
}));
vi.mock("@/lib/db/workspace-oauth-connections", () => ({
  getWorkspaceOAuthConnection: getConn
}));
const softDelete = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db/email-log", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/email-log")>();
  return {
    ...actual,
    organizeTenantEmailLog: organizeTenant,
    softDeleteEmailLogEntry: softDelete
  };
});

import { markGmailMessageRead, organizeMessage } from "@/lib/email/organize";

const BIZ = "00000000-0000-4000-8000-000000000001";
const CONN = "00000000-0000-4000-8000-000000000003";
const LOG = "00000000-0000-4000-8000-000000000002";

function gmailConn() {
  return {
    id: CONN,
    connection_id: "nango-1",
    provider_config_key: "google-mail"
  };
}

function outlookConn() {
  return {
    id: CONN,
    connection_id: "nango-ol",
    provider_config_key: "outlook"
  };
}

describe("organizeMessage", () => {
  beforeEach(() => {
    nangoProxy.mockReset();
    getConn.mockReset();
    organizeTenant.mockReset();
    softDelete.mockReset();
  });

  it("rejects when no actions are provided", async () => {
    await expect(
      organizeMessage({ businessId: BIZ, emailLogId: LOG, actions: {} })
    ).resolves.toEqual({ ok: false, detail: "no_organize_actions" });
  });

  it("rejects mark read and unread together", async () => {
    await expect(
      organizeMessage({
        businessId: BIZ,
        emailLogId: LOG,
        actions: { markRead: true, markUnread: true }
      })
    ).resolves.toEqual({ ok: false, detail: "mark_read_and_unread_conflict" });
  });

  it("rejects archive and unarchive together", async () => {
    await expect(
      organizeMessage({
        businessId: BIZ,
        emailLogId: LOG,
        actions: { archive: true, unarchive: true }
      })
    ).resolves.toEqual({ ok: false, detail: "archive_and_unarchive_conflict" });
  });

  it("organizes the AI mailbox via email_log", async () => {
    organizeTenant.mockResolvedValue(true);
    const res = await organizeMessage({
      businessId: BIZ,
      emailLogId: LOG,
      actions: { archive: true, markRead: true, addLabels: ["Sales", " Sales "] }
    });
    expect(res).toEqual({ ok: true, provider: "tenant" });
    expect(organizeTenant).toHaveBeenCalledWith(
      expect.objectContaining({
        emailLogId: LOG,
        archive: true,
        markRead: true,
        addLabels: ["Sales"]
      })
    );

    organizeTenant.mockResolvedValue(true);
    await organizeMessage({
      businessId: BIZ,
      emailLogId: "  ",
      messageId: "  rfc-id  ",
      actions: { unarchive: true }
    });
    expect(organizeTenant).toHaveBeenLastCalledWith(
      expect.objectContaining({
        emailLogId: null,
        providerMessageId: "rfc-id",
        unarchive: true
      })
    );
  });

  it("fails tenant organize when identity is missing", async () => {
    await expect(
      organizeMessage({ businessId: BIZ, actions: { archive: true } })
    ).resolves.toEqual({ ok: false, detail: "email_log_id_or_message_id_required" });
  });

  it("fails tenant organize when the row is missing", async () => {
    organizeTenant.mockResolvedValue(false);
    await expect(
      organizeMessage({
        businessId: BIZ,
        messageId: "rfc-1",
        actions: { markUnread: true }
      })
    ).resolves.toEqual({ ok: false, detail: "email_log_not_found" });
  });

  it("requires a message id for connected mailboxes", async () => {
    getConn.mockResolvedValue(gmailConn());
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        actions: { markRead: true }
      })
    ).resolves.toEqual({ ok: false, detail: "message_id_required" });
  });

  it("fails when the connection is missing or not email", async () => {
    getConn.mockResolvedValue(null);
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "m1",
        actions: { markRead: true }
      })
    ).resolves.toEqual({ ok: false, detail: "connection_not_found" });

    getConn.mockResolvedValue({
      id: CONN,
      connection_id: "x",
      provider_config_key: "google-calendar"
    });
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "m1",
        actions: { markRead: true }
      })
    ).resolves.toEqual({ ok: false, detail: "not_email_connection" });
  });

  it("marks Gmail read and archives via messages.modify", async () => {
    getConn.mockResolvedValue(gmailConn());
    nangoProxy.mockResolvedValue({ status: 200, data: {} });
    const res = await organizeMessage({
      businessId: BIZ,
      connectionId: CONN,
      messageId: "msg-abc",
      actions: { markRead: true, archive: true }
    });
    expect(res).toEqual({ ok: true, provider: "google" });
    expect(nangoProxy).toHaveBeenCalledWith(
      BIZ,
      { connectionId: "nango-1", providerConfigKey: "google-mail" },
      expect.objectContaining({
        endpoint: "/gmail/v1/users/me/messages/msg-abc/modify",
        data: expect.objectContaining({
          removeLabelIds: expect.arrayContaining(["UNREAD", "INBOX"])
        })
      })
    );
  });

  it("creates missing Gmail labels, moves, unarchives, and marks unread", async () => {
    getConn.mockResolvedValue(gmailConn());
    nangoProxy
      .mockResolvedValueOnce({
        status: 200,
        data: { labels: [{ id: "L1", name: "Existing" }] }
      })
      .mockResolvedValueOnce({ status: 200, data: { id: "L2" } }) // create Sales
      .mockResolvedValueOnce({ status: 200, data: {} }); // modify
    const res = await organizeMessage({
      businessId: BIZ,
      connectionId: CONN,
      messageId: "msg-2",
      actions: {
        markUnread: true,
        unarchive: true,
        addLabels: ["Sales"],
        removeLabels: ["Existing"],
        moveToFolder: "Sales"
      }
    });
    expect(res).toEqual({ ok: true, provider: "google" });
    expect(nangoProxy).toHaveBeenCalledWith(
      BIZ,
      expect.anything(),
      expect.objectContaining({
        endpoint: "/gmail/v1/users/me/labels",
        method: "POST",
        data: expect.objectContaining({ name: "Sales" })
      })
    );
  });

  it("fails when Gmail labels cannot be created or resolved", async () => {
    getConn.mockResolvedValue(gmailConn());
    nangoProxy.mockResolvedValueOnce({ status: 403, data: {} });
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "msg-list-fail",
        actions: { addLabels: ["Nope"] }
      })
    ).resolves.toEqual({ ok: false, detail: "gmail_labels_list_failed:403" });

    // addLabels: list empty, create fails
    nangoProxy.mockReset();
    nangoProxy
      .mockResolvedValueOnce({ status: 200, data: { labels: [] } })
      .mockResolvedValueOnce({ status: 500, data: {} });
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "msg-3",
        actions: { addLabels: ["Nope"] }
      })
    ).resolves.toEqual({ ok: false, detail: "gmail_label_create_failed:Nope:500" });

    // create returns 200 without an id
    nangoProxy.mockReset();
    nangoProxy
      .mockResolvedValueOnce({ status: 200, data: { labels: [] } })
      .mockResolvedValueOnce({ status: 200, data: {} });
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "msg-noid",
        actions: { addLabels: ["Nope"] }
      })
    ).resolves.toEqual({ ok: false, detail: "gmail_label_create_failed:Nope" });

    // create call disconnects after a successful list
    nangoProxy.mockReset();
    nangoProxy
      .mockResolvedValueOnce({ status: 200, data: { labels: [] } })
      .mockResolvedValueOnce(null);
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "msg-create-disc",
        actions: { addLabels: ["Nope"] }
      })
    ).resolves.toEqual({ ok: false, detail: "email_not_connected" });

    // removeLabels name that never resolves → noop (label already gone)
    nangoProxy.mockReset();
    nangoProxy.mockResolvedValueOnce({ status: 200, data: {} });
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "msg-4",
        actions: { removeLabels: ["Ghost"] }
      })
    ).resolves.toEqual({ ok: true, provider: "google", detail: "noop" });

    // moveToFolder that never resolves fails (do not silent-archive)
    nangoProxy.mockReset();
    nangoProxy
      .mockResolvedValueOnce({ status: 200, data: { labels: [] } })
      .mockResolvedValueOnce({ status: 500, data: {} });
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "msg-4b",
        actions: { moveToFolder: "Ghost" }
      })
    ).resolves.toEqual({ ok: false, detail: "gmail_label_create_failed:Ghost:500" });

    // add-only modify (no removeLabelIds branch)
    nangoProxy.mockReset();
    nangoProxy
      .mockResolvedValueOnce({
        status: 200,
        data: { labels: [{ id: "L9", name: "Keep" }] }
      })
      .mockResolvedValueOnce({ status: 200, data: {} });
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "msg-5",
        actions: { addLabels: ["Keep"] }
      })
    ).resolves.toEqual({ ok: true, provider: "google" });
  });

  it("fails Gmail when not connected or modify errors", async () => {
    getConn.mockResolvedValue(gmailConn());
    nangoProxy.mockResolvedValueOnce(null);
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "m",
        actions: { markRead: true }
      })
    ).resolves.toEqual({ ok: false, detail: "email_not_connected" });

    nangoProxy.mockResolvedValueOnce({ status: 400, data: {} });
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "m",
        actions: { markRead: true }
      })
    ).resolves.toEqual({ ok: false, detail: "gmail_modify_failed:400" });
  });

  it("returns reconnect hint when Outlook scope is missing", async () => {
    getConn.mockResolvedValue(outlookConn());
    nangoProxy.mockResolvedValueOnce({ status: 403, data: {} });
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "AAMkAGI",
        actions: { markRead: true }
      })
    ).resolves.toEqual({ ok: false, detail: "outlook_reconnect_required" });
  });

  it("patches Outlook categories and moves into Archive", async () => {
    getConn.mockResolvedValue(outlookConn());
    // Preflight folder → GET categories → combined PATCH → move
    nangoProxy
      .mockResolvedValueOnce({ status: 200, data: { id: "folder-archive" } })
      .mockResolvedValueOnce({ status: 200, data: { categories: ["Old", "Drop"] } })
      .mockResolvedValueOnce({ status: 200, data: {} })
      .mockResolvedValueOnce({ status: 200, data: { id: "moved" } });
    const res = await organizeMessage({
      businessId: BIZ,
      connectionId: CONN,
      messageId: "AAMkAGI",
      actions: {
        markRead: true,
        addLabels: ["Sales"],
        removeLabels: ["Drop"],
        archive: true
      }
    });
    expect(res).toEqual({ ok: true, provider: "microsoft" });

    // categories omitted on GET (uses ?? [])
    nangoProxy.mockReset();
    nangoProxy
      .mockResolvedValueOnce({ status: 200, data: {} })
      .mockResolvedValueOnce({ status: 200, data: {} });
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "AAMk",
        actions: { addLabels: ["Only"] }
      })
    ).resolves.toEqual({ ok: true, provider: "microsoft" });
  });

  it("prefers moveToFolder over Archive when both are set on Outlook", async () => {
    getConn.mockResolvedValue(outlookConn());
    nangoProxy
      .mockResolvedValueOnce({
        status: 200,
        data: { value: [{ id: "f-sales", displayName: "Sales" }] }
      })
      .mockResolvedValueOnce({ status: 200, data: { id: "moved" } });
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "AAMkBoth",
        actions: { archive: true, moveToFolder: "Sales" }
      })
    ).resolves.toEqual({ ok: true, provider: "microsoft" });
    expect(nangoProxy).toHaveBeenLastCalledWith(
      BIZ,
      expect.anything(),
      expect.objectContaining({
        endpoint: "/v1.0/me/messages/AAMkBoth/move",
        data: { destinationId: "f-sales" }
      })
    );
  });

  it("resolves Outlook folders from the mailFolders list and unarchives to Inbox", async () => {
    getConn.mockResolvedValue(outlookConn());
    nangoProxy
      .mockResolvedValueOnce({
        status: 200,
        data: {
          value: [{ id: "f1", displayName: "Other" }],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/mailFolders?$skiptoken=1"
        }
      })
      .mockResolvedValueOnce({
        status: 200,
        data: { value: [{ id: "f2", displayName: "Billing" }] }
      })
      .mockResolvedValueOnce({ status: 200, data: { id: "moved" } });
    const res = await organizeMessage({
      businessId: BIZ,
      connectionId: CONN,
      messageId: "AAMk",
      actions: { moveToFolder: "Billing" }
    });
    expect(res).toEqual({ ok: true, provider: "microsoft" });
    expect(nangoProxy).toHaveBeenLastCalledWith(
      BIZ,
      expect.anything(),
      expect.objectContaining({
        endpoint: "/v1.0/me/messages/AAMk/move",
        data: { destinationId: "f2" }
      })
    );
  });

  it("fails Outlook when folder is missing or move/patch fails", async () => {
    getConn.mockResolvedValue(outlookConn());
    nangoProxy.mockResolvedValueOnce({ status: 200, data: { value: [] } });
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "AAMk",
        actions: { moveToFolder: "Missing" }
      })
    ).resolves.toEqual({ ok: false, detail: "outlook_folder_not_found:Missing" });

    nangoProxy.mockReset();
    nangoProxy.mockResolvedValueOnce(null);
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "AAMk",
        actions: { markUnread: true }
      })
    ).resolves.toEqual({ ok: false, detail: "email_not_connected" });

    nangoProxy.mockResolvedValueOnce({ status: 400, data: {} });
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "AAMk",
        actions: { markUnread: true }
      })
    ).resolves.toEqual({ ok: false, detail: "outlook_patch_failed:400" });
  });

  it("soft-fails Outlook category and move on 401/403", async () => {
    getConn.mockResolvedValue(outlookConn());
    nangoProxy
      .mockResolvedValueOnce({ status: 200, data: { categories: [] } })
      .mockResolvedValueOnce({ status: 401, data: {} });
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "AAMk",
        actions: { addLabels: ["X"] }
      })
    ).resolves.toEqual({ ok: false, detail: "outlook_reconnect_required" });

    nangoProxy.mockReset();
    nangoProxy
      .mockResolvedValueOnce({ status: 200, data: { id: "inbox" } })
      .mockResolvedValueOnce({ status: 403, data: {} });
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "AAMk",
        actions: { unarchive: true }
      })
    ).resolves.toEqual({ ok: false, detail: "outlook_reconnect_required" });
  });

  it("exposes markGmailMessageRead helper", async () => {
    nangoProxy.mockResolvedValue({ status: 200, data: {} });
    await markGmailMessageRead(
      BIZ,
      { connectionId: "nango-1", providerConfigKey: "google-mail" },
      "mid"
    );
    expect(nangoProxy).toHaveBeenCalledWith(
      BIZ,
      { connectionId: "nango-1", providerConfigKey: "google-mail" },
      expect.objectContaining({
        endpoint: "/gmail/v1/users/me/messages/mid/modify",
        data: { removeLabelIds: ["UNREAD"] }
      })
    );
  });

  it("covers Outlook category get-401, categories_failed, move_failed, bad nextLink", async () => {
    getConn.mockResolvedValue(outlookConn());
    nangoProxy.mockResolvedValueOnce({ status: 401, data: {} });
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "AAMk",
        actions: { removeLabels: ["X"] }
      })
    ).resolves.toEqual({ ok: false, detail: "outlook_reconnect_required" });

    nangoProxy.mockReset();
    nangoProxy.mockResolvedValueOnce({ status: 500, data: {} });
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "AAMk",
        actions: { addLabels: ["Y"] }
      })
    ).resolves.toEqual({ ok: false, detail: "outlook_categories_get_failed:500" });

    nangoProxy.mockReset();
    nangoProxy
      .mockResolvedValueOnce({ status: 200, data: { categories: [] } })
      .mockResolvedValueOnce({ status: 400, data: {} });
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "AAMk",
        actions: { addLabels: ["Y"] }
      })
    ).resolves.toEqual({ ok: false, detail: "outlook_patch_failed:400" });

    nangoProxy.mockReset();
    nangoProxy
      .mockResolvedValueOnce({ status: 200, data: { id: "arch" } })
      .mockResolvedValueOnce({ status: 500, data: {} });
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "AAMk",
        actions: { archive: true }
      })
    ).resolves.toEqual({ ok: false, detail: "outlook_move_failed:500" });

    nangoProxy.mockReset();
    nangoProxy.mockResolvedValueOnce({
      status: 200,
      data: { value: [], "@odata.nextLink": "not a url" }
    });
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "AAMk",
        actions: { moveToFolder: "Custom" }
      })
    ).resolves.toEqual({ ok: false, detail: "outlook_folder_not_found:Custom" });
  });

  it("covers Gmail label-list disconnect and Outlook folder fallbacks", async () => {
    getConn.mockResolvedValue(gmailConn());
    nangoProxy.mockResolvedValueOnce(null); // labels list
    const disconnected = await organizeMessage({
      businessId: BIZ,
      connectionId: CONN,
      messageId: "m",
      actions: { addLabels: ["A"] }
    });
    expect(disconnected).toEqual({ ok: false, detail: "email_not_connected" });

    getConn.mockResolvedValue(outlookConn());
    // well-known Archive miss → list null
    nangoProxy.mockResolvedValueOnce({ status: 200, data: {} }).mockResolvedValueOnce(null);
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "AAMk",
        actions: { archive: true }
      })
    ).resolves.toEqual({ ok: false, detail: "outlook_folder_not_found:Archive" });

    nangoProxy.mockReset();
    nangoProxy
      .mockResolvedValueOnce({ status: 404, data: {} }) // well-known miss
      .mockResolvedValueOnce({
        status: 200,
        data: {} // value undefined → ?? []
      });
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "AAMk",
        actions: { moveToFolder: "Drafts" }
      })
    ).resolves.toEqual({ ok: false, detail: "outlook_folder_not_found:Drafts" });

    // markRead only: destinationName stays null (archive/move/unarchive unset)
    nangoProxy.mockReset();
    nangoProxy.mockResolvedValueOnce({ status: 200, data: {} });
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "AAMk",
        actions: { markRead: true }
      })
    ).resolves.toEqual({ ok: true, provider: "microsoft" });
  });

  it("fails Outlook category get when disconnected", async () => {
    getConn.mockResolvedValue(outlookConn());
    nangoProxy.mockResolvedValueOnce(null);
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "AAMk",
        actions: { addLabels: ["Z"] }
      })
    ).resolves.toEqual({ ok: false, detail: "email_not_connected" });

    nangoProxy.mockReset();
    nangoProxy
      .mockResolvedValueOnce({ status: 200, data: { categories: [] } })
      .mockResolvedValueOnce(null);
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "AAMk",
        actions: { addLabels: ["Z"] }
      })
    ).resolves.toEqual({ ok: false, detail: "email_not_connected" });

    nangoProxy.mockReset();
    nangoProxy
      .mockResolvedValueOnce({ status: 200, data: { id: "inbox" } })
      .mockResolvedValueOnce(null);
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "AAMk",
        actions: { unarchive: true }
      })
    ).resolves.toEqual({ ok: false, detail: "email_not_connected" });
  });
});

describe("organizeMessage: trash", () => {
  /**
   * Added Aug 7 2026 so the HQ triage flow can BIN the unsubscribable Zapier
   * mail it already recognises. Deliberately reversible: Gmail keeps a
   * trashed message for 30 days and this never calls messages.delete, because
   * the caller is an AI classification and that has to be undoable.
   */
  beforeEach(() => {
    nangoProxy.mockReset();
    getConn.mockReset();
    organizeTenant.mockReset();
    softDelete.mockReset();
  });

  it("counts as an action on its own, so a trash-only step is valid", async () => {
    getConn.mockResolvedValue(gmailConn());
    nangoProxy.mockResolvedValue({ status: 200, data: {} });
    const res = await organizeMessage({
      businessId: BIZ,
      connectionId: CONN,
      messageId: "m-only",
      actions: { trash: true }
    });
    expect(res).toEqual({ ok: true, provider: "google" });
    // No labels to change, so modify is skipped entirely and trash is the
    // single call. The old code would have short-circuited to "noop" here.
    expect(nangoProxy).toHaveBeenCalledTimes(1);
    expect(nangoProxy).toHaveBeenCalledWith(
      BIZ,
      expect.anything(),
      expect.objectContaining({ endpoint: "/gmail/v1/users/me/messages/m-only/trash", method: "POST" })
    );
  });

  it("labels FIRST and bins second, so the message stays findable in the bin", async () => {
    getConn.mockResolvedValue(gmailConn());
    nangoProxy
      .mockResolvedValueOnce({ status: 200, data: { labels: [{ id: "L9", name: "HQ/Automated" }] } })
      .mockResolvedValueOnce({ status: 200, data: {} })
      .mockResolvedValueOnce({ status: 200, data: {} });
    const res = await organizeMessage({
      businessId: BIZ,
      connectionId: CONN,
      messageId: "m-z",
      actions: { markRead: true, addLabels: ["HQ/Automated"], trash: true }
    });
    expect(res).toEqual({ ok: true, provider: "google" });
    const endpoints = nangoProxy.mock.calls.map((c) => (c[2] as { endpoint: string }).endpoint);
    expect(endpoints).toEqual([
      "/gmail/v1/users/me/labels",
      "/gmail/v1/users/me/messages/m-z/modify",
      "/gmail/v1/users/me/messages/m-z/trash"
    ]);
  });

  it("never calls messages.delete, which is the permanent one", async () => {
    getConn.mockResolvedValue(gmailConn());
    nangoProxy.mockResolvedValue({ status: 200, data: {} });
    await organizeMessage({
      businessId: BIZ,
      connectionId: CONN,
      messageId: "m-d",
      actions: { trash: true }
    });
    for (const call of nangoProxy.mock.calls) {
      const { endpoint, method } = call[2] as { endpoint: string; method: string };
      expect(`${method} ${endpoint}`).not.toMatch(/DELETE /);
      expect(endpoint).not.toMatch(/\/delete$/);
    }
  });

  it("surfaces a failed trash instead of reporting success", async () => {
    getConn.mockResolvedValue(gmailConn());
    nangoProxy.mockResolvedValue({ status: 403, data: {} });
    await expect(
      organizeMessage({ businessId: BIZ, connectionId: CONN, messageId: "m-f", actions: { trash: true } })
    ).resolves.toEqual({ ok: false, detail: "gmail_trash_failed:403" });
  });

  it("reports a disconnected mailbox on the trash call", async () => {
    getConn.mockResolvedValue(gmailConn());
    nangoProxy.mockResolvedValue(null);
    await expect(
      organizeMessage({ businessId: BIZ, connectionId: CONN, messageId: "m-n", actions: { trash: true } })
    ).resolves.toEqual({ ok: false, detail: "email_not_connected" });
  });

  it("refuses to bin and restore in the same step", async () => {
    // An authoring mistake, not a sequence: picking a winner would silently do
    // half of what the author asked.
    for (const conflicting of [{ unarchive: true }, { markUnread: true }]) {
      await expect(
        organizeMessage({
          businessId: BIZ,
          connectionId: CONN,
          messageId: "m1",
          actions: { trash: true, ...conflicting }
        })
      ).resolves.toEqual({ ok: false, detail: "trash_and_restore_conflict" });
    }
  });

  it("soft-deletes the AI mailbox row, after applying the other actions", async () => {
    organizeTenant.mockResolvedValue(true);
    softDelete.mockResolvedValue(1);
    const res = await organizeMessage({
      businessId: BIZ,
      emailLogId: LOG,
      actions: { markRead: true, trash: true }
    });
    expect(res).toEqual({ ok: true, provider: "tenant" });
    expect(organizeTenant).toHaveBeenCalledTimes(1);
    expect(softDelete).toHaveBeenCalledWith(BIZ, LOG, "ai_flow");
  });

  it("trashes a tenant row with no other action, skipping the organize write", async () => {
    softDelete.mockResolvedValue(1);
    const res = await organizeMessage({ businessId: BIZ, emailLogId: LOG, actions: { trash: true } });
    expect(res).toEqual({ ok: true, provider: "tenant" });
    // organizeTenantEmailLog needs a field of its own; a trash-only request
    // has none, so calling it would fail on an empty patch.
    expect(organizeTenant).not.toHaveBeenCalled();
  });

  it("needs the row id to trash a tenant message", async () => {
    // The soft delete is keyed by id, and a provider message id cannot resolve
    // one here, so say so rather than silently skipping the delete.
    await expect(
      organizeMessage({ businessId: BIZ, messageId: "<rfc@id>", actions: { trash: true } })
    ).resolves.toEqual({ ok: false, detail: "email_log_id_required_for_trash" });
  });

  it("reports a tenant row that was already gone", async () => {
    softDelete.mockResolvedValue(0);
    await expect(
      organizeMessage({ businessId: BIZ, emailLogId: LOG, actions: { trash: true } })
    ).resolves.toEqual({ ok: false, detail: "email_log_not_found" });
  });
});

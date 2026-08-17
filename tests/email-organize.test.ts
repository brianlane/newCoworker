/**
 * Unit tests for src/lib/email/organize.ts (100% coverage target).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const workspaceProxy = vi.hoisted(() => vi.fn());
const getConn = vi.hoisted(() => vi.fn());
const organizeTenant = vi.hoisted(() => vi.fn());

// Both exports share one mock so a single mockResolvedValueOnce sequence still
// describes the call order across a path that mixes them (the Outlook folder
// resolver uses the status-normalizing helper for the well-known lookup and the
// raw proxy for the paged scan).
//
// Resolving an error status is truthful for the status helper: normalizing a
// non-2xx into a returned { status, data } is precisely what it exists to do.
// It is NOT truthful for the raw proxy, which throws on non-2xx, so raw-path
// failures are modelled as rejections. See email-organize-proxy-errors.test.ts
// for the end-to-end proof through the real helper.
vi.mock("@/lib/workspace/proxy", () => ({
  workspaceProxyForBusiness: workspaceProxy,
  workspaceProxyStatusForBusiness: workspaceProxy
}));
vi.mock("@/lib/db/workspace-oauth-connections", () => ({
  getWorkspaceOAuthConnection: getConn
}));
const softDelete = vi.hoisted(() => vi.fn());
const setImportance = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db/email-log", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/email-log")>();
  return {
    ...actual,
    organizeTenantEmailLog: organizeTenant,
    softDeleteEmailLogEntry: softDelete,
    setEmailLogImportance: setImportance
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
    workspaceProxy.mockReset();
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
    workspaceProxy.mockResolvedValue({ status: 200, data: {} });
    const res = await organizeMessage({
      businessId: BIZ,
      connectionId: CONN,
      messageId: "msg-abc",
      actions: { markRead: true, archive: true }
    });
    expect(res).toEqual({ ok: true, provider: "google" });
    expect(workspaceProxy).toHaveBeenCalledWith(
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
    workspaceProxy
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
    expect(workspaceProxy).toHaveBeenCalledWith(
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
    workspaceProxy.mockResolvedValueOnce({ status: 403, data: {} });
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "msg-list-fail",
        actions: { addLabels: ["Nope"] }
      })
    ).resolves.toEqual({ ok: false, detail: "gmail_labels_list_failed:403" });

    // addLabels: list empty, create fails
    workspaceProxy.mockReset();
    workspaceProxy
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
    workspaceProxy.mockReset();
    workspaceProxy
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
    workspaceProxy.mockReset();
    workspaceProxy
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
    workspaceProxy.mockReset();
    workspaceProxy.mockResolvedValueOnce({ status: 200, data: {} });
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "msg-4",
        actions: { removeLabels: ["Ghost"] }
      })
    ).resolves.toEqual({ ok: true, provider: "google", detail: "noop" });

    // moveToFolder that never resolves fails (do not silent-archive)
    workspaceProxy.mockReset();
    workspaceProxy
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
    workspaceProxy.mockReset();
    workspaceProxy
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
    workspaceProxy.mockResolvedValueOnce(null);
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "m",
        actions: { markRead: true }
      })
    ).resolves.toEqual({ ok: false, detail: "email_not_connected" });

    workspaceProxy.mockResolvedValueOnce({ status: 400, data: {} });
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
    workspaceProxy.mockResolvedValueOnce({ status: 403, data: {} });
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
    workspaceProxy
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
    workspaceProxy.mockReset();
    workspaceProxy
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
    workspaceProxy
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
    expect(workspaceProxy).toHaveBeenLastCalledWith(
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
    workspaceProxy
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
    expect(workspaceProxy).toHaveBeenLastCalledWith(
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
    workspaceProxy.mockResolvedValueOnce({ status: 200, data: { value: [] } });
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "AAMk",
        actions: { moveToFolder: "Missing" }
      })
    ).resolves.toEqual({ ok: false, detail: "outlook_folder_not_found:Missing" });

    workspaceProxy.mockReset();
    workspaceProxy.mockResolvedValueOnce(null);
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "AAMk",
        actions: { markUnread: true }
      })
    ).resolves.toEqual({ ok: false, detail: "email_not_connected" });

    workspaceProxy.mockResolvedValueOnce({ status: 400, data: {} });
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
    workspaceProxy
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

    workspaceProxy.mockReset();
    workspaceProxy
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
    workspaceProxy.mockResolvedValue({ status: 200, data: {} });
    await markGmailMessageRead(
      BIZ,
      { connectionId: "nango-1", providerConfigKey: "google-mail" },
      "mid"
    );
    expect(workspaceProxy).toHaveBeenCalledWith(
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
    workspaceProxy.mockResolvedValueOnce({ status: 401, data: {} });
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "AAMk",
        actions: { removeLabels: ["X"] }
      })
    ).resolves.toEqual({ ok: false, detail: "outlook_reconnect_required" });

    workspaceProxy.mockReset();
    workspaceProxy.mockResolvedValueOnce({ status: 500, data: {} });
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "AAMk",
        actions: { addLabels: ["Y"] }
      })
    ).resolves.toEqual({ ok: false, detail: "outlook_categories_get_failed:500" });

    workspaceProxy.mockReset();
    workspaceProxy
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

    workspaceProxy.mockReset();
    workspaceProxy
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

    workspaceProxy.mockReset();
    workspaceProxy.mockResolvedValueOnce({
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
    workspaceProxy.mockResolvedValueOnce(null); // labels list
    const disconnected = await organizeMessage({
      businessId: BIZ,
      connectionId: CONN,
      messageId: "m",
      actions: { addLabels: ["A"] }
    });
    expect(disconnected).toEqual({ ok: false, detail: "email_not_connected" });

    getConn.mockResolvedValue(outlookConn());
    // well-known Archive miss → list null
    workspaceProxy.mockResolvedValueOnce({ status: 200, data: {} }).mockResolvedValueOnce(null);
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "AAMk",
        actions: { archive: true }
      })
    ).resolves.toEqual({ ok: false, detail: "outlook_folder_not_found:Archive" });

    workspaceProxy.mockReset();
    workspaceProxy
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
    workspaceProxy.mockReset();
    workspaceProxy.mockResolvedValueOnce({ status: 200, data: {} });
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
    workspaceProxy.mockResolvedValueOnce(null);
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "AAMk",
        actions: { addLabels: ["Z"] }
      })
    ).resolves.toEqual({ ok: false, detail: "email_not_connected" });

    workspaceProxy.mockReset();
    workspaceProxy
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

    workspaceProxy.mockReset();
    workspaceProxy
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
    workspaceProxy.mockReset();
    getConn.mockReset();
    organizeTenant.mockReset();
    softDelete.mockReset();
  });

  it("counts as an action on its own, so a trash-only step is valid", async () => {
    getConn.mockResolvedValue(gmailConn());
    workspaceProxy.mockResolvedValue({ status: 200, data: {} });
    const res = await organizeMessage({
      businessId: BIZ,
      connectionId: CONN,
      messageId: "m-only",
      actions: { trash: true }
    });
    expect(res).toEqual({ ok: true, provider: "google" });
    // No labels to change, so modify is skipped entirely and trash is the
    // single call. The old code would have short-circuited to "noop" here.
    expect(workspaceProxy).toHaveBeenCalledTimes(1);
    expect(workspaceProxy).toHaveBeenCalledWith(
      BIZ,
      expect.anything(),
      expect.objectContaining({ endpoint: "/gmail/v1/users/me/messages/m-only/trash", method: "POST" })
    );
  });

  it("labels FIRST and bins second, so the message stays findable in the bin", async () => {
    getConn.mockResolvedValue(gmailConn());
    workspaceProxy
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
    const endpoints = workspaceProxy.mock.calls.map((c) => (c[2] as { endpoint: string }).endpoint);
    expect(endpoints).toEqual([
      "/gmail/v1/users/me/labels",
      "/gmail/v1/users/me/messages/m-z/modify",
      "/gmail/v1/users/me/messages/m-z/trash"
    ]);
  });

  it("never calls messages.delete, which is the permanent one", async () => {
    getConn.mockResolvedValue(gmailConn());
    workspaceProxy.mockResolvedValue({ status: 200, data: {} });
    await organizeMessage({
      businessId: BIZ,
      connectionId: CONN,
      messageId: "m-d",
      actions: { trash: true }
    });
    for (const call of workspaceProxy.mock.calls) {
      const { endpoint, method } = call[2] as { endpoint: string; method: string };
      expect(`${method} ${endpoint}`).not.toMatch(/DELETE /);
      expect(endpoint).not.toMatch(/\/delete$/);
    }
  });

  it("surfaces a failed trash instead of reporting success", async () => {
    getConn.mockResolvedValue(gmailConn());
    workspaceProxy.mockResolvedValue({ status: 403, data: {} });
    await expect(
      organizeMessage({ businessId: BIZ, connectionId: CONN, messageId: "m-f", actions: { trash: true } })
    ).resolves.toEqual({ ok: false, detail: "gmail_trash_failed:403" });
  });

  it("reports a disconnected mailbox on the trash call", async () => {
    getConn.mockResolvedValue(gmailConn());
    workspaceProxy.mockResolvedValue(null);
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

  it("bins an Outlook message into deleteditems, not just the Gmail path", async () => {
    /**
     * Caught by Bugbot on the first push: `trash` was documented for Outlook
     * and organizeMessage routes connected mailboxes to organizeOutlook, but
     * that function never read the flag. It returned { ok: true } and left the
     * mail in the inbox, so a flow would believe it had binned something it
     * had not. Exactly the silent-success shape this codebase keeps hitting.
     */
    getConn.mockResolvedValue(outlookConn());
    // No preflight folder lookup: deleteditems is a well-known id.
    workspaceProxy.mockResolvedValueOnce({ status: 200, data: { id: "moved" } });
    const res = await organizeMessage({
      businessId: BIZ,
      connectionId: CONN,
      messageId: "AAMkTrash",
      actions: { trash: true }
    });
    expect(res).toEqual({ ok: true, provider: "microsoft" });
    expect(workspaceProxy).toHaveBeenCalledWith(
      BIZ,
      expect.anything(),
      expect.objectContaining({
        endpoint: "/v1.0/me/messages/AAMkTrash/move",
        method: "POST",
        data: { destinationId: "deleteditems" }
      })
    );
    // Resolved by well-known id, never by display name: "Deleted Items" is
    // localised, so a name lookup would fail on a non-English mailbox.
    for (const call of workspaceProxy.mock.calls) {
      expect((call[2] as { endpoint: string }).endpoint).not.toMatch(/mailFolders\?/);
    }
  });

  it("bins rather than files when a step asks for both", async () => {
    // Graph has no delete verb: a bin IS a move, and a message cannot be in
    // deleteditems and a filing folder at once. Trash has to win, or the
    // message quietly stays put in the folder instead.
    getConn.mockResolvedValue(outlookConn());
    workspaceProxy.mockResolvedValueOnce({ status: 200, data: { id: "moved" } });
    const res = await organizeMessage({
      businessId: BIZ,
      connectionId: CONN,
      messageId: "AAMkBoth",
      actions: { trash: true, archive: true, moveToFolder: "HQ/Automated" }
    });
    expect(res).toEqual({ ok: true, provider: "microsoft" });
    const move = workspaceProxy.mock.calls.find((c) =>
      (c[2] as { endpoint: string }).endpoint.endsWith("/move")
    );
    expect((move?.[2] as { data: { destinationId: string } }).data.destinationId).toBe(
      "deleteditems"
    );
  });

  it("surfaces a failed Outlook bin instead of reporting success", async () => {
    getConn.mockResolvedValue(outlookConn());
    workspaceProxy.mockResolvedValueOnce({ status: 500, data: {} });
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "AAMkFail",
        actions: { trash: true }
      })
    ).resolves.toEqual({ ok: false, detail: "outlook_move_failed:500" });
  });

  it("stars a Gmail message on the existing modify call, with no extra round trip", async () => {
    // STARRED is a system label, so a star rides the same modify the labels
    // and read-state use. An extra call here would be wasted quota.
    getConn.mockResolvedValue(gmailConn());
    workspaceProxy.mockResolvedValue({ status: 200, data: {} });
    const res = await organizeMessage({
      businessId: BIZ,
      connectionId: CONN,
      messageId: "m-star",
      actions: { star: true, markRead: true }
    });
    expect(res).toEqual({ ok: true, provider: "google" });
    expect(workspaceProxy).toHaveBeenCalledTimes(1);
    const data = (workspaceProxy.mock.calls[0][2] as { data: { addLabelIds?: string[]; removeLabelIds?: string[] } }).data;
    expect(data.addLabelIds).toContain("STARRED");
    expect(data.removeLabelIds).toContain("UNREAD");
  });

  it("unstars by removing the same system label", async () => {
    getConn.mockResolvedValue(gmailConn());
    workspaceProxy.mockResolvedValue({ status: 200, data: {} });
    await organizeMessage({
      businessId: BIZ,
      connectionId: CONN,
      messageId: "m-unstar",
      actions: { unstar: true }
    });
    const data = (workspaceProxy.mock.calls[0][2] as { data: { removeLabelIds?: string[] } }).data;
    expect(data.removeLabelIds).toContain("STARRED");
  });

  it("counts a star as an action on its own", async () => {
    getConn.mockResolvedValue(gmailConn());
    workspaceProxy.mockResolvedValue({ status: 200, data: {} });
    await expect(
      organizeMessage({ businessId: BIZ, connectionId: CONN, messageId: "m", actions: { star: true } })
    ).resolves.toEqual({ ok: true, provider: "google" });
  });

  it("refuses to star and unstar in one step", async () => {
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "m",
        actions: { star: true, unstar: true }
      })
    ).resolves.toEqual({ ok: false, detail: "star_and_unstar_conflict" });
  });

  it("flags an Outlook message, its nearest equivalent to a star", async () => {
    getConn.mockResolvedValue(outlookConn());
    workspaceProxy.mockResolvedValue({ status: 200, data: {} });
    const res = await organizeMessage({
      businessId: BIZ,
      connectionId: CONN,
      messageId: "AAMkFlag",
      actions: { star: true }
    });
    expect(res).toEqual({ ok: true, provider: "microsoft" });
    expect(workspaceProxy).toHaveBeenCalledWith(
      BIZ,
      expect.anything(),
      expect.objectContaining({
        endpoint: "/v1.0/me/messages/AAMkFlag",
        method: "PATCH",
        data: { flag: { flagStatus: "flagged" } }
      })
    );
  });

  it("clears the Outlook flag on unstar", async () => {
    getConn.mockResolvedValue(outlookConn());
    workspaceProxy.mockResolvedValue({ status: 200, data: {} });
    await organizeMessage({
      businessId: BIZ,
      connectionId: CONN,
      messageId: "AAMkUnflag",
      actions: { unstar: true }
    });
    const data = (workspaceProxy.mock.calls[0][2] as { data: { flag: { flagStatus: string } } }).data;
    expect(data.flag.flagStatus).toBe("notFlagged");
  });

  it("surfaces an Outlook flag failure and a dead connection", async () => {
    getConn.mockResolvedValue(outlookConn());
    workspaceProxy.mockResolvedValueOnce({ status: 500, data: {} });
    await expect(
      organizeMessage({ businessId: BIZ, connectionId: CONN, messageId: "m", actions: { star: true } })
    ).resolves.toEqual({ ok: false, detail: "outlook_flag_failed:500" });

    workspaceProxy.mockResolvedValueOnce({ status: 403, data: {} });
    await expect(
      organizeMessage({ businessId: BIZ, connectionId: CONN, messageId: "m", actions: { star: true } })
    ).resolves.toEqual({ ok: false, detail: "outlook_reconnect_required" });

    workspaceProxy.mockResolvedValueOnce(null);
    await expect(
      organizeMessage({ businessId: BIZ, connectionId: CONN, messageId: "m", actions: { star: true } })
    ).resolves.toEqual({ ok: false, detail: "email_not_connected" });
  });

  it("says the AI mailbox cannot be starred rather than reporting success", async () => {
    // Silently ignoring would tell a flow its receipt was starred when nothing
    // happened, which is the exact failure shape this file avoids elsewhere.
    await expect(
      organizeMessage({ businessId: BIZ, emailLogId: LOG, actions: { star: true, markRead: true } })
    ).resolves.toEqual({ ok: false, detail: "star_unsupported_for_tenant_mailbox" });
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

describe("organizeMessage: the display-only importance score", () => {
  /**
   * The score has no provider counterpart. Gmail and Outlook have no such
   * field, so it lands on OUR email_log row on every path, which is what makes
   * it visible for a connected mailbox at all.
   */
  beforeEach(() => {
    workspaceProxy.mockReset();
    getConn.mockReset();
    organizeTenant.mockReset();
    softDelete.mockReset();
    setImportance.mockReset();
    setImportance.mockResolvedValue(true);
  });

  it("counts as an action on its own, so a score-only step is not rejected", async () => {
    organizeTenant.mockResolvedValue(true);
    const res = await organizeMessage({
      businessId: BIZ,
      emailLogId: LOG,
      actions: { importance: 6 }
    });
    expect(res.ok).toBe(true);
    expect(setImportance).toHaveBeenCalledWith(BIZ, { emailLogId: LOG, providerMessageId: undefined }, 6);
  });

  it("writes on the connected Gmail path too, not just the AI mailbox", async () => {
    // The whole point: HQ's triage organizes a CONNECTED mailbox, so a score
    // that only worked on the tenant path would never appear for the mailbox
    // the feature was built for.
    getConn.mockResolvedValue(gmailConn());
    workspaceProxy.mockResolvedValue({ status: 200, data: { labels: [] } });
    const res = await organizeMessage({
      businessId: BIZ,
      connectionId: CONN,
      messageId: "gmail-1",
      emailLogId: LOG,
      actions: { markRead: true, importance: 4 }
    });
    expect(res.ok).toBe(true);
    expect(setImportance).toHaveBeenCalledWith(
      BIZ,
      { emailLogId: LOG, providerMessageId: "gmail-1" },
      4
    );
  });

  it("does not write a score when the provider work failed", async () => {
    // A failed labelling that still recorded a score would claim the step ran.
    getConn.mockResolvedValue(null);
    const res = await organizeMessage({
      businessId: BIZ,
      connectionId: CONN,
      messageId: "gmail-1",
      actions: { markRead: true, importance: 9 }
    });
    expect(res).toEqual({ ok: false, detail: "connection_not_found" });
    expect(setImportance).not.toHaveBeenCalled();
  });

  it("says so in the detail when there was no row to score, without failing", async () => {
    // Display-only: failing a real labelling action because a cosmetic field
    // had nowhere to land is the wrong trade. Silently succeeding is worse.
    organizeTenant.mockResolvedValue(true);
    setImportance.mockResolvedValue(false);
    const res = await organizeMessage({
      businessId: BIZ,
      emailLogId: LOG,
      actions: { addLabels: ["Sales"], importance: 6 }
    });
    expect(res.ok).toBe(true);
    expect(res.ok && res.detail).toBe("importance_row_not_found");
  });

  it("keeps an existing detail alongside the miss", async () => {
    getConn.mockResolvedValue(gmailConn());
    setImportance.mockResolvedValue(false);
    const res = await organizeMessage({
      businessId: BIZ,
      connectionId: CONN,
      messageId: "gmail-1",
      // No provider-visible action, so Gmail short-circuits with "noop".
      actions: { importance: 6 }
    });
    expect(res.ok).toBe(true);
    expect(res.ok && res.detail).toBe("noop,importance_row_not_found");
  });

  it("leaves the score alone when the step never asked for one", async () => {
    organizeTenant.mockResolvedValue(true);
    await organizeMessage({
      businessId: BIZ,
      emailLogId: LOG,
      actions: { markRead: true }
    });
    expect(setImportance).not.toHaveBeenCalled();
  });

  it("passes an explicit null through as a clear", async () => {
    // undefined means "the step said nothing"; null means "unset this".
    organizeTenant.mockResolvedValue(true);
    await organizeMessage({
      businessId: BIZ,
      emailLogId: LOG,
      actions: { importance: null }
    });
    expect(setImportance).toHaveBeenCalledWith(
      BIZ,
      { emailLogId: LOG, providerMessageId: undefined },
      null
    );
  });
});

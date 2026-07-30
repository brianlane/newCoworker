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
vi.mock("@/lib/db/email-log", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/email-log")>();
  return {
    ...actual,
    organizeTenantEmailLog: organizeTenant
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

  it("returns noop when Gmail modify has nothing to change", async () => {
    getConn.mockResolvedValue(gmailConn());
    // addLabels that fail to resolve (list returns empty, create fails)
    nangoProxy
      .mockResolvedValueOnce({ status: 200, data: { labels: [] } })
      .mockResolvedValueOnce({ status: 500, data: {} });
    const res = await organizeMessage({
      businessId: BIZ,
      connectionId: CONN,
      messageId: "msg-3",
      actions: { addLabels: ["Nope"] }
    });
    expect(res).toEqual({ ok: true, provider: "google", detail: "noop" });

    // labels key missing on list; removeLabels name that never resolves → noop
    nangoProxy.mockReset();
    nangoProxy
      .mockResolvedValueOnce({ status: 200, data: {} })
      .mockResolvedValueOnce({ status: 500, data: {} });
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "msg-4",
        actions: { removeLabels: ["Ghost"] }
      })
    ).resolves.toEqual({ ok: true, provider: "google", detail: "noop" });

    // moveToFolder that never resolves still archives (remove INBOX)
    nangoProxy.mockReset();
    nangoProxy
      .mockResolvedValueOnce({ status: 200, data: { labels: [] } })
      .mockResolvedValueOnce({ status: 500, data: {} })
      .mockResolvedValueOnce({ status: 200, data: {} });
    await expect(
      organizeMessage({
        businessId: BIZ,
        connectionId: CONN,
        messageId: "msg-4b",
        actions: { moveToFolder: "Ghost" }
      })
    ).resolves.toEqual({ ok: true, provider: "google" });

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
    nangoProxy
      .mockResolvedValueOnce({ status: 200, data: {} }) // isRead
      .mockResolvedValueOnce({ status: 200, data: { categories: ["Old", "Drop"] } }) // get cats
      .mockResolvedValueOnce({ status: 200, data: {} }) // patch cats
      .mockResolvedValueOnce({ status: 200, data: { id: "folder-archive" } }) // well-known
      .mockResolvedValueOnce({ status: 200, data: { id: "moved" } }); // move
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
    ).resolves.toEqual({ ok: false, detail: "outlook_categories_failed:400" });

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
    const noop = await organizeMessage({
      businessId: BIZ,
      connectionId: CONN,
      messageId: "m",
      actions: { addLabels: ["A"] }
    });
    expect(noop).toEqual({ ok: true, provider: "google", detail: "noop" });

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

/**
 * Organize a message in a connected Gmail/Outlook mailbox or the AI coworker's
 * in-app email_log row (tenant mailbox). Shared by the AiFlow email_organize
 * step gateway and the Dashboard → Emails reading-pane actions.
 *
 * Gmail uses the already-granted gmail.modify scope (messages.modify + labels).
 * Outlook needs Mail.ReadWrite (move / isRead / categories); missing scope
 * returns a soft reconnect hint. Tenant updates are SQL-only.
 */
import {
  workspaceProxyForBusiness,
  workspaceProxyStatusForBusiness
} from "@/lib/workspace/proxy";
import {
  getWorkspaceOAuthConnection,
  type WorkspaceOAuthConnectionRow
} from "@/lib/db/workspace-oauth-connections";
import { isEmailProviderConfigKey, providerFromKey } from "@/lib/voice-tools/connections";
import {
  organizeTenantEmailLog,
  setEmailLogImportance,
  softDeleteEmailLogEntry,
  type OrganizeTenantEmailInput
} from "@/lib/db/email-log";

export type OrganizeEmailActions = {
  markRead?: boolean;
  markUnread?: boolean;
  archive?: boolean;
  unarchive?: boolean;
  /**
   * Move to the provider's trash (Gmail Bin / Outlook Deleted Items), or
   * soft-delete the AI mailbox row. Recoverable by design: Gmail keeps a
   * trashed message for 30 days. There is no hard-delete counterpart, because
   * the caller is often an AI classification and that must always be undoable.
   */
  trash?: boolean;
  /**
   * Star / unstar. Gmail uses the STARRED system label; Outlook uses the
   * follow-up flag, its nearest equivalent. The AI mailbox has no star, so
   * that path reports the request as unsupported rather than reporting a
   * success it did not perform.
   */
  star?: boolean;
  unstar?: boolean;
  addLabels?: string[];
  removeLabels?: string[];
  /** Folder display name (null/empty clears to Inbox for tenant; provider move for Outlook/Gmail). */
  moveToFolder?: string | null;
  /**
   * Display-only 1-10 importance score for this message (null clears it).
   *
   * Unlike every other action here, this has no provider counterpart: Gmail and
   * Outlook have no such field, so it is written to our own email_log row on
   * ALL paths, connected mailboxes included. It sorts the dashboard Emails page
   * and must never gate alerting, routing, or digest behavior.
   */
  importance?: number | null;
};

export type OrganizeEmailRequest = {
  businessId: string;
  /** Connected mailbox: workspace_oauth_connections.id. Omit for tenant/AI mailbox. */
  connectionId?: string | null;
  /** Provider message id (Gmail/Graph) or RFC Message-Id for tenant lookup fallback. */
  messageId?: string | null;
  /** Preferred identity for tenant_email organize. */
  emailLogId?: string | null;
  actions: OrganizeEmailActions;
};

export type OrganizeEmailResult =
  | { ok: true; provider: "google" | "microsoft" | "tenant"; detail?: string }
  | { ok: false; detail: string };

function normalizeLabelList(raw?: string[]): string[] {
  if (!raw?.length) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const t = item.trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t.slice(0, 120));
  }
  return out.slice(0, 20);
}

/**
 * Whether this request asks the mailbox to do anything at all.
 *
 * Exported so the AiFlow gateway can ask the SAME question before dispatching:
 * a step whose only instruction was a score the model never produced has
 * nothing to do, and answering that with `no_organize_actions` would fail the
 * step over a display-only field. One definition, so the two cannot drift into
 * disagreeing about what "nothing to do" means.
 */
export function hasAnyOrganizeAction(actions: OrganizeEmailActions): boolean {
  return Boolean(
    actions.markRead ||
      actions.markUnread ||
      actions.archive ||
      actions.unarchive ||
      actions.trash ||
      actions.star ||
      actions.unstar ||
      (actions.addLabels && actions.addLabels.length > 0) ||
      (actions.removeLabels && actions.removeLabels.length > 0) ||
      actions.moveToFolder !== undefined ||
      actions.importance !== undefined
  );
}

/**
 * Organize one message. Tenant path when connectionId is absent; connected
 * path when connectionId is set.
 */
export async function organizeMessage(req: OrganizeEmailRequest): Promise<OrganizeEmailResult> {
  if (!hasAnyOrganizeAction(req.actions)) {
    return { ok: false, detail: "no_organize_actions" };
  }
  if (req.actions.markRead && req.actions.markUnread) {
    return { ok: false, detail: "mark_read_and_unread_conflict" };
  }
  if (req.actions.archive && req.actions.unarchive) {
    return { ok: false, detail: "archive_and_unarchive_conflict" };
  }
  // Binning something and asking for it back in the inbox in one step is a
  // authoring mistake, not a sequence: refuse rather than pick a winner.
  if (req.actions.trash && (req.actions.unarchive || req.actions.markUnread)) {
    return { ok: false, detail: "trash_and_restore_conflict" };
  }
  if (req.actions.star && req.actions.unstar) {
    return { ok: false, detail: "star_and_unstar_conflict" };
  }

  const actions: OrganizeEmailActions = {
    ...req.actions,
    addLabels: normalizeLabelList(req.actions.addLabels),
    removeLabels: normalizeLabelList(req.actions.removeLabels)
  };

  if (!req.connectionId) {
    const result = await organizeTenant(req.businessId, req.emailLogId, req.messageId, actions);
    return withImportance(req, actions, result);
  }

  const row = await getWorkspaceOAuthConnection(req.businessId, req.connectionId);
  if (!row) return { ok: false, detail: "connection_not_found" };
  if (!isEmailProviderConfigKey(row.provider_config_key)) {
    return { ok: false, detail: "not_email_connection" };
  }
  const messageId = (req.messageId ?? "").trim();
  if (!messageId) return { ok: false, detail: "message_id_required" };

  const provider = providerFromKey(row.provider_config_key);
  const result =
    provider === "google"
      ? await organizeGmail(req.businessId, row, messageId, actions)
      : await organizeOutlook(req.businessId, row, messageId, actions);
  return withImportance(req, actions, result);
}

/**
 * Write the display-only importance score after the provider work, on every
 * path. Runs last so a message is filed at the provider before we annotate our
 * own copy of it, and only on success, so a failed labelling never leaves a
 * score claiming the step ran.
 *
 * A missing email_log row DOWNGRADES to a detail note instead of failing the
 * step. The score is display-only, and a connected mailbox can legitimately
 * organize a message we hold no row for (an owner acting from the reading pane
 * on older mail). Failing a real labelling action because a cosmetic field had
 * nowhere to land would be the wrong trade, and a silent success would be
 * worse, so it says so in `detail`.
 */
async function withImportance(
  req: OrganizeEmailRequest,
  actions: OrganizeEmailActions,
  result: OrganizeEmailResult
): Promise<OrganizeEmailResult> {
  if (actions.importance === undefined || !result.ok) return result;
  const wrote = await setEmailLogImportance(
    req.businessId,
    { emailLogId: req.emailLogId, providerMessageId: req.messageId },
    actions.importance
  );
  if (wrote) return result;
  return {
    ...result,
    detail: result.detail
      ? `${result.detail},importance_row_not_found`
      : "importance_row_not_found"
  };
}

async function organizeTenant(
  businessId: string,
  emailLogId: string | null | undefined,
  messageId: string | null | undefined,
  actions: OrganizeEmailActions
): Promise<OrganizeEmailResult> {
  if (actions.star || actions.unstar) {
    // The AI mailbox has no star, and the dashboard Emails page renders none.
    // Reporting ok here would tell a flow its receipt was starred when
    // nothing happened, which is the silent-success shape this file avoids
    // everywhere else.
    return { ok: false, detail: "star_unsupported_for_tenant_mailbox" };
  }
  const input: OrganizeTenantEmailInput = {
    businessId,
    emailLogId: emailLogId?.trim() || null,
    providerMessageId: messageId?.trim() || null,
    markRead: actions.markRead,
    markUnread: actions.markUnread,
    archive: actions.archive,
    unarchive: actions.unarchive,
    addLabels: actions.addLabels,
    removeLabels: actions.removeLabels,
    moveToFolder: actions.moveToFolder
  };
  if (!input.emailLogId && !input.providerMessageId) {
    return { ok: false, detail: "email_log_id_or_message_id_required" };
  }
  // markRead/labels first so the row is filed the way the caller asked, then
  // the soft delete. organizeTenantEmailLog needs at least one field of its
  // own, so a trash-only request skips straight to the delete.
  const wantsOrganize = Boolean(
    input.markRead ||
      input.markUnread ||
      input.archive ||
      input.unarchive ||
      input.addLabels?.length ||
      input.removeLabels?.length ||
      input.moveToFolder !== undefined
  );
  if (wantsOrganize) {
    const updated = await organizeTenantEmailLog(input);
    if (!updated) return { ok: false, detail: "email_log_not_found" };
  }
  if (actions.trash) {
    // The soft delete is keyed by row id, and organizeTenantEmailLog reports
    // only whether it matched, so a trash on this path needs the id up front.
    // Every AiFlow caller has it: email_organize prefers {{trigger.email_log_id}}.
    const rowId = emailLogId?.trim() || null;
    if (!rowId) return { ok: false, detail: "email_log_id_required_for_trash" };
    const removed = await softDeleteEmailLogEntry(businessId, rowId, "ai_flow");
    if (removed === 0) return { ok: false, detail: "email_log_not_found" };
  }
  return { ok: true, provider: "tenant" };
}

type GmailLabel = { id?: string; name?: string; type?: string };

async function organizeGmail(
  businessId: string,
  row: WorkspaceOAuthConnectionRow,
  messageId: string,
  actions: OrganizeEmailActions
): Promise<OrganizeEmailResult> {
  const link = {
    connectionId: row.connection_id,
    providerConfigKey: row.provider_config_key
  };
  const addLabelIds: string[] = [];
  const removeLabelIds: string[] = [];

  if (actions.markRead) removeLabelIds.push("UNREAD");
  if (actions.markUnread) addLabelIds.push("UNREAD");
  // STARRED is a system label, so a star needs no extra round trip.
  if (actions.star) addLabelIds.push("STARRED");
  if (actions.unstar) removeLabelIds.push("STARRED");
  if (actions.archive || (actions.moveToFolder && actions.moveToFolder.trim())) {
    removeLabelIds.push("INBOX");
  }
  if (actions.unarchive) addLabelIds.push("INBOX");

  const addNames = normalizeLabelList(actions.addLabels);
  const removeNames = normalizeLabelList(actions.removeLabels);
  const moveFolder = actions.moveToFolder?.trim() || "";
  // Create-if-missing only for labels we apply; remove targets resolve from list.
  const createNames = [...addNames, ...(moveFolder ? [moveFolder] : [])];
  let byName = new Map<string, string>();
  if (createNames.length > 0 || removeNames.length > 0) {
    const ensured = await ensureGmailLabels(businessId, link, createNames);
    if (!ensured.ok) return { ok: false, detail: ensured.detail };
    byName = ensured.map;
  }
  // ensureGmailLabels either maps every createNames entry or returns ok:false.
  for (const name of addNames) {
    addLabelIds.push(byName.get(name.toLowerCase())!);
  }
  for (const name of removeNames) {
    const id = byName.get(name.toLowerCase());
    // Missing remove target is a no-op (label already gone).
    if (id) removeLabelIds.push(id);
  }
  if (moveFolder) {
    addLabelIds.push(byName.get(moveFolder.toLowerCase())!);
  }

  const uniqueAdd = [...new Set(addLabelIds)];
  const uniqueRemove = [...new Set(removeLabelIds)].filter((id) => !uniqueAdd.includes(id));
  if (uniqueAdd.length === 0 && uniqueRemove.length === 0 && !actions.trash) {
    return { ok: true, provider: "google", detail: "noop" };
  }

  if (uniqueAdd.length > 0 || uniqueRemove.length > 0) {
    const res = await workspaceProxyStatusForBusiness(businessId, link, {
      endpoint: `/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/modify`,
      method: "POST",
      data: {
        ...(uniqueAdd.length ? { addLabelIds: uniqueAdd } : {}),
        ...(uniqueRemove.length ? { removeLabelIds: uniqueRemove } : {})
      }
    });
    if (!res) return { ok: false, detail: "email_not_connected" };
    if (res.status >= 400) {
      return { ok: false, detail: `gmail_modify_failed:${res.status}` };
    }
  }

  // Trash LAST, so labels applied above survive on the binned message and it
  // is still findable by label in the Bin. messages.trash is reversible
  // (untrash, 30-day retention) and is NOT messages.delete, which is
  // permanent and deliberately never called anywhere in this codebase.
  if (actions.trash) {
    const res = await workspaceProxyStatusForBusiness(businessId, link, {
      endpoint: `/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/trash`,
      method: "POST",
      data: {}
    });
    if (!res) return { ok: false, detail: "email_not_connected" };
    if (res.status >= 400) {
      return { ok: false, detail: `gmail_trash_failed:${res.status}` };
    }
  }
  return { ok: true, provider: "google" };
}

async function ensureGmailLabels(
  businessId: string,
  link: { connectionId: string; providerConfigKey: string },
  createNames: string[]
): Promise<{ ok: true; map: Map<string, string> } | { ok: false; detail: string }> {
  const map = new Map<string, string>();
  const listRes = await workspaceProxyStatusForBusiness(businessId, link, {
    endpoint: "/gmail/v1/users/me/labels",
    method: "GET"
  });
  if (!listRes) return { ok: false, detail: "email_not_connected" };
  if (listRes.status >= 400) {
    return { ok: false, detail: `gmail_labels_list_failed:${listRes.status}` };
  }
  const labels = ((listRes.data as { labels?: GmailLabel[] })?.labels ?? []).filter(
    (l): l is GmailLabel & { id: string; name: string } =>
      typeof l.id === "string" && typeof l.name === "string"
  );
  for (const l of labels) map.set(l.name.toLowerCase(), l.id);

  for (const name of createNames) {
    const key = name.toLowerCase();
    if (map.has(key)) continue;
    const created = await workspaceProxyStatusForBusiness(businessId, link, {
      endpoint: "/gmail/v1/users/me/labels",
      method: "POST",
      data: {
        name,
        labelListVisibility: "labelShow",
        messageListVisibility: "show"
      }
    });
    if (!created) return { ok: false, detail: "email_not_connected" };
    if (created.status >= 400) {
      return { ok: false, detail: `gmail_label_create_failed:${name}:${created.status}` };
    }
    const id = (created.data as { id?: string } | undefined)?.id;
    if (typeof id !== "string") {
      return { ok: false, detail: `gmail_label_create_failed:${name}` };
    }
    map.set(key, id);
  }
  return { ok: true, map };
}

type GraphFolder = { id?: string; displayName?: string };

async function organizeOutlook(
  businessId: string,
  row: WorkspaceOAuthConnectionRow,
  messageId: string,
  actions: OrganizeEmailActions
): Promise<OrganizeEmailResult> {
  const link = {
    connectionId: row.connection_id,
    providerConfigKey: row.provider_config_key
  };
  const reconnectHint = "outlook_reconnect_required";

  // Prefer an explicit folder move over Archive so archive+moveToFolder matches
  // Gmail (label + leave Inbox) instead of silently dropping the folder.
  //
  // Trash outranks everything: Graph has no separate delete-to-bin verb, so a
  // bin IS a move to the well-known deleteditems folder, and a message cannot
  // sit in both there and a filing folder. Resolved by well-known id rather
  // than display name because "Deleted Items" is localised.
  let destinationName: string | null = null;
  let destinationId: string | null = null;
  if (actions.trash) destinationId = "deleteditems";
  else if (actions.moveToFolder?.trim()) destinationName = actions.moveToFolder.trim();
  else if (actions.archive) destinationName = "Archive";
  else if (actions.unarchive) destinationName = "Inbox";

  // Preflight reads first so folder/category lookup failures do not leave a
  // half-applied mailbox (Graph has no multi-op transaction).
  if (destinationName) {
    destinationId = await resolveOutlookFolderId(businessId, link, destinationName);
    if (!destinationId) {
      return { ok: false, detail: `outlook_folder_not_found:${destinationName}` };
    }
  }

  const addCats = normalizeLabelList(actions.addLabels);
  const removeCats = new Set(normalizeLabelList(actions.removeLabels).map((c) => c.toLowerCase()));
  let nextCategories: string[] | null = null;
  if (addCats.length > 0 || removeCats.size > 0) {
    const getRes = await workspaceProxyStatusForBusiness(businessId, link, {
      endpoint: `/v1.0/me/messages/${encodeURIComponent(messageId)}?$select=categories`,
      method: "GET"
    });
    if (!getRes) return { ok: false, detail: "email_not_connected" };
    if (getRes.status === 401 || getRes.status === 403) {
      return { ok: false, detail: reconnectHint };
    }
    if (getRes.status >= 400) {
      // Fail closed: do not PATCH categories with an empty merge base.
      return { ok: false, detail: `outlook_categories_get_failed:${getRes.status}` };
    }
    const existing = ((getRes.data as { categories?: string[] })?.categories ?? []).filter(
      (c): c is string => typeof c === "string"
    );
    nextCategories = [
      ...existing.filter((c) => !removeCats.has(c.toLowerCase())),
      ...addCats.filter((c) => !existing.some((e) => e.toLowerCase() === c.toLowerCase()))
    ].slice(0, 25);
  }

  const patchData: Record<string, unknown> = {};
  if (actions.markRead || actions.markUnread) {
    patchData.isRead = Boolean(actions.markRead);
  }
  if (nextCategories) patchData.categories = nextCategories;
  if (Object.keys(patchData).length > 0) {
    const patch = await workspaceProxyStatusForBusiness(businessId, link, {
      endpoint: `/v1.0/me/messages/${encodeURIComponent(messageId)}`,
      method: "PATCH",
      data: patchData
    });
    if (!patch) return { ok: false, detail: "email_not_connected" };
    if (patch.status === 401 || patch.status === 403) {
      return { ok: false, detail: reconnectHint };
    }
    if (patch.status >= 400) {
      return { ok: false, detail: `outlook_patch_failed:${patch.status}` };
    }
  }

  // Outlook has no star: the follow-up flag is its nearest equivalent, and it
  // is what "flagged" means in every Outlook client.
  if (actions.star || actions.unstar) {
    const flagRes = await workspaceProxyStatusForBusiness(businessId, link, {
      endpoint: `/v1.0/me/messages/${encodeURIComponent(messageId)}`,
      method: "PATCH",
      data: { flag: { flagStatus: actions.star ? "flagged" : "notFlagged" } }
    });
    if (!flagRes) return { ok: false, detail: "email_not_connected" };
    if (flagRes.status === 401 || flagRes.status === 403) {
      return { ok: false, detail: reconnectHint };
    }
    if (flagRes.status >= 400) {
      return { ok: false, detail: `outlook_flag_failed:${flagRes.status}` };
    }
  }

  if (destinationId) {
    const moveRes = await workspaceProxyStatusForBusiness(businessId, link, {
      endpoint: `/v1.0/me/messages/${encodeURIComponent(messageId)}/move`,
      method: "POST",
      data: { destinationId }
    });
    if (!moveRes) return { ok: false, detail: "email_not_connected" };
    if (moveRes.status === 401 || moveRes.status === 403) {
      return { ok: false, detail: reconnectHint };
    }
    if (moveRes.status >= 400) {
      return { ok: false, detail: `outlook_move_failed:${moveRes.status}` };
    }
  }

  return { ok: true, provider: "microsoft" };
}

async function resolveOutlookFolderId(
  businessId: string,
  link: { connectionId: string; providerConfigKey: string },
  displayName: string
): Promise<string | null> {
  const wanted = displayName.trim().toLowerCase();
  // Well-known folders first (Archive / Inbox / etc.).
  const wellKnown = ["inbox", "archive", "deleteditems", "drafts", "sentitems", "junkemail"];
  const wellKnownKey = wanted.replace(/\s+/g, "");
  if (wellKnown.includes(wellKnownKey)) {
    // Status-normalizing on purpose: a mailbox that has never had an Archive
    // folder answers 404 here, and the intended response is to fall through to
    // the scan below, not to abort the whole organize.
    const wk = await workspaceProxyStatusForBusiness(businessId, link, {
      endpoint: `/v1.0/me/mailFolders/${wellKnownKey}`,
      method: "GET"
    });
    const id = (wk?.data as { id?: string } | undefined)?.id;
    if (typeof id === "string") return id;
  }

  let endpoint = "/v1.0/me/mailFolders?$top=100&$select=id,displayName";
  for (let page = 0; page < 5; page++) {
    // Raw proxy: this loop has no way to distinguish "the folder is not in
    // this page" from "Graph refused the read", and returning null for the
    // second would report a missing folder for what is really an outage. Let
    // the throw carry the reason up.
    const res = await workspaceProxyForBusiness(businessId, link, { endpoint, method: "GET" });
    if (!res) return null;
    const data = res.data as { value?: GraphFolder[]; "@odata.nextLink"?: string };
    for (const f of data.value ?? []) {
      if (
        typeof f.id === "string" &&
        typeof f.displayName === "string" &&
        f.displayName.trim().toLowerCase() === wanted
      ) {
        return f.id;
      }
    }
    const next = data["@odata.nextLink"];
    if (!next || typeof next !== "string") break;
    // Graph nextLink is absolute; Nango proxy wants a path. Strip origin.
    try {
      const u = new URL(next);
      endpoint = `${u.pathname}${u.search}`;
    } catch {
      break;
    }
  }
  return null;
}

/**
 * Re-export for mark-handled poller convenience (Gmail remove UNREAD).
 * Raw proxy: the result is discarded, so a failure has to throw to be visible
 * at all. Callers wrap this in their own logging catch.
 */
export async function markGmailMessageRead(
  businessId: string,
  link: { connectionId: string; providerConfigKey: string },
  messageId: string
): Promise<void> {
  await workspaceProxyForBusiness(businessId, link, {
    endpoint: `/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/modify`,
    method: "POST",
    data: { removeLabelIds: ["UNREAD"] }
  });
}

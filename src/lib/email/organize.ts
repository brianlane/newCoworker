/**
 * Organize a message in a connected Gmail/Outlook mailbox or the AI coworker's
 * in-app email_log row (tenant mailbox). Shared by the AiFlow email_organize
 * step gateway and the Dashboard → Emails reading-pane actions.
 *
 * Gmail uses the already-granted gmail.modify scope (messages.modify + labels).
 * Outlook needs Mail.ReadWrite (move / isRead / categories); missing scope
 * returns a soft reconnect hint. Tenant updates are SQL-only.
 */
import { nangoProxyForBusiness } from "@/lib/nango/workspace";
import {
  getWorkspaceOAuthConnection,
  type WorkspaceOAuthConnectionRow
} from "@/lib/db/workspace-oauth-connections";
import { isEmailProviderConfigKey, providerFromKey } from "@/lib/voice-tools/connections";
import {
  organizeTenantEmailLog,
  type OrganizeTenantEmailInput
} from "@/lib/db/email-log";

export type OrganizeEmailActions = {
  markRead?: boolean;
  markUnread?: boolean;
  archive?: boolean;
  unarchive?: boolean;
  addLabels?: string[];
  removeLabels?: string[];
  /** Folder display name (null/empty clears to Inbox for tenant; provider move for Outlook/Gmail). */
  moveToFolder?: string | null;
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

function hasAnyAction(actions: OrganizeEmailActions): boolean {
  return Boolean(
    actions.markRead ||
      actions.markUnread ||
      actions.archive ||
      actions.unarchive ||
      (actions.addLabels && actions.addLabels.length > 0) ||
      (actions.removeLabels && actions.removeLabels.length > 0) ||
      actions.moveToFolder !== undefined
  );
}

/**
 * Organize one message. Tenant path when connectionId is absent; connected
 * path when connectionId is set.
 */
export async function organizeMessage(req: OrganizeEmailRequest): Promise<OrganizeEmailResult> {
  if (!hasAnyAction(req.actions)) {
    return { ok: false, detail: "no_organize_actions" };
  }
  if (req.actions.markRead && req.actions.markUnread) {
    return { ok: false, detail: "mark_read_and_unread_conflict" };
  }
  if (req.actions.archive && req.actions.unarchive) {
    return { ok: false, detail: "archive_and_unarchive_conflict" };
  }

  const actions: OrganizeEmailActions = {
    ...req.actions,
    addLabels: normalizeLabelList(req.actions.addLabels),
    removeLabels: normalizeLabelList(req.actions.removeLabels)
  };

  if (!req.connectionId) {
    return organizeTenant(req.businessId, req.emailLogId, req.messageId, actions);
  }

  const row = await getWorkspaceOAuthConnection(req.businessId, req.connectionId);
  if (!row) return { ok: false, detail: "connection_not_found" };
  if (!isEmailProviderConfigKey(row.provider_config_key)) {
    return { ok: false, detail: "not_email_connection" };
  }
  const messageId = (req.messageId ?? "").trim();
  if (!messageId) return { ok: false, detail: "message_id_required" };

  const provider = providerFromKey(row.provider_config_key);
  if (provider === "google") {
    return organizeGmail(req.businessId, row, messageId, actions);
  }
  return organizeOutlook(req.businessId, row, messageId, actions);
}

async function organizeTenant(
  businessId: string,
  emailLogId: string | null | undefined,
  messageId: string | null | undefined,
  actions: OrganizeEmailActions
): Promise<OrganizeEmailResult> {
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
  const updated = await organizeTenantEmailLog(input);
  if (!updated) return { ok: false, detail: "email_log_not_found" };
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
  if (actions.archive || (actions.moveToFolder && actions.moveToFolder.trim())) {
    removeLabelIds.push("INBOX");
  }
  if (actions.unarchive) addLabelIds.push("INBOX");

  const needNames = [
    ...normalizeLabelList(actions.addLabels),
    ...normalizeLabelList(actions.removeLabels),
    ...(actions.moveToFolder?.trim() ? [actions.moveToFolder.trim()] : [])
  ];
  let byName = new Map<string, string>();
  if (needNames.length > 0) {
    byName = await ensureGmailLabels(businessId, link, needNames);
  }
  for (const name of normalizeLabelList(actions.addLabels)) {
    const id = byName.get(name.toLowerCase());
    if (id) addLabelIds.push(id);
  }
  for (const name of normalizeLabelList(actions.removeLabels)) {
    const id = byName.get(name.toLowerCase());
    if (id) removeLabelIds.push(id);
  }
  if (actions.moveToFolder?.trim()) {
    const id = byName.get(actions.moveToFolder.trim().toLowerCase());
    if (id) addLabelIds.push(id);
  }

  const uniqueAdd = [...new Set(addLabelIds)];
  const uniqueRemove = [...new Set(removeLabelIds)].filter((id) => !uniqueAdd.includes(id));
  if (uniqueAdd.length === 0 && uniqueRemove.length === 0) {
    return { ok: true, provider: "google", detail: "noop" };
  }

  const res = await nangoProxyForBusiness(businessId, link, {
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
  return { ok: true, provider: "google" };
}

async function ensureGmailLabels(
  businessId: string,
  link: { connectionId: string; providerConfigKey: string },
  names: string[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const listRes = await nangoProxyForBusiness(businessId, link, {
    endpoint: "/gmail/v1/users/me/labels",
    method: "GET"
  });
  if (!listRes) return map;
  const labels = ((listRes.data as { labels?: GmailLabel[] })?.labels ?? []).filter(
    (l): l is GmailLabel & { id: string; name: string } =>
      typeof l.id === "string" && typeof l.name === "string"
  );
  for (const l of labels) map.set(l.name.toLowerCase(), l.id);

  for (const name of names) {
    const key = name.toLowerCase();
    if (map.has(key)) continue;
    const created = await nangoProxyForBusiness(businessId, link, {
      endpoint: "/gmail/v1/users/me/labels",
      method: "POST",
      data: {
        name,
        labelListVisibility: "labelShow",
        messageListVisibility: "show"
      }
    });
    const id = (created?.data as { id?: string } | undefined)?.id;
    if (typeof id === "string") map.set(key, id);
  }
  return map;
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

  if (actions.markRead || actions.markUnread) {
    const patch = await nangoProxyForBusiness(businessId, link, {
      endpoint: `/v1.0/me/messages/${encodeURIComponent(messageId)}`,
      method: "PATCH",
      data: { isRead: Boolean(actions.markRead) }
    });
    if (!patch) return { ok: false, detail: "email_not_connected" };
    if (patch.status === 401 || patch.status === 403) {
      return { ok: false, detail: reconnectHint };
    }
    if (patch.status >= 400) {
      return { ok: false, detail: `outlook_patch_failed:${patch.status}` };
    }
  }

  const addCats = normalizeLabelList(actions.addLabels);
  const removeCats = new Set(normalizeLabelList(actions.removeLabels).map((c) => c.toLowerCase()));
  if (addCats.length > 0 || removeCats.size > 0) {
    const getRes = await nangoProxyForBusiness(businessId, link, {
      endpoint: `/v1.0/me/messages/${encodeURIComponent(messageId)}?$select=categories`,
      method: "GET"
    });
    if (!getRes) return { ok: false, detail: "email_not_connected" };
    if (getRes.status === 401 || getRes.status === 403) {
      return { ok: false, detail: reconnectHint };
    }
    const existing = ((getRes.data as { categories?: string[] })?.categories ?? []).filter(
      (c): c is string => typeof c === "string"
    );
    const next = [
      ...existing.filter((c) => !removeCats.has(c.toLowerCase())),
      ...addCats.filter((c) => !existing.some((e) => e.toLowerCase() === c.toLowerCase()))
    ].slice(0, 25);
    const catRes = await nangoProxyForBusiness(businessId, link, {
      endpoint: `/v1.0/me/messages/${encodeURIComponent(messageId)}`,
      method: "PATCH",
      data: { categories: next }
    });
    if (!catRes) return { ok: false, detail: "email_not_connected" };
    if (catRes.status === 401 || catRes.status === 403) {
      return { ok: false, detail: reconnectHint };
    }
    if (catRes.status >= 400) {
      return { ok: false, detail: `outlook_categories_failed:${catRes.status}` };
    }
  }

  let destinationName: string | null = null;
  if (actions.archive) destinationName = "Archive";
  else if (actions.moveToFolder?.trim()) destinationName = actions.moveToFolder.trim();
  else if (actions.unarchive) destinationName = "Inbox";

  if (destinationName) {
    const folderId = await resolveOutlookFolderId(businessId, link, destinationName);
    if (!folderId) {
      return { ok: false, detail: `outlook_folder_not_found:${destinationName}` };
    }
    const moveRes = await nangoProxyForBusiness(businessId, link, {
      endpoint: `/v1.0/me/messages/${encodeURIComponent(messageId)}/move`,
      method: "POST",
      data: { destinationId: folderId }
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
    const wk = await nangoProxyForBusiness(businessId, link, {
      endpoint: `/v1.0/me/mailFolders/${wellKnownKey}`,
      method: "GET"
    });
    const id = (wk?.data as { id?: string } | undefined)?.id;
    if (typeof id === "string") return id;
  }

  let endpoint = "/v1.0/me/mailFolders?$top=100&$select=id,displayName";
  for (let page = 0; page < 5; page++) {
    const res = await nangoProxyForBusiness(businessId, link, { endpoint, method: "GET" });
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

/** Re-export for mark-handled poller convenience (Gmail remove UNREAD). */
export async function markGmailMessageRead(
  businessId: string,
  link: { connectionId: string; providerConfigKey: string },
  messageId: string
): Promise<void> {
  await nangoProxyForBusiness(businessId, link, {
    endpoint: `/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/modify`,
    method: "POST",
    data: { removeLabelIds: ["UNREAD"] }
  });
}

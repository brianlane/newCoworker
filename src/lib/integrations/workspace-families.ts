/**
 * Which integrations tile a `workspace_oauth_connections` row belongs to.
 *
 * Every workspace connection lives in ONE table and counts against ONE plan
 * cap, but /dashboard/integrations now shows three separate tiles: Google,
 * Microsoft 365, and "Other 3rd Party Connections" (the Nango long tail:
 * Drive, OneDrive, and anything else the Connect UI can broker). This module
 * is the single place that decides which row belongs to which, so the hub
 * tile counts and the detail pages can never disagree about it.
 *
 * ## Why this is not `providerFromKey`
 *
 * `src/lib/voice-tools/connections.ts` already maps a provider key to a
 * provider, but it is a BINARY resolver fallback: anything that is not
 * Google is Microsoft, so OneDrive and a stray Nango row both come back as
 * "microsoft". That is right for "which API dialect do I speak to this
 * grant", and wrong for "which tile does this row appear under", where a
 * OneDrive row belongs in Other. It also lives in a module that reaches into
 * the database on import. Hence a separate, client-safe, three-way split.
 */
import { GOOGLE_KEYS, OUTLOOK_KEYS } from "@/lib/workspace/reconnect";

export type WorkspaceFamily = "google" | "microsoft" | "other";

/**
 * Google's four keys, reused verbatim from the reconnect matcher: the Nango
 * era accumulated `google`, `gmail`, `google-mail`, and `google-calendar`,
 * and a tenant on any of them holds a Google connection.
 */
export const GOOGLE_FAMILY_KEYS = GOOGLE_KEYS;

/**
 * Microsoft's keys, deliberately WIDER than the reconnect matcher's.
 *
 * `OUTLOOK_KEYS` excludes the legacy `outlook-calendar` key on purpose, because
 * adopting a calendar-only row on a MAILBOX connect would leave the tenant
 * "connected" with nothing that can send mail (see the docstring in
 * `@/lib/workspace/reconnect`). That reasoning is about which row a connect
 * may overwrite. Display has the opposite requirement: an `outlook-calendar`
 * row IS a Microsoft connection the owner made, and hiding it in "Other 3rd
 * Party Connections" would strand it somewhere they would never look for it.
 */
export const MICROSOFT_FAMILY_KEYS = [...OUTLOOK_KEYS, "outlook-calendar"] as const;

export function workspaceFamilyOf(providerConfigKey: string): WorkspaceFamily {
  const key = providerConfigKey.trim().toLowerCase();
  if ((GOOGLE_FAMILY_KEYS as readonly string[]).includes(key)) return "google";
  if ((MICROSOFT_FAMILY_KEYS as readonly string[]).includes(key)) return "microsoft";
  return "other";
}

/**
 * Split connection rows into the three tiles, preserving input order within
 * each bucket (callers list oldest-first and the pages render that order).
 *
 * Generic over the row shape because the server reads snake_case database rows
 * and the dashboard client component holds camelCase ones; `keyOf` is the only
 * difference between them.
 */
export function groupByWorkspaceFamily<T>(
  rows: readonly T[],
  keyOf: (row: T) => string
): Record<WorkspaceFamily, T[]> {
  const grouped: Record<WorkspaceFamily, T[]> = { google: [], microsoft: [], other: [] };
  for (const row of rows) grouped[workspaceFamilyOf(keyOf(row))].push(row);
  return grouped;
}

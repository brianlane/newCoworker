/**
 * Pure reconnect copy for every stored grant except Calendly (Calendly keeps
 * its own phrasing in src/lib/calendly/reauth-copy.ts). Account labels,
 * paused-work wording, banner sentences, last-check formatting. No DB, so
 * the dashboard and the email template share one phrasing.
 *
 * User-facing copy names the provider and the account. It never says
 * "token rejected".
 */

export type ConnectionReauthTable =
  | "workspace_oauth_connections"
  | "zoom_connections"
  | "acuity_connections"
  | "caldav_connections"
  | "vagaro_connections"
  | "meta_connections"
  | "slack_connections"
  | "whatsapp_connections";

export type ConnectionReauthProviderLabel =
  | "Google"
  | "Microsoft 365"
  | "Zoom"
  | "Acuity"
  | "CalDAV"
  | "Vagaro"
  | "Facebook"
  | "Slack"
  | "WhatsApp"
  | "Workspace";

/** notifications.kind for every non-Calendly reconnect email + dashboard row. */
export const CONNECTION_REAUTH_KIND = "connection_needs_reauth";

/** Once on the flip, once more after a day, then never. */
export const CONNECTION_REAUTH_MAX_EMAILS = 2;

export const CONNECTION_REAUTH_REMINDER_MS = 24 * 60 * 60 * 1000;

const SLACK_DEAD_TOKEN_ERRORS = new Set([
  "invalid_auth",
  "token_revoked",
  "account_inactive",
  "token_expired"
]);

export function connectionReconnectPath(
  slug: string,
  connectionId: string
): string {
  return `/dashboard/integrations/${slug}?reconnect=${encodeURIComponent(connectionId)}`;
}

export function workspaceProviderLabel(providerConfigKey: string): ConnectionReauthProviderLabel {
  const k = providerConfigKey.toLowerCase();
  if (k.startsWith("google") || k === "gmail") return "Google";
  if (k.includes("outlook") || k.includes("microsoft") || k === "onedrive") {
    return "Microsoft 365";
  }
  return "Workspace";
}

export function workspaceIntegrationsSlug(providerConfigKey: string): string {
  const label = workspaceProviderLabel(providerConfigKey);
  if (label === "Microsoft 365") return "microsoft";
  if (label === "Google") return "google";
  return "workspace";
}

export function connectionPausedWork(provider: ConnectionReauthProviderLabel): string {
  switch (provider) {
    case "Google":
    case "Microsoft 365":
    case "Workspace":
      return "Mail and calendar for that account are paused";
    case "Zoom":
      return "Meetings and transcripts for that account are paused";
    case "Acuity":
    case "Vagaro":
      return "Calendar follow-ups and booking checks for that account are paused";
    case "CalDAV":
      return "Calendar booking checks for that account are paused";
    case "Facebook":
      return "Lead forms, Messenger, Instagram, and scheduled posts for that account are paused";
    case "Slack":
      return "Slack alerts for that workspace are paused";
    case "WhatsApp":
      return "WhatsApp messages for that account are paused";
  }
}

export function connectionAccountLabel(
  provider: ConnectionReauthProviderLabel,
  row: {
    account_name?: string | null;
    account_email?: string | null;
    page_name?: string | null;
    team_name?: string | null;
    username?: string | null;
    calendar_name?: string | null;
    display_phone_number?: string | null;
    user_id?: string | null;
    client_id?: string | null;
    metadata?: Record<string, unknown> | null;
    provider_config_key?: string | null;
  }
): string {
  const meta = row.metadata ?? {};
  const fromMeta = (key: string): string => {
    const v = meta[key];
    return typeof v === "string" ? v.trim() : "";
  };
  const name =
    row.account_name?.trim() ||
    row.page_name?.trim() ||
    row.team_name?.trim() ||
    row.calendar_name?.trim() ||
    fromMeta("provider_account_display_name") ||
    "";
  const email =
    row.account_email?.trim() ||
    fromMeta("provider_account_email") ||
    fromMeta("end_user_email") ||
    "";
  const other =
    row.display_phone_number?.trim() ||
    row.username?.trim() ||
    row.user_id?.trim() ||
    row.client_id?.trim() ||
    "";
  if (name) return name;
  if (email) return email;
  if (other) return other;
  return provider;
}

export function formatConnectionLastHealthy(
  iso: string | null | undefined,
  locale = "en-US"
): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleString(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

export type ConnectionReauthBannerInput = {
  provider: ConnectionReauthProviderLabel;
  accountLabel: string;
  lastHealthyLabel: string | null;
};

/** Persistent dashboard banner body. Honest, no "token rejected". */
export function connectionReauthBannerBody(input: ConnectionReauthBannerInput): string {
  const paused =
    `${input.accountLabel}'s ${input.provider} needs a reconnect. ` +
    connectionPausedWork(input.provider);
  if (input.lastHealthyLabel) {
    return `${paused}, last successful check: ${input.lastHealthyLabel}.`;
  }
  return `${paused}.`;
}

export function connectionPausedUntilCopy(provider: ConnectionReauthProviderLabel): string {
  return `Paused until ${provider} is reconnected.`;
}

export function isSlackTokenDead(error: string | null | undefined): boolean {
  return typeof error === "string" && SLACK_DEAD_TOKEN_ERRORS.has(error);
}

/**
 * True when a provider client threw a permanent credential rejection
 * (`auth_failed` on 4xx). A 5xx on the same error class is a retry, not a
 * reconnect banner.
 */
export function isPermanentConnectionAuthError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = "code" in err ? (err as { code?: unknown }).code : undefined;
  if (code !== "auth_failed") return false;
  const status = "status" in err ? (err as { status?: unknown }).status : undefined;
  if (typeof status === "number" && status >= 500) return false;
  return true;
}

export function clearedReauthFields(nowIso: string): {
  needs_reauth: false;
  reauth_email_count: 0;
  reauth_email_last_sent_at: null;
  last_healthy_at: string;
} {
  return {
    needs_reauth: false,
    reauth_email_count: 0,
    reauth_email_last_sent_at: null,
    last_healthy_at: nowIso
  };
}

export function withReauthColumnDefaults<T extends Record<string, unknown>>(row: T): T & {
  needs_reauth: boolean;
  last_healthy_at: string | null;
  reauth_email_count: number;
  reauth_email_last_sent_at: string | null;
} {
  return {
    ...row,
    needs_reauth: row.needs_reauth === true,
    last_healthy_at: typeof row.last_healthy_at === "string" ? row.last_healthy_at : null,
    reauth_email_count:
      typeof row.reauth_email_count === "number" && Number.isFinite(row.reauth_email_count)
        ? row.reauth_email_count
        : 0,
    reauth_email_last_sent_at:
      typeof row.reauth_email_last_sent_at === "string" ? row.reauth_email_last_sent_at : null
  };
}

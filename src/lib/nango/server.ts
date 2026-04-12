import { Nango, prodHost } from "@nangohq/node";

export function getNangoClient(): Nango {
  const secretKey = process.env.NANGO_SECRET_KEY;
  if (!secretKey) {
    throw new Error("NANGO_SECRET_KEY is not configured");
  }
  const host = (process.env.NANGO_HOST ?? prodHost).replace(/\/$/, "");
  return new Nango({ host, secretKey });
}

/** Nango connection payloads may use snake_case or camelCase depending on version. */
export function readConnectionEndUserId(connection: unknown): string | undefined {
  if (!connection || typeof connection !== "object") return undefined;
  const o = connection as Record<string, unknown>;
  const eu = o.end_user ?? o.endUser;
  if (!eu || typeof eu !== "object") return undefined;
  const id = (eu as Record<string, unknown>).id;
  return typeof id === "string" ? id : undefined;
}

/** Stored on `workspace_oauth_connections.metadata` after Connect UI completes. */
export function workspaceConnectionMetadataFromNangoConnection(
  connection: unknown
): Record<string, unknown> {
  const meta: Record<string, unknown> = { connected_via: "connect_ui" };
  if (!connection || typeof connection !== "object") return meta;
  const o = connection as Record<string, unknown>;
  const endUser = (o.end_user ?? o.endUser) as Record<string, unknown> | undefined;
  if (!endUser || typeof endUser !== "object") return meta;
  const email = endUser.email;
  const displayName = endUser.display_name ?? endUser.displayName;
  if (typeof email === "string" && email.trim().length > 0) {
    meta.end_user_email = email.trim();
  }
  if (typeof displayName === "string" && displayName.trim().length > 0) {
    meta.end_user_display_name = displayName.trim();
  }
  return meta;
}

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

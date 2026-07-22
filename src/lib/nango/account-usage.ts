/**
 * ACCOUNT-WIDE Nango connection usage. All tenants share one Nango account
 * (10 connections on the free plan; Starter is 20 then $1/connection), so
 * headroom is a platform concern, not a per-tenant one. Surfaced on
 * /admin/system and used for the deduped near-limit ops alert fired when a
 * new connection completes.
 */

import { getNangoClient } from "./server";

export const DEFAULT_NANGO_ACCOUNT_CONNECTION_LIMIT = 10;

/** Warn at >= 80% of the account limit. */
export const NANGO_ACCOUNT_ALERT_RATIO = 0.8;

export type NangoAccountUsage = {
  used: number;
  limit: number;
  nearLimit: boolean;
};

/** Plan limit for the platform's Nango account (env-tunable for upgrades). */
export function nangoAccountConnectionLimit(): number {
  const raw = process.env.NANGO_ACCOUNT_CONNECTION_LIMIT;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_NANGO_ACCOUNT_CONNECTION_LIMIT;
}

/**
 * Counts connections across the whole Nango account. Null when the count
 * could not be read (missing key / API error / unexpected shape) — callers
 * render "unavailable" or skip the alert; observability must never take a
 * page or a connect down.
 */
export async function getNangoAccountUsage(): Promise<NangoAccountUsage | null> {
  if (!process.env.NANGO_SECRET_KEY) return null;
  try {
    const nango = getNangoClient();
    const res = await nango.listConnections({ limit: 1000 });
    const connections = (res as { connections?: unknown[] } | null)?.connections;
    if (!Array.isArray(connections)) return null;
    const limit = nangoAccountConnectionLimit();
    const used = connections.length;
    return { used, limit, nearLimit: used >= Math.ceil(limit * NANGO_ACCOUNT_ALERT_RATIO) };
  } catch {
    return null;
  }
}

/**
 * Fires the near-limit ops email at most once per 24h (durable limiter key
 * `ops:nango-quota-alert`). Called after a NEW connection completes; never
 * throws — the alert must never fail the connect that triggered it.
 */
export async function maybeSendNangoQuotaAlert(): Promise<void> {
  try {
    const usage = await getNangoAccountUsage();
    if (!usage || !usage.nearLimit) return;
    const { rateLimitDurable } = await import("@/lib/rate-limit");
    const gate = await rateLimitDurable("ops:nango-quota-alert", {
      interval: 24 * 60 * 60 * 1000,
      maxRequests: 1
    });
    if (!gate.success) return;
    const { sendOpsNangoQuotaEmail } = await import("@/lib/email/ops-notify");
    await sendOpsNangoQuotaEmail({ used: usage.used, limit: usage.limit });
  } catch {
    // Best-effort by contract: a failed alert is strictly worse to surface
    // to the connecting owner than to drop (the /admin/system card still
    // shows the live count).
  }
}

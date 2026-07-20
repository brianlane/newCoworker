/**
 * Claude connector (MCP) per-user connection status
 * (`mcp_connector_status`).
 *
 * `recordMcpConnectorSeen` is called from /api/mcp after a bearer verifies —
 * the FIRST authenticated request is the truthful "connected" moment (the
 * documented failure mode has OAuth succeed while Anthropic's verification
 * POST 403s at the WAF, so a consent-time stamp would show Connected for a
 * connector that never worked). `last_seen_at` updates are debounced so
 * tool-call bursts cost one read, not a write per request.
 *
 * The dashboard integrations page reads the signed-in user's row to render
 * the "Connected — last used …" state on the Claude connector card.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/**
 * Unconditional-await client resolution — an inline `client ?? (await …)`
 * followed by branches makes v8 coverage mis-attribute the continuation
 * block (negative implicit-else counts).
 */
async function resolveClient(client?: SupabaseClient): Promise<SupabaseClient> {
  return client ?? (await createSupabaseServiceClient());
}

export type McpConnectorStatus = {
  firstConnectedAt: string;
  lastSeenAt: string;
};

/** How stale `last_seen_at` must be before a request refreshes it. */
export const MCP_SEEN_DEBOUNCE_MS = 5 * 60_000;

/** Postgres unique-violation SQLSTATE (concurrent first-request race). */
const PG_UNIQUE_VIOLATION = "23505";

/** The signed-in user's connector status; null = never connected. */
export async function getMcpConnectorStatus(
  userId: string,
  client?: SupabaseClient
): Promise<McpConnectorStatus | null> {
  const db = await resolveClient(client);
  const { data, error } = await db
    .from("mcp_connector_status")
    .select("first_connected_at, last_seen_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`getMcpConnectorStatus: ${error.message}`);
  const row = data as
    | { first_connected_at: string; last_seen_at: string }
    | null;
  if (!row) return null;
  return {
    firstConnectedAt: row.first_connected_at,
    lastSeenAt: row.last_seen_at
  };
}

/**
 * Stamp "an authenticated MCP request just happened" for this user. Inserts
 * the row on the first request; afterwards refreshes `last_seen_at` at most
 * once per debounce window. NEVER throws — status bookkeeping must not fail
 * a live tool call.
 */
export async function recordMcpConnectorSeen(
  userId: string,
  client?: SupabaseClient,
  nowMs: number = Date.now()
): Promise<void> {
  try {
    const db = await resolveClient(client);
    const { data, error } = await db
      .from("mcp_connector_status")
      .select("last_seen_at")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const row = data as { last_seen_at: string } | null;

    if (!row) {
      const nowIso = new Date(nowMs).toISOString();
      const { error: insErr } = await db.from("mcp_connector_status").insert({
        user_id: userId,
        first_connected_at: nowIso,
        last_seen_at: nowIso
      });
      // A concurrent first request won the insert — same outcome, no retry.
      if (insErr && insErr.code !== PG_UNIQUE_VIOLATION) {
        throw new Error(insErr.message);
      }
      return;
    }

    const lastSeenMs = Date.parse(row.last_seen_at);
    if (Number.isFinite(lastSeenMs) && nowMs - lastSeenMs < MCP_SEEN_DEBOUNCE_MS) {
      return; // fresh enough — reads stay the common case
    }
    const { error: updErr } = await db
      .from("mcp_connector_status")
      .update({ last_seen_at: new Date(nowMs).toISOString() })
      .eq("user_id", userId);
    if (updErr) throw new Error(updErr.message);
  } catch (err) {
    logger.warn("mcp connector-status: seen stamp failed", {
      userId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}
